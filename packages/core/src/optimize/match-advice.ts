import type { MatchFormat, ActionType } from '../match/format.js';
import type { LineupMap, PlayerMapPrediction, SimMap } from './simulate.js';
import { evaluateMaps, recommendAction, type ActionAdvice, type MapValue } from './advisor.js';
import { recommendLineups } from './lineup.js';

/**
 * Everything a match page's advice is made of, as one pure function of plain
 * data.
 *
 * Plain data on purpose: this is seconds of CPU, so it runs on a worker thread,
 * and what crosses to a thread has to survive being copied. That rules out the
 * fitted model (it is full of closures), so the caller flattens it into a table
 * of predictions first and this rebuilds `predict` as a lookup.
 */
export interface MatchAdviceInput {
  format: MatchFormat;
  /** Every map in the pool - what map values and pick/ban advice range over. */
  poolMaps: SimMap[];
  /** The maps being played, once picks exist. */
  playedMaps: SimMap[];
  ourRoster: string[];
  theirRoster: string[];
  /** playerId -> leaderboardId -> prediction, for everyone on either roster. */
  predictions: Record<string, Record<string, PlayerMapPrediction>>;
  /** The step on the clock, if pick/ban is still running. */
  pending: { type: ActionType; availableMapIds: string[] } | null;
  iterations: number;
  seed: number;
}

export interface LineupAdvice {
  lineups: LineupMap;
  winProbability: number;
  expectedMargin: number;
  conceded: string[];
}

export interface MatchAdviceResult {
  /** Every pool map scored from our point of view. */
  mapValues: MapValue[];
  /** Ranked advice for the action currently on the clock. */
  actionAdvice: ActionAdvice[];
  /** Recommended lineups, by objective. */
  lineups: { winProbability: LineupAdvice | null; expectedMargin: LineupAdvice | null };
  /** Why there is no lineup advice, when there is none. */
  lineupsInfeasible: string | null;
}

/** Used when a prediction is missing; should not happen, and must not throw mid-simulation. */
const UNKNOWN: PlayerMapPrediction = { acc: 0.9, sigmaLogit: 0.3, failProbability: 0 };

export function computeMatchAdvice(input: MatchAdviceInput): MatchAdviceResult {
  const { format, poolMaps, playedMaps, ourRoster, theirRoster } = input;
  const predict = (playerId: string, leaderboardId: string) =>
    input.predictions[playerId]?.[leaderboardId] ?? UNKNOWN;

  const setup = {
    maps: poolMaps,
    format,
    // A Set: a shared player is on both rosters but is one person with one run.
    playerIds: [...new Set([...ourRoster, ...theirRoster])],
    predict,
    iterations: input.iterations,
    seed: input.seed,
  };

  const k = format.playersPerMap;
  const mapValues =
    ourRoster.length >= k && theirRoster.length >= k
      ? evaluateMaps({ maps: poolMaps, format, ourRoster, theirRoster, setup })
      : [];

  const actionAdvice = input.pending
    ? recommendAction(input.pending.type, input.pending.availableMapIds, mapValues)
    : [];

  const lineups: MatchAdviceResult['lineups'] = { winProbability: null, expectedMargin: null };
  let lineupsInfeasible: string | null = null;

  // Lineup advice only once every map is known: appearance limits and the duo
  // rule are about the whole card, so advice for a half-picked one is either
  // wrong or "impossible".
  if (!input.pending && playedMaps.length > 0 && ourRoster.length >= k) {
    // The opponent's lineups are rarely known in advance, so assume they field
    // a reasonable spread rather than pretending we can see their card.
    const opponentLineups = assumeOpponentLineups(theirRoster, playedMaps, k);

    for (const objective of ['WIN_PROBABILITY', 'EXPECTED_MARGIN'] as const) {
      const result = recommendLineups(
        { ...setup, maps: playedMaps },
        { maps: playedMaps, format, roster: ourRoster, opponentLineups, objective },
      );
      if (result.best) {
        lineups[objective === 'WIN_PROBABILITY' ? 'winProbability' : 'expectedMargin'] = {
          lineups: result.best.lineups,
          winProbability: result.best.winProbability,
          expectedMargin: result.best.expectedMargin,
          conceded: result.best.concededMapIds,
        };
      } else if (result.infeasible) {
        lineupsInfeasible = result.infeasible;
      }
    }
  }

  return { mapValues, actionAdvice, lineups, lineupsInfeasible };
}

/** A plausible opponent card: rotate through their roster evenly. */
function assumeOpponentLineups(
  roster: readonly string[],
  maps: readonly SimMap[],
  playersPerMap: number,
): LineupMap {
  const lineups: Record<string, string[]> = {};
  if (roster.length < playersPerMap) return lineups;

  let cursor = 0;
  for (const map of maps) {
    const group: string[] = [];
    for (let i = 0; i < playersPerMap; i++) {
      group.push(roster[cursor % roster.length]!);
      cursor++;
    }
    lineups[map.id] = group;
  }
  return lineups;
}

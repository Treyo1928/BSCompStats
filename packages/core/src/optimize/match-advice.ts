import type { MatchFormat, ActionType } from '../match/format.js';
import { simulate, type LineupMap, type PlayerMapPrediction, type SimMap, type SimSetup } from './simulate.js';
import { evaluateMaps, recommendAction, type ActionAdvice, type MapValue } from './advisor.js';
import {
  concededFrom,
  drawTwoStage,
  recommendLineups,
  type LineupCandidate,
  type Objective,
  type TwoStageSamples,
} from './lineup.js';

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
  /**
   * What the opponent is assumed to field against this card - their own best
   * answer to it, not a guess. Shown so the card can be judged against
   * something real.
   */
  opponentLineups: LineupMap;
  /** How each map is expected to go with these two cards. */
  perMap: Record<string, { winProbability: number; expectedMargin: number }>;
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
  if (!input.pending && playedMaps.length > 0 && ourRoster.length >= k && theirRoster.length >= k) {
    const playedSetup = { ...setup, maps: playedMaps };
    // One draw for the whole alternation: every recommendation below is over
    // the same players and maps, and common random numbers are what make the
    // cards comparable in the first place.
    const samples = drawTwoStage(playedSetup);
    const recommend = (roster: readonly string[], opponentLineups: LineupMap, objective: Objective) =>
      recommendLineups(playedSetup, { maps: playedMaps, format, roster, opponentLineups, objective, samples });

    for (const objective of ['WIN_PROBABILITY', 'EXPECTED_MARGIN'] as const) {
      // The opponent has a captain too. Start them on a plain rotation, then
      // let each side answer the other's card a few times, so the card we end
      // on is our best answer to their best answer to it - and the win chance
      // is against a captain who is trying, not one who put their two weakest
      // together on the map where our two best were resting.
      //
      // The old assumption, that they rotate their roster evenly, made a team
      // of two stars and two passengers a 97% favourite: the passengers only
      // ever met the other side's passengers. They will not.
      let theirs = assumeOpponentLineups(theirRoster, playedMaps, k);
      const first = recommend(ourRoster, theirs, objective);
      if (!first.best) {
        if (first.infeasible) lineupsInfeasible = first.infeasible;
        continue;
      }
      let ours = first.best;
      // The card `ours` was scored against; it lags `theirs` by a step when
      // the loop stops on a failed reply.
      let scoredAgainst = theirs;
      for (let round = 0; round < BEST_RESPONSE_ROUNDS; round++) {
        const answer = recommend(theirRoster, ours.lineups, 'WIN_PROBABILITY');
        if (!answer.best) break;
        theirs = answer.best.lineups;
        const reply = recommend(ourRoster, theirs, objective);
        if (!reply.best) break;
        const settled = sameCard(reply.best.lineups, ours.lineups);
        ours = reply.best;
        scoredAgainst = theirs;
        if (settled) break;
      }

      lineups[objective === 'WIN_PROBABILITY' ? 'winProbability' : 'expectedMargin'] = toLineupAdvice(
        playedSetup,
        samples,
        ours,
        theirs,
        scoredAgainst,
      );
    }
  }

  return { mapValues, actionAdvice, lineups, lineupsInfeasible };
}

/** Rounds of "they answer our card, we answer theirs". Two is usually settled; more is slow for little. */
const BEST_RESPONSE_ROUNDS = 3;

const sameCard = (a: LineupMap, b: LineupMap): boolean =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([mapId, group]) => {
    const other = b[mapId];
    return other != null && [...group].sort().join() === [...other].sort().join();
  });

/**
 * A recommended card as the page shows it. The candidate's own figures were
 * scored against `scoredAgainst`; they are reused when that is what the
 * opponent ends up fielding, and the card is re-simulated on the same full
 * sample when it is not, so the numbers shown are always against `theirs`.
 */
function toLineupAdvice(
  setup: SimSetup,
  samples: TwoStageSamples,
  ours: LineupCandidate,
  theirs: LineupMap,
  scoredAgainst: LineupMap,
): LineupAdvice {
  const scored = sameCard(scoredAgainst, theirs) ? ours : simulate(samples.fine, ours.lineups, theirs, setup.format);
  return {
    lineups: ours.lineups,
    winProbability: scored.winProbability,
    expectedMargin: scored.expectedMargin,
    conceded: concededFrom(scored.perMap),
    opponentLineups: theirs,
    perMap: Object.fromEntries(
      Object.entries(scored.perMap).map(([id, v]) => [id, { winProbability: v.winProbability, expectedMargin: v.expectedMargin }]),
    ),
  };
}

/** Where the opponent starts before their captain has answered anything: an even rotation. */
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

export interface AnswerCardInput {
  format: MatchFormat;
  playedMaps: SimMap[];
  ourRoster: string[];
  theirRoster: string[];
  predictions: Record<string, Record<string, PlayerMapPrediction>>;
  /** What the other side is fielding, where it is known or guessed. Maps left out are inferred around these. */
  opponentLineups: LineupMap;
  iterations: number;
  seed: number;
}

export interface AnswerCardResult {
  winProbability: LineupAdvice | null;
  expectedMargin: LineupAdvice | null;
  infeasible: string | null;
  /** The maps the caller set; everything else in `opponentLineups` is inferred. */
  pinnedMapIds: string[];
}

/**
 * The best card against an opponent card the captain has reason to expect -
 * the other team's is already visible, or someone has a scouting report. Maps
 * they did not set are filled with what the other captain would likely do
 * given the ones they did, so a partial guess is still a whole card.
 */
export function answerOpponentCard(input: AnswerCardInput): AnswerCardResult {
  const { format, playedMaps, ourRoster, theirRoster } = input;
  const predict = (playerId: string, leaderboardId: string) =>
    input.predictions[playerId]?.[leaderboardId] ?? UNKNOWN;
  const setup = {
    maps: playedMaps,
    format,
    playerIds: [...new Set([...ourRoster, ...theirRoster])],
    predict,
    iterations: input.iterations,
    seed: input.seed,
  };
  const k = format.playersPerMap;

  // What the captain set is held fixed. The rest of their card is what their
  // captain would most likely do around it: their best answer to our best
  // answer, the same alternation the lineup panel settles on - not a rotation,
  // which is nobody's plan.
  const pinned: LineupMap = Object.fromEntries(
    Object.entries(input.opponentLineups).filter(([mapId, group]) => group.length === k && playedMaps.some((m) => m.id === mapId)),
  );
  const pinnedMapIds = Object.keys(pinned);
  const out: AnswerCardResult = { winProbability: null, expectedMargin: null, infeasible: null, pinnedMapIds };

  // A side that cannot fill a map has no card to answer or be answered with.
  // Saying so beats a 0% built from empty lineups.
  if (playedMaps.length === 0) {
    out.infeasible = 'No maps have been picked yet.';
    return out;
  }
  for (const [side, roster] of [['Your team', ourRoster], ['Their team', theirRoster]] as const) {
    if (roster.length < k) {
      out.infeasible = `${side} has ${roster.length} available player${roster.length === 1 ? '' : 's'}, but this format fields ${k} per map.`;
      return out;
    }
  }

  const samples = drawTwoStage(setup);
  const recommend = (roster: readonly string[], opponentLineups: LineupMap, objective: Objective, pins?: LineupMap) =>
    recommendLineups(setup, { maps: playedMaps, format, roster, opponentLineups, objective, pinned: pins, samples });

  const rotation = assumeOpponentLineups(theirRoster, playedMaps, k);
  let theirs: LineupMap = Object.fromEntries(playedMaps.map((map) => [map.id, pinned[map.id] ?? rotation[map.id]!]));
  if (pinnedMapIds.length < playedMaps.length) {
    let ours = recommend(ourRoster, theirs, 'WIN_PROBABILITY').best?.lineups;
    for (let round = 0; ours && round < BEST_RESPONSE_ROUNDS; round++) {
      const answer = recommend(theirRoster, ours, 'WIN_PROBABILITY', pinned);
      if (!answer.best) {
        // Nothing legal fits around what was set: the pins themselves are the
        // problem (a repeated duo, someone over their appearances), and a card
        // scored against a rotation would be an answer to a different question.
        out.infeasible = pinnedMapIds.length
          ? 'No legal card for their roster fits around the lineups given. Check the maps you set for a repeated pairing or a player used too often.'
          : (answer.infeasible ?? 'No legal card exists for their roster.');
        return out;
      }
      const settled = sameCard(answer.best.lineups, theirs);
      theirs = answer.best.lineups;
      if (settled) break;
      ours = recommend(ourRoster, theirs, 'WIN_PROBABILITY').best?.lineups;
    }
  }

  for (const objective of ['WIN_PROBABILITY', 'EXPECTED_MARGIN'] as const) {
    const rec = recommend(ourRoster, theirs, objective);
    if (!rec.best) {
      if (rec.infeasible) out.infeasible = rec.infeasible;
      continue;
    }
    out[objective === 'WIN_PROBABILITY' ? 'winProbability' : 'expectedMargin'] = toLineupAdvice(
      setup,
      samples,
      rec.best,
      theirs,
      theirs,
    );
  }
  return out;
}

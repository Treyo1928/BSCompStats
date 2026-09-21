import { fromLogit, toLogit } from '../stats/normalize.js';
import type { MatchFormat } from '../match/format.js';
import { mulberry32, normalSampler } from './random.js';

/**
 * Monte Carlo match simulation.
 *
 * Every map is sampled as: does this player throw the run away, and if not,
 * where in their distribution do they land. Team score on a map is the sum of its players'
 * scores, the higher total takes the map, and the match goes to whoever the
 * format says - most maps, or the largest aggregate.
 *
 * Scores are drawn once up front and reused across every candidate lineup
 * (common random numbers). That makes comparisons between lineups honest -
 * two lineups are judged against the same imagined nights, so a difference
 * between them is a real difference and not simulation noise - and it makes
 * evaluating thousands of candidates cheap, because each one is just a sum
 * over numbers that already exist.
 */

export interface PlayerMapPrediction {
  /** Expected accuracy, 0..1. */
  acc: number;
  /** Residual spread in logit units. */
  sigmaLogit: number;
  /** Probability of an abandoned or failed run. */
  failProbability: number;
}

export interface SimMap {
  /** Stable key - the match map id, or the pool map id when planning ahead. */
  id: string;
  leaderboardId: string;
  maxScore: number;
  isTiebreaker: boolean;
}

export interface SimSetup {
  maps: readonly SimMap[];
  format: MatchFormat;
  /** Everyone who might play, from both teams. */
  playerIds: readonly string[];
  predict: (playerId: string, leaderboardId: string) => PlayerMapPrediction;
  iterations?: number;
  seed?: number;
}

/**
 * Pre-drawn scores: samples[mapId][playerId] is an array of `iterations`
 * scores, in points.
 */
export interface ScoreSamples {
  iterations: number;
  maps: readonly SimMap[];
  byMapPlayer: Record<string, Record<string, Float64Array>>;
}

export function drawSamples(setup: SimSetup): ScoreSamples {
  const iterations = setup.iterations ?? 20_000;
  const random = mulberry32(setup.seed ?? 1337);
  const normal = normalSampler(random);

  const byMapPlayer: Record<string, Record<string, Float64Array>> = {};

  for (const map of setup.maps) {
    const perPlayer: Record<string, Float64Array> = {};

    for (const playerId of setup.playerIds) {
      const prediction = setup.predict(playerId, map.leaderboardId);
      const centre = toLogit(prediction.acc);
      const sigma = Math.max(prediction.sigmaLogit, 0.01);
      const failProbability = Math.min(0.95, Math.max(0, prediction.failProbability));

      const draws = new Float64Array(iterations);
      for (let i = 0; i < iterations; i++) {
        if (random() < failProbability) {
          // An abandoned or disastrous run is a different kind of event, not a
          // deep tail of the normal one. It lands at some fraction of what the
          // player would otherwise have scored - the one real example in the
          // MSU data is Alex at 20% where 96% was expected. Scaling by the
          // prediction keeps it a disaster for everybody: a flat 20-80% would
          // be an improvement for somebody expected to score 50%.
          draws[i] = map.maxScore * prediction.acc * (0.2 + random() * 0.6);
        } else {
          draws[i] = map.maxScore * fromLogit(centre + sigma * normal());
        }
      }
      perPlayer[playerId] = draws;
    }

    byMapPlayer[map.id] = perPlayer;
  }

  return { iterations, maps: setup.maps, byMapPlayer };
}

/** teamMapId -> the player ids fielded on it. */
export type LineupMap = Readonly<Record<string, readonly string[]>>;

export interface SimResult {
  /** Probability team A wins the match. */
  winProbability: number;
  drawProbability: number;
  /** Mean (teamA total - teamB total) across every map, in points. */
  expectedMargin: number;
  /** Mean maps won by team A. */
  expectedMapWins: number;
  /**
   * Per map: probability team A takes it, and the mean score difference.
   *
   * Both are conditioned on the map being played, which only matters for the
   * tiebreaker - it is reached only when the regular maps finish level, so
   * averaging it over every iteration would report a near-zero win rate for a
   * map the team is actually favoured on. `playProbability` says how often it
   * is reached at all.
   */
  perMap: Record<
    string,
    { winProbability: number; expectedMargin: number; playProbability: number }
  >;
}

export function simulate(
  samples: ScoreSamples,
  lineupsA: LineupMap,
  lineupsB: LineupMap,
  format: MatchFormat,
): SimResult {
  const { iterations } = samples;
  const playedMaps = samples.maps.filter(
    (m) => lineupsA[m.id]?.length && lineupsB[m.id]?.length,
  );

  const perMapWins: Record<string, number> = {};
  const perMapMargin: Record<string, number> = {};
  for (const map of playedMaps) {
    perMapWins[map.id] = 0;
    perMapMargin[map.id] = 0;
  }

  let matchWins = 0;
  let draws = 0;
  let totalMargin = 0;
  let totalMapWins = 0;
  let tiebreakerPlayed = 0;

  // Non-tiebreaker maps decide the match; the tiebreaker only comes in level.
  const regular = playedMaps.filter((m) => !m.isTiebreaker);
  const tiebreaker = playedMaps.find((m) => m.isTiebreaker) ?? null;

  for (let i = 0; i < iterations; i++) {
    let mapWinsA = 0;
    let mapWinsB = 0;
    let aggregate = 0;

    for (const map of regular) {
      const totalA = sumAt(samples, map.id, lineupsA[map.id]!, i);
      const totalB = sumAt(samples, map.id, lineupsB[map.id]!, i);
      const margin = totalA - totalB;

      aggregate += margin;
      perMapMargin[map.id]! += margin;
      if (margin > 0) {
        mapWinsA++;
        perMapWins[map.id]!++;
      } else if (margin < 0) {
        mapWinsB++;
      }
    }

    let won: boolean | null;
    if (format.winCondition === 'AGGREGATE_MARGIN') {
      won = aggregate === 0 ? null : aggregate > 0;
    } else {
      won = mapWinsA === mapWinsB ? null : mapWinsA > mapWinsB;
    }

    // Level on the regular maps: the tiebreaker settles it.
    if (won === null && tiebreaker) {
      const totalA = sumAt(samples, tiebreaker.id, lineupsA[tiebreaker.id]!, i);
      const totalB = sumAt(samples, tiebreaker.id, lineupsB[tiebreaker.id]!, i);
      const margin = totalA - totalB;
      tiebreakerPlayed++;
      perMapMargin[tiebreaker.id]! += margin;
      if (margin > 0) perMapWins[tiebreaker.id]!++;
      won = margin === 0 ? null : margin > 0;
    }

    if (won === true) matchWins++;
    else if (won === null) draws++;

    totalMargin += aggregate;
    totalMapWins += mapWinsA;
  }

  const perMap: SimResult['perMap'] = {};
  for (const map of playedMaps) {
    const played = map.isTiebreaker ? tiebreakerPlayed : iterations;
    perMap[map.id] = {
      winProbability: played ? perMapWins[map.id]! / played : 0,
      expectedMargin: played ? perMapMargin[map.id]! / played : 0,
      playProbability: played / iterations,
    };
  }

  return {
    winProbability: matchWins / iterations,
    drawProbability: draws / iterations,
    expectedMargin: totalMargin / iterations,
    expectedMapWins: totalMapWins / iterations,
    perMap,
  };
}

function sumAt(
  samples: ScoreSamples,
  mapId: string,
  playerIds: readonly string[],
  iteration: number,
): number {
  const perPlayer = samples.byMapPlayer[mapId];
  if (!perPlayer) return 0;
  let total = 0;
  for (const playerId of playerIds) {
    total += perPlayer[playerId]?.[iteration] ?? 0;
  }
  return total;
}

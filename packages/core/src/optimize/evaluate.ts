import type { MatchFormat } from '../match/format.js';
import type { LineupMap, ScoreSamples, SimMap, SimResult } from './simulate.js';

/**
 * Fast evaluation of many candidate lineups against a fixed opponent.
 *
 * The naive approach re-sums every player's sampled scores for every candidate,
 * which is where the time goes: hundreds of candidates x tens of thousands of
 * iterations x every player on every map. But candidates are combinations of
 * the *same* small set of per-map player groups - with a five-player roster and
 * duos there are only ten possible groups per map - so each group's margin
 * against the opponent can be computed once and reused.
 *
 * Evaluating a candidate then collapses to reading a handful of pre-computed
 * arrays. On the optimiser's own test case this is the difference between
 * fifteen seconds and well under a second, which is what makes it usable as
 * live advice during pick/ban rather than an overnight job.
 */

export interface ComboMargins {
  /** mapId -> comboKey -> per-iteration margin (ours minus theirs). */
  byMap: Map<string, Map<string, Float64Array>>;
  iterations: number;
  /**
   * Compute and cache a group's margin on demand. Enumeration knows every
   * candidate up front, but local search invents new ones as it goes, so it
   * needs to be able to ask for a group that was not pre-computed.
   */
  ensure(mapId: string, playerIds: readonly string[]): Float64Array | null;
}

export const comboKeyOf = (playerIds: readonly string[]): string =>
  [...playerIds].sort().join('|');

/**
 * Pre-compute the margin for every group of players that appears in any
 * candidate, on every map.
 */
export function precomputeMargins(
  samples: ScoreSamples,
  maps: readonly SimMap[],
  candidates: readonly LineupMap[],
  opponentLineups: LineupMap,
): ComboMargins {
  const { iterations } = samples;
  const byMap = new Map<string, Map<string, Float64Array>>();

  for (const map of maps) {
    const perPlayer = samples.byMapPlayer[map.id];
    const opponent = opponentLineups[map.id];
    if (!perPlayer || !opponent?.length) continue;

    // The opponent's total is the same for every candidate, so compute it once.
    const opponentTotal = new Float64Array(iterations);
    for (const playerId of opponent) {
      const draws = perPlayer[playerId];
      if (!draws) continue;
      for (let i = 0; i < iterations; i++) opponentTotal[i]! += draws[i]!;
    }

    const combos = new Map<string, Float64Array>();
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const group = candidate[map.id];
      if (!group?.length) continue;
      const key = comboKeyOf(group);
      if (seen.has(key)) continue;
      seen.add(key);

      const margin = new Float64Array(iterations);
      for (let i = 0; i < iterations; i++) margin[i] = -opponentTotal[i]!;
      for (const playerId of group) {
        const draws = perPlayer[playerId];
        if (!draws) continue;
        for (let i = 0; i < iterations; i++) margin[i]! += draws[i]!;
      }
      combos.set(key, margin);
    }

    byMap.set(map.id, combos);
  }

  return makeComboMargins(byMap, iterations, samples, maps, opponentLineups);
}

/**
 * A margin store that fills itself in as it is asked. Local search explores
 * groups nobody enumerated, and recomputing one is cheap next to re-running a
 * simulation, so they are computed once and kept.
 */
export function makeComboMargins(
  byMap: Map<string, Map<string, Float64Array>>,
  iterations: number,
  samples: ScoreSamples,
  maps: readonly SimMap[],
  opponentLineups: LineupMap,
): ComboMargins {
  const opponentTotals = new Map<string, Float64Array>();

  const opponentTotalFor = (mapId: string): Float64Array | null => {
    const cached = opponentTotals.get(mapId);
    if (cached) return cached;

    const perPlayer = samples.byMapPlayer[mapId];
    const opponent = opponentLineups[mapId];
    if (!perPlayer || !opponent?.length) return null;

    const total = new Float64Array(iterations);
    for (const playerId of opponent) {
      const draws = perPlayer[playerId];
      if (!draws) continue;
      for (let i = 0; i < iterations; i++) total[i]! += draws[i]!;
    }
    opponentTotals.set(mapId, total);
    return total;
  };

  void maps;

  return {
    byMap,
    iterations,
    ensure(mapId, playerIds) {
      let combos = byMap.get(mapId);
      if (!combos) {
        combos = new Map();
        byMap.set(mapId, combos);
      }
      const key = comboKeyOf(playerIds);
      const existing = combos.get(key);
      if (existing) return existing;

      const perPlayer = samples.byMapPlayer[mapId];
      const opponentTotal = opponentTotalFor(mapId);
      if (!perPlayer || !opponentTotal) return null;

      const margin = new Float64Array(iterations);
      for (let i = 0; i < iterations; i++) margin[i] = -opponentTotal[i]!;
      for (const playerId of playerIds) {
        const draws = perPlayer[playerId];
        if (!draws) continue;
        for (let i = 0; i < iterations; i++) margin[i]! += draws[i]!;
      }
      combos.set(key, margin);
      return margin;
    },
  };
}

export interface FastResult {
  winProbability: number;
  drawProbability: number;
  expectedMargin: number;
  expectedMapWins: number;
  perMap: SimResult['perMap'];
}

export function evaluateCandidate(
  precomputed: ComboMargins,
  maps: readonly SimMap[],
  lineups: LineupMap,
  format: MatchFormat,
): FastResult {
  const { iterations } = precomputed;

  const regular: Array<{ id: string; margin: Float64Array }> = [];
  let tiebreaker: { id: string; margin: Float64Array } | null = null;

  for (const map of maps) {
    const group = lineups[map.id];
    if (!group?.length) continue;
    const margin =
      precomputed.byMap.get(map.id)?.get(comboKeyOf(group)) ??
      precomputed.ensure(map.id, group);
    if (!margin) continue;
    if (map.isTiebreaker) tiebreaker = { id: map.id, margin };
    else regular.push({ id: map.id, margin });
  }

  const mapWins: Record<string, number> = {};
  const mapMargin: Record<string, number> = {};
  for (const m of regular) {
    mapWins[m.id] = 0;
    mapMargin[m.id] = 0;
  }
  if (tiebreaker) {
    mapWins[tiebreaker.id] = 0;
    mapMargin[tiebreaker.id] = 0;
  }

  let matchWins = 0;
  let draws = 0;
  let marginTotal = 0;
  let mapWinTotal = 0;
  let tiebreakerPlayed = 0;
  const aggregateCondition = format.winCondition === 'AGGREGATE_MARGIN';

  for (let i = 0; i < iterations; i++) {
    let winsA = 0;
    let winsB = 0;
    let aggregate = 0;

    for (const m of regular) {
      const margin = m.margin[i]!;
      aggregate += margin;
      mapMargin[m.id]! += margin;
      if (margin > 0) {
        winsA++;
        mapWins[m.id]!++;
      } else if (margin < 0) {
        winsB++;
      }
    }

    let won: boolean | null = aggregateCondition
      ? aggregate === 0
        ? null
        : aggregate > 0
      : winsA === winsB
        ? null
        : winsA > winsB;

    if (won === null && tiebreaker) {
      const margin = tiebreaker.margin[i]!;
      tiebreakerPlayed++;
      mapMargin[tiebreaker.id]! += margin;
      if (margin > 0) mapWins[tiebreaker.id]!++;
      won = margin === 0 ? null : margin > 0;
    }

    if (won === true) matchWins++;
    else if (won === null) draws++;

    marginTotal += aggregate;
    mapWinTotal += winsA;
  }

  const perMap: SimResult['perMap'] = {};
  for (const id of Object.keys(mapWins)) {
    // The tiebreaker is only reached when the regular maps finish level, so it
    // is scored over the iterations where it was actually played.
    const played = tiebreaker?.id === id ? tiebreakerPlayed : iterations;
    perMap[id] = {
      winProbability: played ? mapWins[id]! / played : 0,
      expectedMargin: played ? mapMargin[id]! / played : 0,
      playProbability: played / iterations,
    };
  }

  return {
    winProbability: matchWins / iterations,
    drawProbability: draws / iterations,
    expectedMargin: marginTotal / iterations,
    expectedMapWins: mapWinTotal / iterations,
    perMap,
  };
}

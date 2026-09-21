import type { MatchFormat } from '../match/format.js';
import type { ActionType } from '../match/format.js';
import { combinations } from './lineup.js';
import { drawSamples, type SimMap, type SimSetup } from './simulate.js';
import { comboKeyOf } from './evaluate.js';

/**
 * Pick and ban advice.
 *
 * Every map in the pool is scored by playing it out on its own: each side's
 * possible groups are crossed against the other's and the whole grid is
 * simulated, giving a per-map probability that we take it. With four players
 * fielding duos that is a six-by-six grid - small enough to solve exactly
 * rather than estimate.
 *
 * Three numbers come out of that grid, and they answer different questions:
 *
 *   expected  - averaged over every pairing. What happens if neither captain
 *               out-thinks the other. This is what ranking uses.
 *   bestCase  - our strongest group against their average. What the map is
 *               worth if we commit our best players to it.
 *   worstCase - our strongest against their strongest. Whether the map still
 *               holds up when they also try.
 *
 * A deliberate limit: this scores each map independently rather than searching
 * the whole pick/ban tree. A full search would have to re-optimise both
 * lineups at every node, and the cross-map duo constraint means an early pick
 * changes what is affordable later. That is real, and it is why the advice is
 * presented as a ranking with its reasoning rather than as an oracle.
 */

export interface MapValue {
  mapId: string;
  leaderboardId: string;
  /** Probability we take this map, averaged over every pairing. */
  expected: number;
  bestCase: number;
  worstCase: number;
  /** Mean score difference, ours minus theirs, over every pairing. */
  expectedMargin: number;
  /** Our strongest group here. */
  bestGroup: string[];
  /** Their strongest group here. */
  opponentBestGroup: string[];
}

export interface MapValueInput {
  maps: readonly SimMap[];
  format: MatchFormat;
  ourRoster: readonly string[];
  theirRoster: readonly string[];
  setup: SimSetup;
}

export function evaluateMaps(input: MapValueInput): MapValue[] {
  const samples = drawSamples(input.setup);
  const k = input.format.playersPerMap;

  const ourGroups = combinations([...input.ourRoster], k);
  const theirGroups = combinations([...input.theirRoster], k);
  if (!ourGroups.length || !theirGroups.length) return [];

  return input.maps.map((map) => {
    const perPlayer = samples.byMapPlayer[map.id] ?? {};
    const iterations = samples.iterations;

    // Each group's total on this map, computed once.
    const ourTotals = groupTotals(ourGroups, perPlayer, iterations);
    const theirTotals = groupTotals(theirGroups, perPlayer, iterations);

    let sumWin = 0;
    let sumMargin = 0;
    let pairs = 0;

    const ourGroupWin: number[] = new Array(ourGroups.length).fill(0);
    const theirGroupWin: number[] = new Array(theirGroups.length).fill(0);

    for (let a = 0; a < ourGroups.length; a++) {
      for (let b = 0; b < theirGroups.length; b++) {
        let wins = 0;
        let margin = 0;
        const ours = ourTotals[a]!;
        const theirs = theirTotals[b]!;
        for (let i = 0; i < iterations; i++) {
          const diff = ours[i]! - theirs[i]!;
          margin += diff;
          if (diff > 0) wins++;
        }
        const winProb = wins / iterations;
        sumWin += winProb;
        sumMargin += margin / iterations;
        pairs++;
        ourGroupWin[a]! += winProb;
        theirGroupWin[b]! += winProb;
      }
    }

    // Our best group is the one that wins most across their whole range;
    // theirs is the one that holds us down most.
    const bestOurIndex = argmax(ourGroupWin);
    const bestTheirIndex = argmin(theirGroupWin);

    const bestCase = ourGroupWin[bestOurIndex]! / theirGroups.length;
    const worstCase = pairWin(
      ourTotals[bestOurIndex]!,
      theirTotals[bestTheirIndex]!,
      iterations,
    );

    return {
      mapId: map.id,
      leaderboardId: map.leaderboardId,
      expected: pairs ? sumWin / pairs : 0,
      bestCase,
      worstCase,
      expectedMargin: pairs ? sumMargin / pairs : 0,
      bestGroup: ourGroups[bestOurIndex]!,
      opponentBestGroup: theirGroups[bestTheirIndex]!,
    };
  });
}

export interface ActionAdvice {
  mapId: string;
  leaderboardId: string;
  action: ActionType;
  /** Higher is a stronger recommendation. */
  score: number;
  value: MapValue;
  reason: string;
}

/**
 * Rank the available maps for the action currently on the clock.
 *
 * Picking and banning are not mirror images. A pick should take the map we are
 * most likely to win. A ban should remove the map we are least likely to win -
 * which is usually, but not always, the same as their best map, because a map
 * neither side is comfortable on is a coin flip rather than a threat.
 */
export function recommendAction(
  action: ActionType,
  availableMapIds: readonly string[],
  values: readonly MapValue[],
): ActionAdvice[] {
  const available = values.filter((v) => availableMapIds.includes(v.mapId));

  if (action === 'PICK') {
    return available
      .map((value) => ({
        mapId: value.mapId,
        leaderboardId: value.leaderboardId,
        action,
        score: value.expected,
        value,
        reason: describePick(value),
      }))
      .sort((a, b) => b.score - a.score);
  }

  // Ban what hurts us most: the lower our chance, the higher the ban value.
  const ranked = [...available].sort((a, b) => a.expected - b.expected);

  return ranked.map((value, index) => ({
    mapId: value.mapId,
    leaderboardId: value.leaderboardId,
    action,
    score: 1 - value.expected,
    value,
    reason: describeBan(value, index === 0),
  }));
}

function describePick(value: MapValue): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (value.expected >= 0.65) {
    return `Strong pick - about ${pct(value.expected)} to win it, ${pct(value.worstCase)} even if they send their best duo.`;
  }
  if (value.expected >= 0.5) {
    return `Slight edge at ${pct(value.expected)}, rising to ${pct(value.bestCase)} if you commit your best duo.`;
  }
  return `Against you at ${pct(value.expected)} - only worth taking if the rest of the pool is worse.`;
}

function describeBan(value: MapValue, isTopChoice: boolean): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (value.expected <= 0.35) {
    return `Their map - you are only ${pct(value.expected)} here. Removing it is worth more than anything else on the board.`;
  }
  if (value.expected <= 0.5) {
    return `Slightly against you at ${pct(value.expected)} - a sensible removal.`;
  }
  // A team favoured across the whole pool has no genuinely dangerous map to
  // remove. Saying "this ban gives away a map you would win" about the best
  // available ban is technically true and useless; say what is actually going on.
  if (isTopChoice) {
    return `You are favoured on every remaining map, so there is no dangerous ban. This is the one you are least comfortable on at ${pct(value.expected)}.`;
  }
  return `You are favoured here at ${pct(value.expected)} - banning it gives away a map you would probably win.`;
}

// ---------------------------------------------------------------------------

function groupTotals(
  groups: readonly string[][],
  perPlayer: Record<string, Float64Array>,
  iterations: number,
): Float64Array[] {
  return groups.map((group) => {
    const total = new Float64Array(iterations);
    for (const playerId of group) {
      const draws = perPlayer[playerId];
      if (!draws) continue;
      for (let i = 0; i < iterations; i++) total[i]! += draws[i]!;
    }
    return total;
  });
}

function pairWin(ours: Float64Array, theirs: Float64Array, iterations: number): number {
  let wins = 0;
  for (let i = 0; i < iterations; i++) if (ours[i]! > theirs[i]!) wins++;
  return wins / iterations;
}

const argmax = (values: readonly number[]): number =>
  values.reduce((best, v, i) => (v > values[best]! ? i : best), 0);

const argmin = (values: readonly number[]): number =>
  values.reduce((best, v, i) => (v < values[best]! ? i : best), 0);

export { comboKeyOf };

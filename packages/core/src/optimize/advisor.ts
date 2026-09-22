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
 *   bestCase  - the group we answer their best with, against their average.
 *               What the map is worth if we commit those players to it.
 *   bestVsBest - our answer to their strongest, against that strongest group.
 *               Whether the map still holds up when they also try.
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
  /**
   * Probability we take this map with each side fielding its strongest group
   * for it - what picks, bans and the headline figure go by. Midway between
   * "they commit first and we answer" (`bestVsBest`) and the reverse, since
   * lineups are set without seeing the other side's.
   *
   * `expected` was the headline once, and misled: it averages over every group
   * either roster could make, bench included, and nobody fields a random duo.
   * A side with two strong speed players and a weak bench read as likely to
   * lose its best map, because most of its possible duos contain the bench.
   * Averaging over each side's strongest few groups was tried instead and
   * fails the same way, more gently: where a side's strength is two players,
   * its second-best group is already mostly bench. A pairing can only be used
   * once in a match, so this is a little sharp when one duo is a side's best on
   * several maps - which maps get it is what the lineup advice works out once
   * the card is set.
   */
  likely: number;
  /** Probability we take this map, averaged over every pairing - how it leans before anyone chooses. */
  expected: number;
  /** The group we answer their best with (`bestGroup`), averaged over every group they could field. */
  bestCase: number;
  /**
   * Our strongest group against their strongest. Not a floor on `expected`:
   * that average includes our weaker groups too, so a team with one dominant
   * pairing can sit well above it here.
   */
  bestVsBest: number;
  /** Mean score difference, ours minus theirs, over every pairing. */
  expectedMargin: number;
  /** Our strongest group here. */
  bestGroup: string[];
  /** Their strongest group here. */
  opponentBestGroup: string[];
  /**
   * Every group we could field, so a caller can choose under constraints of its
   * own (each pairing used once, say) instead of taking `bestGroup` per map.
   */
  groups: Array<{
    playerIds: string[];
    /** Averaged over every group they could field. */
    average: number;
    /** Against `opponentBestGroup`. */
    vsTheirBest: number;
    /** Against each of `opponentGroups`, in that order. */
    vs: number[];
  }>;
  /** Every group they could field, with our win chance against it averaged over ours. */
  opponentGroups: Array<{ playerIds: string[]; average: number }>;
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
    const winRows: Float64Array[] = ourGroups.map(() => new Float64Array(theirGroups.length));

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
        winRows[a]![b] = winProb;
      }
    }

    // Best against best, as a captain means it: they field the group that is
    // hardest for us to answer, and we answer it with whoever does best against
    // *that group*. Choosing each side's "best" by its average over the other
    // side's whole range is the bench-averaging mistake again, one level down:
    // it preferred a safe pair that beats their bench every time to the pair
    // that actually beats their best, and called a map lost that was ours.
    let bestTheirIndex = 0;
    let bestOurIndex = 0;
    let minimax = Infinity;
    for (let b = 0; b < theirGroups.length; b++) {
      let answer = 0;
      let best = -1;
      for (let a = 0; a < ourGroups.length; a++) {
        if (winRows[a]![b]! > best) {
          best = winRows[a]![b]!;
          answer = a;
        }
      }
      if (best < minimax) {
        minimax = best;
        bestTheirIndex = b;
        bestOurIndex = answer;
      }
    }
    // The same question asked from their side: we commit first, they answer.
    let maximin = -Infinity;
    for (let a = 0; a < ourGroups.length; a++) {
      let worst = Infinity;
      for (let b = 0; b < theirGroups.length; b++) worst = Math.min(worst, winRows[a]![b]!);
      maximin = Math.max(maximin, worst);
    }

    const bestCase = ourGroupWin[bestOurIndex]! / theirGroups.length;
    const bestVsBest = minimax;
    // Lineups are set without seeing the other side's, so neither captain gets
    // the last word: the truth lies between "they commit first" and "we do".
    const likely = (minimax + maximin) / 2;

    return {
      mapId: map.id,
      leaderboardId: map.leaderboardId,
      likely,
      expected: pairs ? sumWin / pairs : 0,
      bestCase,
      bestVsBest,
      expectedMargin: pairs ? sumMargin / pairs : 0,
      bestGroup: ourGroups[bestOurIndex]!,
      opponentBestGroup: theirGroups[bestTheirIndex]!,
      groups: ourGroups.map((playerIds, a) => ({
        playerIds,
        average: ourGroupWin[a]! / theirGroups.length,
        vsTheirBest: winRows[a]![bestTheirIndex]!,
        vs: Array.from(winRows[a]!),
      })),
      opponentGroups: theirGroups.map((playerIds, b) => ({
        playerIds,
        average: theirGroupWin[b]! / ourGroups.length,
      })),
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
        score: value.likely,
        value,
        reason: describePick(value),
      }))
      .sort((a, b) => b.score - a.score);
  }

  // Ban what hurts us most: the lower our chance, the higher the ban value.
  const ranked = [...available].sort((a, b) => a.likely - b.likely);

  return ranked.map((value, index) => ({
    mapId: value.mapId,
    leaderboardId: value.leaderboardId,
    action,
    score: 1 - value.likely,
    value,
    reason: describeBan(value, index === 0),
  }));
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function describePick(value: MapValue): string {
  const detail = `${pct(value.expected)} averaged over every lineup anyone could field`;
  if (value.likely >= 0.65) return `Strong pick - about ${pct(value.likely)} with your best lineup against theirs (${detail}).`;
  if (value.likely >= 0.5) return `Slight edge - about ${pct(value.likely)} with your best lineup against theirs (${detail}).`;
  return `Against you at ${pct(value.likely)} with your best lineup against theirs - only worth taking if the rest of the pool is worse (${detail}).`;
}

function describeBan(value: MapValue, isTopChoice: boolean): string {
  if (value.likely <= 0.35) {
    return `Their map - you are only ${pct(value.likely)} here. Removing it is worth more than anything else on the board.`;
  }
  if (value.likely <= 0.5) {
    return `Slightly against you at ${pct(value.likely)} - a sensible removal.`;
  }
  // A team favoured across the whole pool has no genuinely dangerous map to
  // remove. Saying "this ban gives away a map you would win" about the best
  // available ban is technically true and useless; say what is actually going on.
  if (isTopChoice) {
    return `You are favoured on every remaining map, so there is no dangerous ban. This is the one you are least comfortable on at ${pct(value.likely)}.`;
  }
  return `You are favoured here at ${pct(value.likely)} - banning it gives away a map you would probably win.`;
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


export { comboKeyOf };

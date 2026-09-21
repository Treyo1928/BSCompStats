/**
 * Standings: who is better than whom, on the maps both have actually played.
 *
 * Ranking players by a fitted skill figure kept producing orders nobody could
 * check: the model forgives an outlier, shrinks a thin record toward the field,
 * and knows nothing about maps a player has avoided - so a player shown as 14
 * points behind their teammates could still be ranked above one shown as 7
 * ahead. A ranking people are asked to trust has to be the number they are
 * shown. So it is this, and nothing else:
 *
 *   for every other player, on every map both have a real score on,
 *   mine minus theirs - averaged.
 *
 * Like for like by construction: a map only one of them has played never
 * enters into it, in either direction. It can be taken over every map, or over
 * one kind of map, which is how "best on the team" becomes "best on Tech".
 */

export interface StandingScore {
  playerId: string;
  leaderboardId: string;
  /** 0..1 */
  acc: number;
  /** Abandoned or anomalous runs are not anyone's level, and are left out. */
  isDnf?: boolean;
}

export interface Comparison {
  /** Mean of (mine - theirs), 0..1 accuracy. Null when there is no map in common. */
  gap: number | null;
  /** How many (other player, map) pairs that is a mean of. */
  comparisons: number;
  /** How many of this player's maps had someone to compare with. */
  maps: number;
}

export type ScoreIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** player -> leaderboard -> accuracy, real runs only. */
export function indexScores(scores: readonly StandingScore[]): ScoreIndex {
  const index = new Map<string, Map<string, number>>();
  for (const s of scores) {
    if (s.isDnf) continue;
    const mine = index.get(s.playerId) ?? new Map<string, number>();
    mine.set(s.leaderboardId, s.acc);
    index.set(s.playerId, mine);
  }
  return index;
}

export function compareOnSharedMaps(
  index: ScoreIndex,
  playerId: string,
  others: Iterable<string>,
  /** Restrict to some maps - one kind, say. */
  include?: (leaderboardId: string) => boolean,
): Comparison {
  const mine = index.get(playerId);
  let sum = 0;
  let comparisons = 0;
  const maps = new Set<string>();

  if (mine) {
    for (const other of others) {
      if (other === playerId) continue;
      const theirs = index.get(other);
      if (!theirs) continue;
      for (const [leaderboardId, acc] of mine) {
        const against = theirs.get(leaderboardId);
        if (against == null || (include && !include(leaderboardId))) continue;
        sum += acc - against;
        comparisons++;
        maps.add(leaderboardId);
      }
    }
  }
  return { gap: comparisons ? sum / comparisons : null, comparisons, maps: maps.size };
}

/**
 * 1-based ranks by gap, best first. Someone with nothing to compare is not
 * ranked at all, rather than ranked last - "untested" and "worst" are different.
 */
export function rankByGap(gaps: ReadonlyMap<string, number | null>): Map<string, number | null> {
  const ranked = [...gaps.values()].filter((g): g is number => g != null);
  const out = new Map<string, number | null>();
  for (const [id, gap] of gaps) {
    out.set(id, gap == null ? null : 1 + ranked.filter((g) => g > gap).length);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Kinds of map
// ---------------------------------------------------------------------------

/** What an organiser can call a map. Free text is still allowed; these are the usual answers, in the order they are listed. */
export const MAP_KINDS = ['True Acc', 'Acc', 'Tech Acc', 'Tech', 'Speed Tech', 'Speed', 'Balanced'] as const;

/**
 * One spelling per kind of map.
 *
 * Kinds arrive from two places - an organiser's tag ("Tech") and the guess made
 * from BeatLeader's ratings ("tech", "speed-tech") - and a ranking "by Tech"
 * has to mean one set of maps wherever it is shown. So case, hyphens and
 * spacing are ignored, and there is deliberately no grouping beyond that: a
 * "Speed Tech" map is its own kind and counts toward neither Speed nor Tech.
 * Grouping was tried, and put a player first on Tech on one page and second on
 * another, because the pages disagreed about what Tech took in.
 */
export function canonicalKind(raw: string | null | undefined): string | null {
  const key = (raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!key) return null;
  return MAP_KINDS.find((k) => k.toLowerCase() === key) ?? key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The usual kinds in their usual order, then anything else alphabetically. */
export function sortKinds(kinds: Iterable<string>): string[] {
  const order = (k: string) => {
    const i = (MAP_KINDS as readonly string[]).indexOf(k);
    return i === -1 ? MAP_KINDS.length : i;
  };
  return [...new Set(kinds)].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

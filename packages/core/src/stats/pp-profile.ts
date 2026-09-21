/**
 * What kind of player someone is, read from where they earn their pp.
 *
 * Two other ways of answering this were tried and both were wrong in ways the
 * players could see at once:
 *
 *  - Accuracy against other players on shared maps. It answers "who is more
 *    accurate", and a more accurate player is more accurate on everything:
 *    Wynttter led corn on Speed maps 14 to 7, while corn - who plays almost
 *    nothing but speed - was called a Tech Acc player off three maps.
 *  - BeatLeader's three-cornered skill triangle, measured against players of
 *    the same pp. It called Fusion a Tech specialist who was worst on Speed.
 *    He earns 86% of his pp on Speed and Speed Tech maps.
 *
 * pp already folds together the two things "specialist" means - which maps
 * someone chooses to grind, and how well they do on them - and it needs no
 * overlap with anybody. So: split a player's ranked scores by kind of map,
 * weight them as BeatLeader does (the n-th best counts 0.965^n), and see where
 * the total comes from. Wynttter: Tech 49%. corn: Speed 49%. Fusion: Speed
 * Tech 68%. Nobody who knows them would argue.
 */

export interface PpScore {
  /** Kind of map, as everywhere else. Null is a ranked map with no kind, which cannot be placed. */
  kind: string | null;
  pp: number;
}

export interface PpProfile {
  /** Scores it rests on: ranked, unmodified, on a map with a kind. */
  scores: number;
  /** Share of their weighted pp that comes from each kind, 0..1, summing to 1. */
  share: Record<string, number>;
  /**
   * pp as it would stand if only that kind counted - each kind's scores
   * weighted among themselves. What players are ranked by within a kind:
   * how much someone has proved on Speed maps, whatever else they play.
   */
  byKind: Record<string, number>;
}

/** BeatLeader's weighting of a player's scores, best first. */
const DECAY = 0.965;
/** Fewer than this and a profile is a handful of scores, not a shape. */
export const MIN_PP_SCORES = 20;

export function buildPpProfile(scores: readonly PpScore[]): PpProfile | null {
  const placed = scores.filter((s): s is { kind: string; pp: number } => s.kind != null && s.pp > 0);
  if (placed.length < MIN_PP_SCORES) return null;

  const share: Record<string, number> = {};
  [...placed]
    .sort((a, b) => b.pp - a.pp)
    .forEach((s, i) => (share[s.kind] = (share[s.kind] ?? 0) + s.pp * DECAY ** i));
  const total = Object.values(share).reduce((a, b) => a + b, 0);
  for (const kind of Object.keys(share)) share[kind] = share[kind]! / total;

  return { scores: placed.length, share, byKind: kindPp(scores) };
}

/** pp within each kind alone. Defined for anyone with a ranked score, however few - it is a total, not a shape. */
export function kindPp(scores: readonly PpScore[]): Record<string, number> {
  const byKind = new Map<string, number[]>();
  for (const s of scores) {
    if (s.kind == null || !(s.pp > 0)) continue;
    byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s.pp]);
  }
  return Object.fromEntries(
    [...byKind].map(([kind, pps]) => [
      kind,
      pps.sort((a, b) => b - a).reduce((sum, pp, i) => sum + pp * DECAY ** i, 0),
    ]),
  );
}

/** The average profile of a group: what share of pp each kind usually accounts for among them. */
export function meanShare(profiles: readonly PpProfile[]): Record<string, number> {
  const kinds = new Set(profiles.flatMap((p) => Object.keys(p.share)));
  return Object.fromEntries(
    [...kinds].map((kind) => [kind, profiles.reduce((sum, p) => sum + (p.share[kind] ?? 0), 0) / (profiles.length || 1)]),
  );
}

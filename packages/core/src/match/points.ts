import { z } from 'zod';

/**
 * Match points: Wynttter's curve for matches where strong players duo with
 * newer ones. (A working name - "skill points" in the original sheet.)
 *
 * Averaging two accuracies treats every point of accuracy the same, so a
 * strong player's 98% carries a partner's 80% past a pair on 90% each. The
 * curve makes accuracy near the top worth more, so each player's score is
 * turned into points first and the points are averaged - curve before
 * averaging, never after:
 *
 *   raw(acc)    = 1 / ((1 + padding) - acc) + slope * acc
 *   points(acc) = perfectPoints * raw(acc) / raw(perfectAcc)
 *
 * The first term climbs steeply towards 100% (padding keeps it finite and
 * decides how steep); the second keeps lower accuracies from flattening out
 * entirely. `perfectAcc` is what a "perfect" score on the map is - set per
 * map by the organisers - and a score there is worth `perfectPoints`.
 *
 * The perfect accuracy only scales a map's points. Both teams on a map share
 * it, so it never decides who wins the map; it is there so that the number a
 * player sees means the same thing from map to map.
 */

export const pointsCurveSchema = z.object({
  /** How far past 100% the curve's pole sits. Smaller is steeper near the top. */
  padding: z.number().positive().max(1).default(0.03),
  /** How much the curve still climbs at lower accuracies. */
  slope: z.number().nonnegative().max(10_000).default(80),
  /** What a score at the map's perfect accuracy is worth. */
  perfectPoints: z.number().positive().max(1_000_000).default(100),
});
export type PointsCurve = z.infer<typeof pointsCurveSchema>;

export const DEFAULT_POINTS_CURVE: PointsCurve = pointsCurveSchema.parse({});

export function parsePointsCurve(raw: unknown): PointsCurve {
  const parsed = pointsCurveSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_POINTS_CURVE;
}

/** The curve before it is scaled to a map. Rises with accuracy all the way to 100%. */
export function rawCurve(acc: number, curve: Pick<PointsCurve, 'padding' | 'slope'>): number {
  const a = Math.min(1, Math.max(0, acc));
  return 1 / (1 + curve.padding - a) + curve.slope * a;
}

/** What makes this map's perfect accuracy worth `perfectPoints`. */
export function mapScale(perfectAcc: number, curve: PointsCurve): number {
  return curve.perfectPoints / rawCurve(perfectAcc, curve);
}

/** Match points for an accuracy (0..1) on a map with this perfect accuracy. */
export function matchPoints(acc: number, perfectAcc: number, curve: PointsCurve): number {
  return mapScale(perfectAcc, curve) * rawCurve(acc, curve);
}

/**
 * The curve run backwards: the accuracy whose raw curve value is `raw`.
 * Null when not even 100% reaches it; 0 when it is below what 0% gives.
 */
export function accuracyForRaw(raw: number, curve: Pick<PointsCurve, 'padding' | 'slope'>): number | null {
  if (!Number.isFinite(raw)) return null;
  if (raw <= rawCurve(0, curve)) return 0;
  if (raw > rawCurve(1, curve) * (1 + 1e-12)) return null;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (rawCurve(mid, curve) < raw) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The accuracy that earns these points on this map. Null past what 100% earns. */
export function accuracyForPoints(points: number, perfectAcc: number, curve: PointsCurve): number | null {
  return accuracyForRaw(points / mapScale(perfectAcc, curve), curve);
}

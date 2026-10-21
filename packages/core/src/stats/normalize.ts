/**
 * Turning raw scores into something comparable across maps.
 *
 * Accuracy is score / maxScore - the same percentage the spreadsheets compute,
 * except maxScore comes from BeatLeader rather than a hand-maintained SONGINFO
 * row. Crucially this works for unranked maps, which is what tournament pools
 * almost always are.
 */

export interface RawScore {
  playerId: string;
  leaderboardId: string;
  baseScore: number;
  /** BeatLeader's own accuracy, 0..1. Preferred when present. */
  accuracy?: number;
  missedNotes?: number;
  badCuts?: number;
  fullCombo?: boolean;
  modifiers?: string;
}

export interface NormalizedScore {
  playerId: string;
  leaderboardId: string;
  /** 0..1 */
  acc: number;
  baseScore: number;
}

/**
 * Modifiers that change the score enough that the run is not comparable with a
 * clean one. Anything here disqualifies a score from the skill model, though it
 * is still shown in the UI.
 */
/**
 * Modifiers that make a score something other than a normal run of the map.
 * No Fail is not one: matches are always played with it on, it changes
 * nothing unless the player dies, and a run where it did kick in is still the
 * player's real result - it is marked, not dropped.
 */
const SCORE_ALTERING_MODIFIERS = new Set([
  'SS', // Slower Song
  'EZ', // Easy mode
  'NO', // No Obstacles
  'NB', // No Bombs
  'NA', // No Arrows
  'SC', // Small Cubes... scoring differs
  'PM', // Pro Mode
]);

export function parseModifiers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
}

/** No Fail kicked in: the player died, and played the rest of the map on. */
export function noFailTriggered(raw: string | undefined): boolean {
  return parseModifiers(raw).includes('NF');
}

export function hasScoreAlteringModifier(raw: string | undefined): boolean {
  return parseModifiers(raw).some((m) => SCORE_ALTERING_MODIFIERS.has(m));
}

export function computeAcc(score: RawScore, maxScore: number): number | null {
  // Prefer BeatLeader's own figure; it accounts for modifier multipliers.
  if (typeof score.accuracy === 'number' && score.accuracy > 0) {
    return clamp01(score.accuracy);
  }
  if (!maxScore || maxScore <= 0) return null;
  return clamp01(score.baseScore / maxScore);
}

export interface NormalizeInput {
  scores: readonly RawScore[];
  /** leaderboardId -> maxScore */
  maxScores: Readonly<Record<string, number>>;
}

export function normalizeScores(input: NormalizeInput): NormalizedScore[] {
  const out: NormalizedScore[] = [];

  for (const score of input.scores) {
    if (hasScoreAlteringModifier(score.modifiers)) continue;
    const acc = computeAcc(score, input.maxScores[score.leaderboardId] ?? 0);
    if (acc == null) continue;
    out.push({
      playerId: score.playerId,
      leaderboardId: score.leaderboardId,
      acc,
      baseScore: score.baseScore,
    });
  }

  // Every score counts as set, however low: a bad run is a real score.
  return out;
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median absolute deviation, scaled to be comparable with a std deviation. */
export function mad(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

export function mean(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Accuracy lives in a narrow band near the top (0.90-0.99), where a raw
 * additive model wastes most of its range and can predict above 100%. Working
 * in logit space fixes both: differences near the ceiling get the weight they
 * deserve, and the inverse can never leave (0,1).
 */
export function toLogit(acc: number): number {
  const a = Math.min(1 - 1e-6, Math.max(1e-6, acc));
  return Math.log(a / (1 - a));
}

export function fromLogit(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

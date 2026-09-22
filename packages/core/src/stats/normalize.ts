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
  /**
   * An anomaly - an abandoned run or a disaster that does not represent the
   * player. A low score on a map that is simply beyond them is NOT one.
   */
  isDnf: boolean;
}

/**
 * Modifiers that change the score enough that the run is not comparable with a
 * clean one. Anything here disqualifies a score from the skill model, though it
 * is still shown in the UI.
 */
const SCORE_ALTERING_MODIFIERS = new Set([
  'NF', // No Fail - the score is real but the run was a survival
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

/**
 * Whether a score is an anomaly - an abandoned run, a disaster, something that
 * does not represent what the player can do on that map.
 *
 * The MSU board has two kinds of terrible score on it, and they need opposite
 * treatment:
 *
 *  - Alex, 20.36% on Madeleine. Everyone else on that map is between 96% and
 *    98%. That is an abandoned run, and letting it stand would predict 20% for
 *    him on the easiest map in the pool.
 *  - Kadence 50.45% and Wyatt 51.53% on Spin Eternally. They did fail the map,
 *    but it is a map they cannot beat: the field there runs from 50% to 92%.
 *    Those scores are their real ability on it and must be treated as such. A
 *    captain asking "can Kadence play Spin?" needs the answer 50%, not 88%.
 *
 * A player's own history cannot tell these apart - both are far below the
 * player's norm. The map's column can. So a score is an anomaly only when both
 * hold:
 *
 *  1. it is far below what this player normally does, and
 *  2. it is an extreme low outlier among everyone else's scores on that map,
 *     measured in robust deviations of the rest of the column (logit space).
 *
 * Alex sits 15 deviations below his column; Kadence and Wyatt about 2. The
 * first test is what protects a genuinely weaker player: Kaiden's 89.83% on
 * Sentiment is nearly 6 deviations below a very tight column, and is simply
 * what Kaiden scores.
 *
 * "Far below" means far. The floor used to be 85% of the player's median,
 * and on the fall 2026 board that wrote off PretzelBread's 74.5% on Hush and
 * 70.4% on Pedi (median 89%) as abandoned when they are simply what he gets
 * on those maps - the kind of score that is a very real possibility in a
 * match and had never been predicted. An abandoned run is dramatic: zolism's
 * 0.08% on Pedi and 0.01% on buggin', Alex's 20% on Madeleine. So the floor
 * is 60%, and below `outrightFloor` (35% of the player's median) a run is an
 * anomaly whatever the column says - nobody's real level is a third of their
 * normal, and a 0.01% on a map two people have played would otherwise stand
 * for want of a column to judge it by.
 *
 * With fewer than `minColumnOthers` other scores there is no column to judge
 * against, and a score above the outright floor is taken at face value. A
 * bad score is a real score until there is evidence otherwise; the model's
 * robust fitting still stops it bending anyone else's numbers in the meantime.
 */
export interface DnfOptions {
  /** Fraction of the player's own median accuracy below which a run is suspect. */
  relativeFloor?: number;
  /** Fraction of the player's own median below which a run is an anomaly outright, column or no column. */
  outrightFloor?: number;
  /** Robust deviations below the rest of the map's column before it is an anomaly. */
  columnDeviations?: number;
  /** Other players' scores needed on the map before the column can be judged. */
  minColumnOthers?: number;
  /** Smallest column spread believed, in logit units. Guards tiny columns that agree by chance. */
  columnSpreadFloor?: number;
}

const DNF_DEFAULTS: Required<DnfOptions> = {
  relativeFloor: 0.6,
  outrightFloor: 0.35,
  columnDeviations: 4,
  minColumnOthers: 3,
  columnSpreadFloor: 0.1,
};

/** How many robust deviations `acc` sits below the other scores on its map. */
export function columnDeviationsBelow(
  acc: number,
  otherAccsOnMap: readonly number[],
  spreadFloor: number = DNF_DEFAULTS.columnSpreadFloor,
): number {
  const others = otherAccsOnMap.map(toLogit);
  return (median(others) - toLogit(acc)) / Math.max(mad(others), spreadFloor);
}

export function detectDnf(
  acc: number,
  playerMedianAcc: number | null,
  /** Everyone else's accuracy on the same map - not including this score. */
  otherAccsOnMap: readonly number[],
  options: DnfOptions = {},
): boolean {
  const opts = { ...DNF_DEFAULTS, ...options };

  if (playerMedianAcc == null || playerMedianAcc <= 0) return false;
  if (acc < playerMedianAcc * opts.outrightFloor) return true;
  if (acc >= playerMedianAcc * opts.relativeFloor) return false;
  if (otherAccsOnMap.length < opts.minColumnOthers) return false;

  return (
    columnDeviationsBelow(acc, otherAccsOnMap, opts.columnSpreadFloor) > opts.columnDeviations
  );
}

/**
 * Classify a whole set of scores at once. Returns one flag per input score, in
 * order. This is the only place the rule is applied - the model, the board and
 * the fail model all read the flags it produces.
 */
export function classifyFails(
  scores: ReadonlyArray<{ playerId: string; leaderboardId: string; acc: number }>,
  options: DnfOptions = {},
): boolean[] {
  const byPlayer = new Map<string, number[]>();
  const byMap = new Map<string, number[]>();
  scores.forEach((s, i) => {
    (byPlayer.get(s.playerId) ?? byPlayer.set(s.playerId, []).get(s.playerId)!).push(s.acc);
    (byMap.get(s.leaderboardId) ?? byMap.set(s.leaderboardId, []).get(s.leaderboardId)!).push(i);
  });

  // A player's own median is the yardstick for "unusually bad for them".
  const medians = new Map<string, number>();
  for (const [playerId, accs] of byPlayer) medians.set(playerId, median(accs));

  return scores.map((s, i) => {
    const others = byMap
      .get(s.leaderboardId)!
      .filter((j) => j !== i && scores[j]!.playerId !== s.playerId)
      .map((j) => scores[j]!.acc);
    return detectDnf(s.acc, medians.get(s.playerId) ?? null, others, options);
  });
}

export interface NormalizeInput {
  scores: readonly RawScore[];
  /** leaderboardId -> maxScore */
  maxScores: Readonly<Record<string, number>>;
  dnf?: DnfOptions;
}

export function normalizeScores(input: NormalizeInput): NormalizedScore[] {
  const withAcc: Array<Omit<NormalizedScore, 'isDnf'>> = [];

  for (const score of input.scores) {
    if (hasScoreAlteringModifier(score.modifiers)) continue;
    const acc = computeAcc(score, input.maxScores[score.leaderboardId] ?? 0);
    if (acc == null) continue;
    withAcc.push({
      playerId: score.playerId,
      leaderboardId: score.leaderboardId,
      acc,
      baseScore: score.baseScore,
    });
  }

  const flags = classifyFails(withAcc, input.dnf);
  return withAcc.map((s, i) => ({ ...s, isDnf: flags[i]! }));
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

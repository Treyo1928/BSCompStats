import { fitSkillModel, type FitOptions, type Observation, type SkillModel } from './model.js';
import { mean, median } from './normalize.js';

/**
 * Cross-validation for the skill model.
 *
 * The point is not ceremony: on the MSU pool, adding a latent factor improves
 * training fit and makes real predictions worse. Held-out error is the only
 * number that tells you that, so model selection runs on it rather than on a
 * hand-picked setting. With a season of BeatLeader history behind each player
 * the answer may flip, and this will notice.
 */

export interface CvResult {
  options: FitOptions;
  /**
   * Mean absolute error in accuracy points (0-100). Model selection uses this.
   * It is dominated by the handful of scores nobody could have predicted - a
   * 50% on Spin Eternally from a 96% player costs 35 points on its own.
   */
  maeAccPoints: number;
  /** Median absolute error - what a typical held-out prediction is off by. */
  medianErrorAccPoints: number;
  /** Held-out predictions actually scored. */
  samples: number;
}

export interface CvOptions {
  folds?: number;
  /** Candidate settings to compare. Defaults to a small sensible grid. */
  grid?: FitOptions[];
  seed?: number;
}

const DEFAULT_GRID: FitOptions[] = [
  { latentFactors: 0, biasRegularization: 0.25 },
  { latentFactors: 0, biasRegularization: 0.5 },
  { latentFactors: 0, biasRegularization: 1 },
  { latentFactors: 1, biasRegularization: 0.5, factorRegularization: 0.3 },
  { latentFactors: 1, biasRegularization: 1, factorRegularization: 0.3 },
  { latentFactors: 2, biasRegularization: 0.5, factorRegularization: 0.3 },
];

/** Deterministic shuffle, so a recommendation is reproducible. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let h = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1103515245) + 12345) & 0x7fffffff;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function crossValidate(
  observations: readonly Observation[],
  options: FitOptions,
  cv: CvOptions = {},
): CvResult {
  const folds = cv.folds ?? 5;
  const clean = observations.filter((o) => !o.isDnf);
  if (clean.length < folds * 2) {
    return {
      options,
      maeAccPoints: Number.POSITIVE_INFINITY,
      medianErrorAccPoints: Number.POSITIVE_INFINITY,
      samples: 0,
    };
  }

  const indexed = observations.map((o, i) => ({ o, i }));
  const testable = shuffled(
    indexed.filter((x) => !x.o.isDnf),
    cv.seed ?? 42,
  );

  const errors: number[] = [];

  for (let fold = 0; fold < folds; fold++) {
    const holdOut = new Set(
      testable.filter((_, i) => i % folds === fold).map((x) => x.i),
    );
    if (!holdOut.size) continue;

    const train = observations.filter((_, i) => !holdOut.has(i));

    // A player or map that only appears in the held-out fold cannot be
    // predicted at all; scoring it would measure sparsity, not the model.
    const players = new Set(train.map((o) => o.playerId));
    const maps = new Set(train.map((o) => o.leaderboardId));

    const model = fitSkillModel(train, options);

    for (const i of holdOut) {
      const o = observations[i]!;
      if (!players.has(o.playerId) || !maps.has(o.leaderboardId)) continue;
      errors.push(Math.abs(model.predict(o.playerId, o.leaderboardId).acc - o.acc) * 100);
    }
  }

  return {
    options,
    maeAccPoints: errors.length ? mean(errors) : Number.POSITIVE_INFINITY,
    medianErrorAccPoints: errors.length ? median(errors) : Number.POSITIVE_INFINITY,
    samples: errors.length,
  };
}

export interface BestModelResult {
  model: SkillModel;
  chosen: FitOptions;
  /** Every candidate's held-out error, best first - shown in the UI as "why". */
  comparison: CvResult[];
}

/**
 * Fit the model, choosing its complexity by held-out error rather than by
 * assumption. Falls back to the plain additive model when there is too little
 * data to cross-validate meaningfully.
 */
export function fitBestModel(
  observations: readonly Observation[],
  cv: CvOptions = {},
): BestModelResult {
  const { chosen, comparison } = chooseFitOptions(observations, cv);
  return { model: fitSkillModel(observations, chosen), chosen, comparison };
}

/**
 * The expensive half of `fitBestModel`: which model complexity wins on held-out
 * error. It is a whole grid of fits over many folds, against one fit to build
 * the model it picks - so it is split out to be run somewhere other than the
 * thread that serves requests. Its result is plain data.
 */
export function chooseFitOptions(
  observations: readonly Observation[],
  cv: CvOptions = {},
): { chosen: FitOptions; comparison: CvResult[] } {
  const grid = cv.grid ?? DEFAULT_GRID;
  const clean = observations.filter((o) => !o.isDnf);

  if (clean.length < 20) {
    return { chosen: { latentFactors: 0, biasRegularization: 1 }, comparison: [] };
  }

  const comparison = grid
    .map((options) => crossValidate(observations, options, cv))
    .sort((a, b) => a.maeAccPoints - b.maeAccPoints);

  const best = comparison[0]!;
  const chosen = Number.isFinite(best.maeAccPoints)
    ? best.options
    : { latentFactors: 0, biasRegularization: 1 };

  return { chosen, comparison };
}

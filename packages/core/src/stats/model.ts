import { fromLogit, mad, median, toLogit } from './normalize.js';

/**
 * The skill model.
 *
 * The original plan was to regress each player against BeatLeader's per-map
 * acc/pass/tech rating vector. That turns out not to work for this use case:
 * tournament pools are overwhelmingly *unranked* maps, and BeatLeader only
 * publishes ratings for ranked ones. Of the seven maps in the MSU pool exactly
 * one is ranked - the rest return null for stars, accRating, passRating and
 * techRating. A model built on those features would have no features at all.
 *
 * So the model learns from the score matrix itself:
 *
 *   logit(acc[p][m]) ~= mu + playerSkill[p] + mapEasiness[m] + U[p].V[m]
 *
 * The additive part is the familiar "this player is strong / this map is hard"
 * split. The low-rank U.V term is what makes it interesting: it discovers, from
 * the data, the axes along which players and maps disagree - which is exactly
 * what the spreadsheet's hand-written "Acc / Tech / Speed" column labels were
 * approximating. Nobody has to tag anything for it to work, and it works on
 * unranked maps.
 *
 * Four details that matter in practice:
 *
 *  - Everything is fitted in logit space. Accuracy clusters in 0.90-0.99, where
 *    an additive model on raw values wastes its range and can predict over 100%.
 *  - Fitting is iteratively reweighted (Huber), and each map carries its own
 *    residual scale. Kadence and Wyatt really did score 50% on Spin Eternally;
 *    those are their scores, not noise. But a map that scatters the field over
 *    forty points says less about general skill than one that holds it within
 *    two, so its scores pull on a player's profile proportionally less.
 *  - Where a player has actually played a map, the prediction is anchored to
 *    what they scored. No model form tried here predicts a 50% from a player's
 *    96s elsewhere (see the README), and it does not have to: the score exists.
 *  - Every term is ridge-shrunk toward zero, so a player with two scores is
 *    pulled toward the field average instead of being declared a god or a
 *    disaster on a sample of two.
 */

export interface Observation {
  playerId: string;
  leaderboardId: string;
  /** 0..1 */
  acc: number;
  /** Flagged anomaly (abandoned run, disaster); heavily down-weighted and never anchors. */
  isDnf?: boolean;
  /**
   * Prior weight in (0,1], normally recency from the stats scope. Combines
   * with the fail down-weighting and the Huber weights rather than replacing
   * them, so an old score counts less without being silently discarded.
   */
  weight?: number;
}

export interface FitOptions {
  /** Latent dimensions. 1 captures the main "style" axis; 2 adds a second. */
  latentFactors?: number;
  /** Ridge strength for the additive biases. */
  biasRegularization?: number;
  /**
   * Ridge strength for the latent factors. Higher than the bias ridge, because
   * a factor is fitted from one player's residuals alone and the ridge is all
   * that keeps a thin, one-sided sample from becoming a strong opinion about
   * maps they have never played (see `fitSkillModel`).
   */
  factorRegularization?: number;
  /** Cap on alternating sweeps; the fit stops earlier once `tolerance` is met. */
  iterations?: number;
  /**
   * Largest change in any parameter (logit units) at which a sweep counts as
   * converged. 1e-4 logit is a hundredth of an accuracy point. Tighter buys
   * nothing: the Huber reweighting leaves the fit cycling by about that much.
   */
  tolerance?: number;
  /** Huber cutoff in logit units. Residuals beyond this are down-weighted. */
  huberDelta?: number;
  /** Initial weight given to a run flagged as an anomaly (abandoned, disaster). */
  dnfWeight?: number;
  /**
   * Give each map its own residual scale. Off, every map is assumed to be as
   * predictable as every other.
   */
  fitMapVariance?: boolean;
  /**
   * The least a prediction moves toward the score a player actually set on
   * that map, 0..1. It is the share of their deviation from the model that is
   * expected to repeat - the rest being run-to-run noise. Leaderboard scores
   * are personal bests and repeat well, so the default is high. 0 disables
   * anchoring altogether.
   */
  anchorWeight?: number;
  /**
   * Run-to-run noise of one player replaying one map, in logit units. Where a
   * map's scatter dwarfs this, the scatter is real differences between players
   * rather than luck, the model has correspondingly little to say, and the
   * anchor tightens beyond `anchorWeight` - up to 0.98.
   */
  runSigmaLogit?: number;
}

export interface Prediction {
  /** Expected accuracy, 0..1. Anchored to the player's real score when one exists. */
  acc: number;
  /** What the skill model alone says, before anchoring. */
  modelAcc: number;
  /** The score this prediction is anchored to, if any. */
  observedAcc: number | null;
  /** 0..1 - how far `acc` was moved from `modelAcc` toward `observedAcc`. */
  anchorWeight: number;
  /** Expected spread of the next run, in logit units. */
  sigmaLogit: number;
  /** Roughly, a one-standard-deviation band on acc. */
  accLow: number;
  accHigh: number;
  /** 0..1 - how much evidence sits behind this number. */
  confidence: number;
  /** True when the player has never played this map. */
  extrapolated: boolean;
  /**
   * Set when the prediction was held down by the player's real score on an
   * easier map - the leaderboard id of that map. See `predictWith`.
   */
  cappedBy: string | null;
}

export interface SkillModel {
  mu: number;
  playerIds: string[];
  leaderboardIds: string[];
  playerBias: Record<string, number>;
  mapBias: Record<string, number>;
  /**
   * How unpredictable a map is, relative to the field-wide residual spread.
   *
   * 1 is typical. On the MSU board Spin Eternally spreads the field across
   * 2.37 logit units against Konpeito's 0.78: the same players who sit within
   * a few points of each other on one map are forty apart on the other. A
   * prediction there carries wider uncertainty whatever its mean, and a score
   * there is weaker evidence about a player's general level.
   */
  mapSigmaScale: Record<string, number>;
  playerFactors: Record<string, number[]>;
  mapFactors: Record<string, number[]>;
  /** Robust residual spread per player, in logit units, on a map of typical scale. */
  playerSigma: Record<string, number>;
  playerCount: Record<string, number>;
  mapCount: Record<string, number>;
  globalSigma: number;
  latentFactors: number;
  /** Fraction of variance the model explains on the observed cells. */
  rSquared: number;
  predict(playerId: string, leaderboardId: string): Prediction;
}

/**
 * Defaults chosen by cross-validation on the real MSU qualifiers board (10
 * players x 7 maps, 55 scores). The result was clear and slightly humbling:
 * latent factors *lose*. Held-out error goes from a median of 0.68 accuracy
 * points to 0.95 with one factor, because one latent dimension adds 17
 * parameters to a 55-observation matrix. A per-map discrimination term
 * (IRT-style) was also tried and removed for the same reason - see the README.
 *
 * So the default is the plain additive model. The factor machinery is kept
 * because a player's full BeatLeader history is hundreds of scores rather than
 * seven, and `fitBestModel` re-runs this comparison on whatever data it is
 * actually given instead of trusting this default.
 */
const DEFAULTS: Required<FitOptions> = {
  latentFactors: 0,
  biasRegularization: 0.5,
  factorRegularization: 1,
  iterations: 1000,
  tolerance: 1e-4,
  huberDelta: 1.2,
  dnfWeight: 0.1,
  fitMapVariance: true,
  anchorWeight: 0.85,
  runSigmaLogit: 0.15,
};

export function fitSkillModel(
  observations: readonly Observation[],
  options: FitOptions = {},
): SkillModel {
  const opts = { ...DEFAULTS, ...options };

  const playerIds = [...new Set(observations.map((o) => o.playerId))].sort();
  const leaderboardIds = [...new Set(observations.map((o) => o.leaderboardId))].sort();

  const y = observations.map((o) => toLogit(o.acc));
  const baseWeights = observations.map(
    (o) => (o.isDnf ? opts.dnfWeight : 1) * (o.weight ?? 1),
  );
  // Two sets of weights. `robust` is prior weight times the Huber factor.
  // `weights` additionally carries 1/mapScale^2, and is what player skill is
  // fitted with. A map's own difficulty is fitted with `robust`: every score in
  // a column shares the same scale, so dividing by it would change nothing
  // except to let the ridge penalty flatten exactly the maps that stand out.
  const robust = [...baseWeights];
  const weights = [...baseWeights];

  const playerBias: Record<string, number> = {};
  const mapBias: Record<string, number> = {};
  const mapSigmaScale: Record<string, number> = {};
  const playerFactors: Record<string, number[]> = {};
  const mapFactors: Record<string, number[]> = {};

  for (const id of playerIds) {
    playerBias[id] = 0;
    playerFactors[id] = seedVector(id, opts.latentFactors);
  }
  for (const id of leaderboardIds) {
    mapBias[id] = 0;
    mapSigmaScale[id] = 1;
    mapFactors[id] = seedVector(id, opts.latentFactors);
  }

  // Index observations by player and by map once; the ALS sweeps use both.
  const byPlayer = new Map<string, number[]>();
  const byMap = new Map<string, number[]>();
  observations.forEach((o, i) => {
    pushTo(byPlayer, o.playerId, i);
    pushTo(byMap, o.leaderboardId, i);
  });

  let mu = weightedMean(y, weights);

  const interaction = (o: Observation): number =>
    dot(playerFactors[o.playerId]!, mapFactors[o.leaderboardId]!);
  const fitted = (o: Observation): number =>
    mu + playerBias[o.playerId]! + mapBias[o.leaderboardId]! + interaction(o);

  // Alternating least squares, run until nothing moves. A fixed number of
  // sweeps is not enough with factors in play: on the MSU fall board, forty
  // sweeps left a player's factor at -0.37 where the converged value was +0.33
  // - the fit was still drifting, cross-validation was comparing half-finished
  // fits, and the number shown depended on where the drift had got to. Each
  // parameter update is exact given the others, so the sweeps converge
  // geometrically and a cap of a thousand is never reached in practice.
  for (let iter = 0; iter < opts.iterations; iter++) {
    let moved = 0;
    const settle = (before: number, after: number): number => {
      moved = Math.max(moved, Math.abs(after - before));
      return after;
    };

    // --- additive biases ----------------------------------------------------
    mu = settle(mu, weightedMean(
      observations.map(
        (o, i) =>
          y[i]! - playerBias[o.playerId]! - mapBias[o.leaderboardId]! - interaction(o),
      ),
      weights,
    ));

    for (const [playerId, idx] of byPlayer) {
      playerBias[playerId] = settle(playerBias[playerId]!, ridgeMean(
        idx.map(
          (i) =>
            y[i]! -
            mu -
            mapBias[observations[i]!.leaderboardId]! -
            interaction(observations[i]!),
        ),
        idx.map((i) => weights[i]!),
        opts.biasRegularization,
      ));
    }

    for (const [mapId, idx] of byMap) {
      mapBias[mapId] = settle(mapBias[mapId]!, ridgeMean(
        idx.map(
          (i) =>
            y[i]! -
            mu -
            playerBias[observations[i]!.playerId]! -
            interaction(observations[i]!),
        ),
        idx.map((i) => robust[i]!),
        opts.biasRegularization,
      ));
    }

    // --- latent factors -----------------------------------------------------
    if (opts.latentFactors > 0) {
      for (let f = 0; f < opts.latentFactors; f++) {
        for (const [playerId, idx] of byPlayer) {
          playerFactors[playerId]![f] = settle(playerFactors[playerId]![f]!, solveFactor(
            idx,
            observations,
            y,
            weights,
            mu,
            playerBias,
            mapBias,
            playerFactors,
            mapFactors,
            f,
            'player',
            playerId,
            opts.factorRegularization,
          ));
        }
        for (const [mapId, idx] of byMap) {
          mapFactors[mapId]![f] = settle(mapFactors[mapId]![f]!, solveFactor(
            idx,
            observations,
            y,
            weights,
            mu,
            playerBias,
            mapBias,
            playerFactors,
            mapFactors,
            f,
            'map',
            mapId,
            opts.factorRegularization,
          ));
        }
      }
    }

    // --- per-map scale and Huber reweighting --------------------------------
    // Residuals are judged against their own map's spread. Forty points of
    // scatter is ordinary on Spin Eternally and unheard of on Madeleine, so a
    // single global yardstick would either write off every real Spin score as
    // an outlier or wave through an abandoned run on an easy map.
    //
    // The 1/scale^2 factor is ordinary weighted least squares: a noisy map is
    // weaker evidence about a player's general level.
    const residuals = observations.map((o, i) => y[i]! - fitted(o));
    const clean = residuals.filter((_, i) => !observations[i]!.isDnf);
    const scale = Math.max(mad(clean.length >= 2 ? clean : residuals), 0.05);

    if (opts.fitMapVariance) {
      for (const [mapId, idx] of byMap) {
        const rs = idx.filter((i) => !observations[i]!.isDnf).map((i) => residuals[i]!);
        mapSigmaScale[mapId] = shrunkScale(rs, scale);
      }
    }

    observations.forEach((o, i) => {
      const mapScale = mapSigmaScale[o.leaderboardId]!;
      const standardized = Math.abs(residuals[i]!) / (scale * mapScale);
      const huber = standardized <= opts.huberDelta ? 1 : opts.huberDelta / standardized;
      robust[i] = baseWeights[i]! * huber;
      weights[i] = robust[i]! / (mapScale * mapScale);
    });

    if (moved < opts.tolerance) break;
  }

  // --- residual spread per player -------------------------------------------
  // Measured in units of each map's own scale, so a player is not branded
  // erratic for having played the one map that scatters everybody. Flagged
  // anomalies are excluded: an abandoned run is a discrete event with its own
  // probability, not evidence that the player's real scores swing wildly.
  const residualsByPlayer = new Map<string, number[]>();
  const cleanResiduals: number[] = [];
  const cleanStandardized: number[] = [];
  observations.forEach((o, i) => {
    if (o.isDnf) return;
    const r = y[i]! - fitted(o);
    const standardized = r / mapSigmaScale[o.leaderboardId]!;
    pushTo(residualsByPlayer, o.playerId, standardized);
    cleanResiduals.push(r);
    cleanStandardized.push(standardized);
  });

  // In-sample residuals flatter the model: it has already spent a parameter
  // per player and per map fitting them. The usual degrees-of-freedom
  // correction widens the spread to what a genuinely unseen score will show.
  // Capped, because ridge shrinkage means the parameters are not fully free.
  // With nothing to fit there is nothing to correct: 0/0 here made every
  // sigma NaN for a pool with no scores yet, and NaN never comes back out of
  // Math.max.
  const parameters = playerIds.length + leaderboardIds.length;
  const n = cleanStandardized.length;
  const dof = n === 0 ? 1 : Math.min(1.5, Math.sqrt(n / Math.max(n - parameters, n / 2.25)));
  for (const rs of residualsByPlayer.values()) rs.forEach((r, i) => (rs[i] = r * dof));

  const globalSigma = Math.max(mad(cleanStandardized) * dof, 0.05);
  const playerSigma: Record<string, number> = {};
  const playerCount: Record<string, number> = {};
  for (const id of playerIds) {
    const rs = residualsByPlayer.get(id) ?? [];
    playerCount[id] = rs.length;
    // Shrink a thin sample toward the field-wide spread rather than trusting
    // the spread of three numbers.
    const own = mad(rs);
    const k = rs.length / (rs.length + 5);
    playerSigma[id] = Math.max(k * own + (1 - k) * globalSigma, 0.02);
  }

  const mapCount: Record<string, number> = {};
  for (const id of leaderboardIds) mapCount[id] = byMap.get(id)?.length ?? 0;

  // R^2 against a mean-only model, over unflagged runs only - scoring the
  // model on anomalies it deliberately ignores would understate it.
  const yClean = observations.flatMap((o, i) => (o.isDnf ? [] : [y[i]!]));
  const yMean = median(yClean);
  const ssTot = yClean.reduce((acc, v) => acc + (v - yMean) ** 2, 0);
  const ssRes = cleanResiduals.reduce((acc, r) => acc + r * r, 0);
  const rSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // What each player actually scored, for anchoring. A flagged anomaly never
  // anchors anything - Alex's 20% on Madeleine is not what he will score next
  // time - and an old score anchors in proportion to its recency weight.
  const observed = new Map<string, ObservedCell>();
  observations.forEach((o, i) => {
    const key = cellKey(o.playerId, o.leaderboardId);
    const cell = observed.get(key) ?? { logitSum: 0, weightSum: 0, maxWeight: 0 };
    if (!o.isDnf) {
      const w = o.weight ?? 1;
      cell.logitSum += w * y[i]!;
      cell.weightSum += w;
      cell.maxWeight = Math.max(cell.maxWeight, Math.min(1, w));
    }
    observed.set(key, cell);
  });

  const model: SkillModel = {
    mu,
    playerIds,
    leaderboardIds,
    playerBias,
    mapBias,
    mapSigmaScale,
    playerFactors,
    mapFactors,
    playerSigma,
    playerCount,
    mapCount,
    globalSigma,
    latentFactors: opts.latentFactors,
    rSquared,
    predict(playerId, leaderboardId) {
      return predictWith(this, playerId, leaderboardId, observed, opts);
    },
  };

  return model;
}

interface ObservedCell {
  logitSum: number;
  weightSum: number;
  /** Largest prior weight among the unflagged scores in this cell. */
  maxWeight: number;
}

const cellKey = (playerId: string, leaderboardId: string): string =>
  `${playerId}::${leaderboardId}`;

/**
 * A map's residual spread relative to the field's, shrunk toward 1. Seven
 * scores cannot pin a variance down, so a map has to show its scatter across
 * several players before it is believed.
 */
function shrunkScale(residuals: readonly number[], globalScale: number): number {
  if (residuals.length < 3) return 1;
  const own = Math.max(mad(residuals), 0.02) / globalScale;
  const k = residuals.length / (residuals.length + 4);
  return Math.max(0.5, Math.min(6, k * own + (1 - k)));
}

function predictWith(
  model: SkillModel,
  playerId: string,
  leaderboardId: string,
  observed: Map<string, ObservedCell>,
  opts: Pick<Required<FitOptions>, 'anchorWeight' | 'runSigmaLogit'>,
): Prediction {
  // An unknown player or map falls back to the field average rather than
  // throwing - a new signup should still get a usable, clearly-unconfident number.
  const pb = model.playerBias[playerId] ?? 0;
  const mb = model.mapBias[leaderboardId] ?? 0;
  const pf = model.playerFactors[playerId] ?? new Array(model.latentFactors).fill(0);
  const mf = model.mapFactors[leaderboardId] ?? new Array(model.latentFactors).fill(0);

  const modelLogit = model.mu + pb + mb + dot(pf, mf);
  const cellSigma =
    (model.playerSigma[playerId] ?? model.globalSigma) *
    (model.mapSigmaScale[leaderboardId] ?? 1);

  const cell = observed.get(cellKey(playerId, leaderboardId));
  const extrapolated = !cell;

  // Anchoring. The model's residual on a played cell is part repeatable (this
  // player really is that much better or worse on this map than their general
  // level suggests) and part run-to-run noise. The anchor weight w is the
  // repeatable share: the estimate moves that far toward the real score, and
  // the remaining uncertainty shrinks to match, sigma * sqrt(1 - w^2).
  //
  // w is the larger of a fixed floor and 1 - run^2 / sigma^2, the share implied
  // by this cell's own scatter. On Spin Eternally nearly all of the scatter is
  // real, so Kadence's 50.45% is believed almost outright.
  let logit = modelLogit;
  let sigma = cellSigma;
  let anchorWeight = 0;
  let observedAcc: number | null = null;
  if (cell && cell.weightSum > 0 && opts.anchorWeight > 0) {
    const observedLogit = cell.logitSum / cell.weightSum;
    observedAcc = fromLogit(observedLogit);
    const implied = 1 - (opts.runSigmaLogit * opts.runSigmaLogit) / (cellSigma * cellSigma);
    anchorWeight =
      opts.anchorWeight > 0
        ? Math.min(0.98, Math.max(opts.anchorWeight, implied)) * cell.maxWeight
        : 0;
    logit = modelLogit + anchorWeight * (observedLogit - modelLogit);
    sigma = Math.max(cellSigma * Math.sqrt(1 - anchorWeight * anchorWeight), 0.02);
  }

  // A player cannot be expected to do better on a harder map than their real
  // score on an easier one implies. The additive fit cannot say it: one
  // number per player is their level, and a player who is fine on acc maps
  // and collapses on hard ones - gayalex5's 38% on Konpeito Extremists against
  // 96% everywhere easy - moves that number a little and is otherwise treated
  // as an outlier, so Spin Eternally, harder still, read 81%. Every score of
  // theirs on an easier map now sets a ceiling: that score, less the gap in
  // difficulty between the two maps. The lowest ceiling holds. Anomalies
  // never anchor, so never cap either.
  let cappedBy: string | null = null;
  if (extrapolated) {
    const easier = mb;
    for (const [key, other] of observed) {
      if (other.weightSum <= 0 || !key.startsWith(`${playerId}::`)) continue;
      const otherId = key.slice(playerId.length + 2);
      const otherBias = model.mapBias[otherId];
      if (otherBias == null || otherBias < easier - 0.05) continue;
      const ceiling = other.logitSum / other.weightSum + (easier - otherBias);
      if (ceiling < logit) {
        logit = ceiling;
        cappedBy = otherId;
      }
    }
  }

  const nPlayer = model.playerCount[playerId] ?? 0;
  const nMap = model.mapCount[leaderboardId] ?? 0;

  // Confidence rises with evidence on both axes, drops when we are guessing a
  // cell nobody has filled in, and is lifted by a real score on the cell.
  const evidence = Math.min(nPlayer / 8, 1) * Math.min(nMap / 4, 1);
  const base = evidence * (extrapolated ? 0.75 : 1);
  const confidence = Math.max(0.05, 1 - (1 - base) * (1 - anchorWeight));

  return {
    acc: fromLogit(logit),
    modelAcc: fromLogit(modelLogit),
    observedAcc,
    anchorWeight,
    sigmaLogit: sigma,
    accLow: fromLogit(logit - sigma),
    accHigh: fromLogit(logit + sigma),
    confidence,
    extrapolated,
    cappedBy,
  };
}


// ---------------------------------------------------------------------------
//  Linear algebra helpers (dense, tiny problems - no library needed)
// ---------------------------------------------------------------------------

function solveFactor(
  idx: readonly number[],
  observations: readonly Observation[],
  y: readonly number[],
  weights: readonly number[],
  mu: number,
  playerBias: Record<string, number>,
  mapBias: Record<string, number>,
  playerFactors: Record<string, number[]>,
  mapFactors: Record<string, number[]>,
  f: number,
  side: 'player' | 'map',
  id: string,
  lambda: number,
): number {
  // Weighted ridge regression of the partial residual on the other side's
  // loading: x = otherFactor[f], solving  sum(w x r) / (sum(w x^2) + lambda).
  let num = 0;
  let den = 0;

  for (const i of idx) {
    const o = observations[i]!;
    const pf = playerFactors[o.playerId]!;
    const mf = mapFactors[o.leaderboardId]!;

    // Contribution of every factor except f.
    let others = 0;
    for (let k = 0; k < pf.length; k++) {
      if (k !== f) others += pf[k]! * mf[k]!;
    }

    const partial =
      y[i]! - (mu + playerBias[o.playerId]! + mapBias[o.leaderboardId]! + others);
    const x = side === 'player' ? mf[f]! : pf[f]!;
    const w = weights[i]!;

    num += w * x * partial;
    den += w * x * x;
  }

  const value = num / (den + lambda);
  // Keep loadings bounded; runaway factors are the usual ALS failure mode.
  return Math.max(-2, Math.min(2, value));
}

function ridgeMean(
  values: readonly number[],
  weights: readonly number[],
  lambda: number,
): number {
  let num = 0;
  let den = lambda;
  for (let i = 0; i < values.length; i++) {
    num += weights[i]! * values[i]!;
    den += weights[i]!;
  }
  return den > 0 ? num / den : 0;
}

function weightedMean(values: readonly number[], weights: readonly number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    num += weights[i]! * values[i]!;
    den += weights[i]!;
  }
  return den > 0 ? num / den : 0;
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Deterministic small starting values. ALS needs asymmetric initialisation or
 * every factor collapses to the same value; deriving it from the id keeps fits
 * reproducible, which matters when a recommendation has to be explainable.
 */
function seedVector(id: string, size: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Array.from({ length: size }, (_, k) => {
    h = Math.imul(h ^ (k + 1), 16777619);
    return (((h >>> 0) % 2000) / 1000 - 1) * 0.1;
  });
}

function pushTo(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

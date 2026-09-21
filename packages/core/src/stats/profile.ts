import type { SkillModel } from './model.js';
import { mean, median, stdev } from './normalize.js';

/**
 * Descriptive player statistics, and the fail model.
 *
 * "Fail" here means an anomaly as classified in normalize.ts: an abandoned run
 * or a disaster, like Alex's 20.36% on a map where everyone else is above 96%.
 * It does not mean a low score on a map that is beyond the player. Kadence's
 * 50.45% on Spin Eternally is her score on Spin Eternally: it counts in her
 * averages exactly as the spreadsheet counted it, it anchors her prediction on
 * that map, and it is not a "fail" for any purpose below.
 *
 * Anomalies are modelled separately from accuracy because they are a different
 * kind of event. A small chance of throwing a map away entirely is a different
 * risk from a wide-but-honest spread, and the simulator draws it separately.
 */

export interface ScoreDetail {
  playerId: string;
  leaderboardId: string;
  acc: number;
  isDnf: boolean;
  missedNotes?: number;
  badCuts?: number;
  fullCombo?: boolean;
  pauses?: number;
  accLeft?: number;
  accRight?: number;
  timeset?: number;
}

export interface PlayerProfile {
  playerId: string;
  scoreCount: number;

  /** Skill in logit units, straight from the model. Higher is better. */
  skill: number;
  /** Residual spread on unflagged runs, logit units, on a map of typical scatter. */
  sigma: number;
  /**
   * What players are ranked by: skill less two standard errors, logit units.
   *
   * Skill alone is kind to a thin record. Someone who has posted three scores,
   * all on the easy maps, is shrunk toward the field average and never pays
   * for the hard maps they have not played - while the teammate who did play
   * them carries those scores. On the MSU board that put Alex (3 scores) above
   * Kadence (7, one of them a 50% on Spin Eternally). The rating is where we
   * can be fairly sure a player is at least this good, so a record has to be
   * both good and long to rank high.
   */
  rating: number;
  /** Scores that are not anomalies - what the rating's certainty rests on. */
  cleanCount: number;

  meanAcc: number;
  medianAcc: number;
  accStdev: number;
  bestAcc: number;
  worstCleanAcc: number;

  fcRate: number;
  missRate: number;
  pauseRate: number;
  /** Mean (accLeft - accRight); positive means the left hand is stronger. */
  handBalance: number;

  /** Share of runs flagged as anomalies (abandoned or disastrous). */
  failRate: number;
  failCount: number;

  /** Mean relative performance per organiser category tag, in logit units. */
  categoryAffinity: Record<string, number>;
  /**
   * The same comparison in plain accuracy (0..1): mean of actual minus what
   * general skill predicts. For showing to people - a big lean is badly
   * misstated by scaling the logit figure.
   */
  categoryAccDelta: Record<string, number>;

  lastPlayedAt: number | null;
}

export interface BuildProfilesInput {
  scores: readonly ScoreDetail[];
  model: SkillModel;
  /** leaderboardId -> organiser's category tag ("Tech", "Speed", ...). */
  categories?: Readonly<Record<string, string | null | undefined>>;
}

/** Standard errors taken off skill to get the rating. Two is roughly "97% sure they are at least this good". */
export const RATING_CAUTION = 2;

export function buildPlayerProfiles(
  input: BuildProfilesInput,
): Record<string, PlayerProfile> {
  const byPlayer = new Map<string, ScoreDetail[]>();
  for (const s of input.scores) {
    const list = byPlayer.get(s.playerId) ?? [];
    list.push(s);
    byPlayer.set(s.playerId, list);
  }

  const out: Record<string, PlayerProfile> = {};

  for (const [playerId, scores] of byPlayer) {
    const clean = scores.filter((s) => !s.isDnf);
    const accs = clean.map((s) => s.acc);
    const fails = scores.filter((s) => s.isDnf);

    // Category affinity: how much better or worse than the model expects this
    // player does on maps the organiser tagged a given way. This is the honest
    // version of the spreadsheet's hand-written "Acc / Tech / Speed" headers.
    const byCategory = new Map<string, number[]>();
    const accDeltas = new Map<string, number[]>();
    for (const s of clean) {
      const category = input.categories?.[s.leaderboardId];
      if (!category) continue;
      // The unanchored figure: the point is to compare the real score with what
      // general skill alone would suggest.
      const predicted = input.model.predict(playerId, s.leaderboardId).modelAcc;
      const list = byCategory.get(category) ?? [];
      list.push(logitDiff(s.acc, predicted));
      byCategory.set(category, list);
      const deltas = accDeltas.get(category) ?? [];
      deltas.push(s.acc - predicted);
      accDeltas.set(category, deltas);
    }

    const categoryAffinity: Record<string, number> = {};
    const categoryAccDelta: Record<string, number> = {};
    for (const [category, diffs] of byCategory) {
      categoryAffinity[category] = mean(diffs);
      categoryAccDelta[category] = mean(accDeltas.get(category) ?? []);
    }

    const handDiffs = clean
      .filter((s) => s.accLeft != null && s.accRight != null)
      .map((s) => s.accLeft! - s.accRight!);

    out[playerId] = {
      playerId,
      scoreCount: scores.length,
      skill: input.model.playerBias[playerId] ?? 0,
      sigma: input.model.playerSigma[playerId] ?? input.model.globalSigma,
      rating:
        (input.model.playerBias[playerId] ?? 0) -
        RATING_CAUTION * (input.model.globalSigma / Math.sqrt(Math.max(1, clean.length))),
      cleanCount: clean.length,

      meanAcc: mean(accs),
      medianAcc: median(accs),
      accStdev: stdev(accs),
      bestAcc: accs.length ? Math.max(...accs) : 0,
      worstCleanAcc: accs.length ? Math.min(...accs) : 0,

      fcRate: rate(clean, (s) => s.fullCombo === true),
      missRate: rate(clean, (s) => (s.missedNotes ?? 0) + (s.badCuts ?? 0) > 0),
      pauseRate: rate(clean, (s) => (s.pauses ?? 0) > 0),
      handBalance: handDiffs.length ? mean(handDiffs) : 0,

      failRate: scores.length ? fails.length / scores.length : 0,
      failCount: fails.length,

      categoryAffinity,
      categoryAccDelta,
      lastPlayedAt: scores.reduce<number | null>(
        (latest, s) => (s.timeset && (!latest || s.timeset > latest) ? s.timeset : latest),
        null,
      ),
    };
  }

  return out;
}

const rate = <T>(items: readonly T[], predicate: (item: T) => boolean): number =>
  items.length ? items.filter(predicate).length / items.length : 0;

const logitDiff = (actual: number, predicted: number): number => {
  const l = (v: number) => {
    const c = Math.min(1 - 1e-6, Math.max(1e-6, v));
    return Math.log(c / (1 - c));
  };
  return l(actual) - l(predicted);
};

// ---------------------------------------------------------------------------
//  The fail model
// ---------------------------------------------------------------------------

export interface FailModel {
  /** Base rate across everyone, used to shrink thin samples. */
  globalRate: number;
  playerRate: Record<string, number>;
  mapRate: Record<string, number>;
  /** Probability this player fails this map. */
  probability(playerId: string, leaderboardId: string, stretch?: number): number;
}

export interface FailModelInput {
  scores: readonly ScoreDetail[];
  model: SkillModel;
  /** Shrinkage strength - how many observations before a rate is trusted. */
  prior?: number;
}

/**
 * Probability of an anomalous run, as a per-player rate crossed with a per-map
 * rate, both shrunk toward the global rate, then adjusted for how far the map
 * sits above the player.
 *
 * The stretch adjustment is a prior, not something fitted: people abandon maps
 * that are going badly more often than maps that are going well. The MSU data
 * has a single anomaly in 55 scores, which is nowhere near enough to estimate
 * it. It matters little in practice - a player stretched that far is already
 * predicted a low score, which is where the real risk now lives.
 */
export function buildFailModel(input: FailModelInput): FailModel {
  // Anomalies are rare - one in 55 on the MSU board - so a rate needs a good
  // many scores behind it before it is believed over the base rate.
  const prior = input.prior ?? 10;
  const all = input.scores;
  const globalRate = all.length ? all.filter((s) => s.isDnf).length / all.length : 0.02;

  const playerRate = shrunkRates(all, (s) => s.playerId, globalRate, prior);
  const mapRate = shrunkRates(all, (s) => s.leaderboardId, globalRate, prior);

  return {
    globalRate,
    playerRate,
    mapRate,
    probability(playerId, leaderboardId, stretch) {
      const p = playerRate[playerId] ?? globalRate;
      const m = mapRate[leaderboardId] ?? globalRate;

      // Combine as excess risk over the base rate: this player's extra risk
      // plus this map's. Multiplying relative risks looks more standard but is
      // wrong here - a single abandoned run raises both its player's rate and
      // its map's, and multiplying counts that one event twice. With one
      // anomaly on the board it gave Alex a 61% chance of abandoning Madeleine
      // again.
      const base = Math.max(globalRate, 1e-4);
      let combined = Math.max(p + m - base, base * 0.25);

      // How far below their usual level this map is expected to drag them -
      // from their real score there if they have one, otherwise from the
      // model, so it is available even for a map nobody has played.
      const expectedLogit = logitOf(input.model.predict(playerId, leaderboardId).acc);
      const baseline = input.model.mu + (input.model.playerBias[playerId] ?? 0);
      const gap = stretch ?? Math.max(0, baseline - expectedLogit);

      // Each logit unit of stretch roughly doubles the risk, up to a point:
      // this is a prior with no data behind it, so it is not allowed to run.
      combined *= Math.pow(2, Math.min(gap, 1.5));

      return Math.min(0.9, Math.max(0, combined));
    },
  };
}

function shrunkRates<T extends ScoreDetail>(
  scores: readonly T[],
  key: (s: T) => string,
  globalRate: number,
  prior: number,
): Record<string, number> {
  const counts = new Map<string, { n: number; fails: number }>();
  for (const s of scores) {
    const k = key(s);
    const entry = counts.get(k) ?? { n: 0, fails: 0 };
    entry.n++;
    if (s.isDnf) entry.fails++;
    counts.set(k, entry);
  }

  const out: Record<string, number> = {};
  for (const [k, { n, fails }] of counts) {
    // Beta-binomial style shrinkage toward the global rate.
    out[k] = (fails + prior * globalRate) / (n + prior);
  }
  return out;
}

const logitOf = (v: number): number => {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, v));
  return Math.log(c / (1 - c));
};

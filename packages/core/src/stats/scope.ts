import { z } from 'zod';
import { mad, median } from './normalize.js';

/**
 * Which scores the skill model is allowed to learn from.
 *
 * This is a setting rather than a fixed choice because the right answer depends
 * on what is being asked. Predicting how a team will do on a pool everyone has
 * practised is best served by that pool alone - those are the exact maps, under
 * the exact conditions. Predicting a pool that was imported an hour ago needs a
 * player's wider history, because there is nothing else to go on.
 *
 * The default is POOL_ONLY: it is the most directly relevant evidence, it is
 * what the spreadsheets effectively used, and it keeps a fresh instance quick
 * to sync. Widening the scope is one click, and every filter below exists to
 * make a wider scope trustworthy rather than merely bigger.
 */

export const statsSourceSchema = z.enum([
  /** Only scores on maps that belong to a pool in this tournament. */
  'POOL_ONLY',
  /** Every score the player has on BeatLeader. */
  'FULL_HISTORY',
  /** Full history, but only ranked maps - the ones carrying difficulty ratings. */
  'RANKED_ONLY',
]);
export type StatsSource = z.infer<typeof statsSourceSchema>;

export const statsScopeSchema = z.object({
  source: statsSourceSchema.default('POOL_ONLY'),

  /**
   * Ignore scores older than this many days. A score from two years ago is
   * evidence about a different player. Null keeps everything.
   */
  maxAgeDays: z.number().int().positive().nullable().default(null),

  /**
   * Weight recent scores more heavily, halving the weight every N days.
   * Null weights every score equally. Gentler than maxAgeDays, which is a
   * cliff edge.
   */
  halfLifeDays: z.number().positive().nullable().default(null),

  /**
   * Drop scores more than this many robust deviations from the player's own
   * median. Catches the leftovers that fail detection misses - a map played
   * once badly years ago, a score set on a different controller.
   */
  outlierSigmas: z.number().positive().nullable().default(null),

  /** Exclude runs flagged as anomalies (abandoned, disastrous). They are down-weighted regardless. */
  excludeFails: z.boolean().default(false),

  /** Ignore anything below this accuracy outright. */
  minAccuracy: z.number().min(0).max(1).nullable().default(null),

  /** Cap how many scores one player can contribute, newest first. */
  maxScoresPerPlayer: z.number().int().positive().nullable().default(null),

  /** Only count maps at least this many of the tracked players have played. */
  minPlayersPerMap: z.number().int().positive().default(2),

  /**
   * Keep players' wider BeatLeader history downloaded even while `source` is
   * the pool. Changes nothing about what the model sees; it is what lets the
   * player stats pages be looked at over ranked or all maps without moving
   * the whole tournament's predictions onto them.
   */
  keepHistory: z.boolean().default(false),
});

export type StatsScope = z.infer<typeof statsScopeSchema>;

export const DEFAULT_STATS_SCOPE: StatsScope = statsScopeSchema.parse({});

/** A sensible preset when a captain turns full history on. */
export const FULL_HISTORY_PRESET: StatsScope = statsScopeSchema.parse({
  source: 'FULL_HISTORY',
  maxAgeDays: 365,
  halfLifeDays: 120,
  outlierSigmas: 4,
  minAccuracy: 0.5,
  maxScoresPerPlayer: 400,
  minPlayersPerMap: 2,
});

export const SCOPE_PRESETS: Record<string, StatsScope> = {
  poolOnly: DEFAULT_STATS_SCOPE,
  fullHistory: FULL_HISTORY_PRESET,
  rankedOnly: statsScopeSchema.parse({
    source: 'RANKED_ONLY',
    maxAgeDays: 365,
    halfLifeDays: 120,
    outlierSigmas: 4,
    maxScoresPerPlayer: 400,
  }),
  /** Everything, unfiltered - for looking at the raw picture. */
  everything: statsScopeSchema.parse({
    source: 'FULL_HISTORY',
    minPlayersPerMap: 1,
  }),
};

export interface ScopedScore {
  playerId: string;
  leaderboardId: string;
  acc: number;
  isDnf: boolean;
  /** Unix seconds. */
  timeset: number;
  /** Whether the map is in a pool belonging to this tournament. */
  inPool: boolean;
  ranked: boolean;
}

export interface WeightedObservation {
  playerId: string;
  leaderboardId: string;
  acc: number;
  isDnf: boolean;
  /** Recency weight in [0,1]; 1 when no half-life is configured. */
  weight: number;
}

export interface ScopeResult {
  observations: WeightedObservation[];
  /** Why scores were dropped, for the "what is this model looking at" panel. */
  excluded: Record<string, number>;
  playerCount: number;
  mapCount: number;
}

/**
 * Apply a scope to a player's scores.
 *
 * Order matters: source and age filters first (cheap, and they define the
 * population), then per-player outlier detection against whatever survived,
 * then the per-map floor last - because dropping a player's scores can leave
 * a map too thin to be usable.
 */
export function applyScope(
  scores: readonly ScopedScore[],
  scope: StatsScope = DEFAULT_STATS_SCOPE,
  now: number = Math.floor(Date.now() / 1000),
): ScopeResult {
  const excluded: Record<string, number> = {};
  const drop = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };

  let kept = scores.filter((s) => {
    if (scope.source === 'POOL_ONLY' && !s.inPool) {
      drop('not in a tournament pool');
      return false;
    }
    if (scope.source === 'RANKED_ONLY' && !s.ranked) {
      drop('map is not ranked');
      return false;
    }
    if (scope.excludeFails && s.isDnf) {
      drop('failed run');
      return false;
    }
    if (scope.minAccuracy != null && s.acc < scope.minAccuracy) {
      drop('below the accuracy floor');
      return false;
    }
    if (scope.maxAgeDays != null && s.timeset > 0) {
      const ageDays = (now - s.timeset) / 86_400;
      if (ageDays > scope.maxAgeDays) {
        drop('older than the age limit');
        return false;
      }
    }
    return true;
  });

  // --- per-player: cap and outlier removal ---------------------------------
  const byPlayer = new Map<string, ScopedScore[]>();
  for (const s of kept) {
    const list = byPlayer.get(s.playerId) ?? [];
    list.push(s);
    byPlayer.set(s.playerId, list);
  }

  const survivors: ScopedScore[] = [];
  for (const [, list] of byPlayer) {
    let playerScores = list;

    if (scope.maxScoresPerPlayer != null && playerScores.length > scope.maxScoresPerPlayer) {
      playerScores = [...playerScores]
        .sort((a, b) => b.timeset - a.timeset)
        .slice(0, scope.maxScoresPerPlayer);
      for (let i = scope.maxScoresPerPlayer; i < list.length; i++) drop('over the per-player cap');
    }

    if (scope.outlierSigmas != null && playerScores.length >= 5) {
      // Robust: median and MAD, so the outliers do not define the threshold
      // that is meant to catch them.
      const accs = playerScores.map((s) => s.acc);
      const centre = median(accs);
      const spread = mad(accs);
      if (spread > 0) {
        const limit = scope.outlierSigmas * spread;
        const before = playerScores.length;
        // Only trim the low side. A career-best run is real evidence; it is the
        // disasters that are not representative.
        playerScores = playerScores.filter((s) => centre - s.acc <= limit);
        for (let i = playerScores.length; i < before; i++) drop('statistical outlier');
      }
    }

    survivors.push(...playerScores);
  }

  kept = survivors;

  // --- per-map floor --------------------------------------------------------
  const playersPerMap = new Map<string, Set<string>>();
  for (const s of kept) {
    const set = playersPerMap.get(s.leaderboardId) ?? new Set<string>();
    set.add(s.playerId);
    playersPerMap.set(s.leaderboardId, set);
  }

  const usableMaps = new Set(
    [...playersPerMap.entries()]
      .filter(([, players]) => players.size >= scope.minPlayersPerMap)
      .map(([mapId]) => mapId),
  );

  const final = kept.filter((s) => {
    if (!usableMaps.has(s.leaderboardId)) {
      drop('too few players on this map');
      return false;
    }
    return true;
  });

  // --- recency weighting ----------------------------------------------------
  const observations: WeightedObservation[] = final.map((s) => ({
    playerId: s.playerId,
    leaderboardId: s.leaderboardId,
    acc: s.acc,
    isDnf: s.isDnf,
    weight: recencyWeight(s.timeset, now, scope.halfLifeDays),
  }));

  return {
    observations,
    excluded,
    playerCount: new Set(observations.map((o) => o.playerId)).size,
    mapCount: new Set(observations.map((o) => o.leaderboardId)).size,
  };
}

export function recencyWeight(
  timeset: number,
  now: number,
  halfLifeDays: number | null,
): number {
  if (!halfLifeDays || !timeset) return 1;
  const ageDays = Math.max(0, (now - timeset) / 86_400);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** One-line summary of a scope, for the UI. */
export function describeScope(scope: StatsScope): string {
  const parts: string[] = [];
  switch (scope.source) {
    case 'POOL_ONLY':
      parts.push('pool maps only');
      break;
    case 'RANKED_ONLY':
      parts.push('ranked maps from full history');
      break;
    default:
      parts.push('full BeatLeader history');
  }
  if (scope.maxAgeDays != null) parts.push(`last ${scope.maxAgeDays} days`);
  if (scope.halfLifeDays != null) parts.push(`${scope.halfLifeDays}-day half-life`);
  if (scope.outlierSigmas != null) parts.push(`outliers beyond ${scope.outlierSigmas}σ removed`);
  if (scope.excludeFails) parts.push('fails excluded');
  if (scope.minAccuracy != null) parts.push(`above ${(scope.minAccuracy * 100).toFixed(0)}%`);
  return parts.join(', ');
}

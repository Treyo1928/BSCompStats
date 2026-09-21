import { cookies } from 'next/headers';
import { runChooseModel } from './advice-thread';
import { announceMatchChange } from '@/lib/redis';
import { prisma } from '@bscs/db';
import { categorizeMap } from '@bscs/core/beatleader';
import { loadScores, scoreSaberPulse, type ScoreSource } from './score-sources';
import {
  applyScope,
  buildFailModel,
  buildPlayerProfiles,
  buildPlayStyles,
  canonicalKind,
  classifyFails,
  fitSkillModel,
  type FitOptions,
  statsScopeSchema,
  DEFAULT_STATS_SCOPE,
  type FailModel,
  type PlayerProfile,
  type PlayStyle,
  type ScoreDetail,
  type ScopedScore,
  type SkillModel,
  type StatsScope,
} from '@bscs/core/stats';

/**
 * Builds the skill model for a tournament.
 *
 * The scope decides what the model is allowed to see - pool maps only by
 * default, optionally a player's whole BeatLeader history with recency and
 * outlier filters. See packages/core/src/stats/scope.ts for why that is a
 * setting rather than a fixed choice.
 */

export interface TournamentModel {
  model: SkillModel;
  failModel: FailModel;
  profiles: Record<string, PlayerProfile>;
  /** Each profile read back as a description, relative to this tournament's field. */
  styles: Record<string, PlayStyle>;
  scope: StatsScope;
  /**
   * Scores classified as anomalies - abandoned or disastrous runs - keyed by
   * `failKey`. The one source of truth: the board reads this rather than
   * re-deriving it. A low score on a map beyond the player is not in here.
   */
  failKeys: Set<string>;
  /** Why scores were left out, for the "what is this looking at" panel. */
  excluded: Record<string, number>;
  observationCount: number;
  playerCount: number;
  mapCount: number;
  /** leaderboardId -> maxScore, so callers can turn accuracy back into points. */
  maxScores: Record<string, number>;
  chosenLatentFactors: number;
  /**
   * Accuracies this viewer has entered for maps a player has not played, keyed
   * by `failKey`. They win over the model, for this viewer only.
   */
  estimates: Map<string, number>;
  /**
   * The scores the model was fitted on, and what kind of map each is on -
   * what standings and like-for-like comparisons are worked out from.
   */
  scores: ScoreDetail[];
  categories: Record<string, string | null>;
  /** Changes whenever anything the model was fitted on changes. */
  version: string;
}

/**
 * One fitted model per tournament, reused until its inputs change.
 *
 * Fitting is the expensive part of every board and match page, and those pages
 * re-render on each live score for each viewer. Node runs it on the one thread
 * that also serves every other request, so an uncached fit is felt by everyone.
 */
const modelCache = new Map<string, TournamentModel>();
/** The fit settings cross-validation last chose per tournament, and for which scores. */
const fitChoice = new Map<string, { dataKey: string; chosen: FitOptions }>();
const fitChoosing = new Map<string, string>();
/**
 * Fits under way, so that everything asking for the same model at the same
 * moment waits for one fit instead of each starting its own. One page asks
 * several times over - once per pool board, once for its metadata, once for
 * its preview image - and they all arrive before the first has finished, so
 * every one of them missed the cache and fitted the model again. At two
 * seconds a fit, on the thread that serves every request, that was the site
 * standing still for eight.
 */
const building = new Map<string, { version: string; model: Promise<TournamentModel> }>();

export async function buildTournamentModel(
  tournamentId: string,
  overrideScope?: Partial<StatsScope>,
  /** Which platform's scores to learn from. Both, unless someone asks to see one alone. */
  source: ScoreSource = 'both',
): Promise<TournamentModel> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { defaultFormat: true, statsScope: true },
  });

  // Its own column now. It used to sit inside defaultFormat, which is still
  // read so an instance that had one there keeps it.
  const stored =
    tournament?.statsScope ??
    (tournament?.defaultFormat as { statsScope?: unknown } | null)?.statsScope;
  const scope = statsScopeSchema.parse({
    ...(DEFAULT_STATS_SCOPE as object),
    ...(typeof stored === 'object' && stored ? stored : {}),
    ...(overrideScope ?? {}),
  });

  // Players are those on a team in this tournament.
  const members = await prisma.teamMember.findMany({
    where: { team: { division: { tournamentId } } },
    select: { playerId: true },
  });
  const playerIds = [...new Set(members.map((m) => m.playerId))];

  // Leaderboards belonging to any pool in this tournament.
  const poolMaps = await prisma.poolMap.findMany({
    where: { pool: { tournamentId } },
    select: { leaderboardId: true, category: true },
  });
  const poolLeaderboardIds = new Set(poolMaps.map((pm) => pm.leaderboardId));

  // Cheap to ask, and it moves whenever a score is added or improved.
  const pulse = await prisma.score.aggregate({
    where: { playerId: { in: playerIds } },
    _count: true,
    _max: { timeset: true },
    _sum: { baseScore: true },
  });
  const version = JSON.stringify([
    scope,
    [...playerIds].sort(),
    [...poolLeaderboardIds].sort(),
    // What kind each map is called feeds the styles, so relabelling one is a change too.
    poolMaps.map((pm) => `${pm.leaderboardId}:${pm.category ?? ''}`).sort(),
    pulse._count,
    pulse._max.timeset,
    pulse._sum.baseScore,
    source,
    source === 'beatleader' ? '' : await scoreSaberPulse(playerIds),
  ]);
  // Per scope, not per tournament: the stats pages can look at the same
  // tournament over ranked or all maps, and must not evict the pool-only model
  // that every board and match page is rendered from.
  const cacheKey = `${tournamentId}|${source}|${JSON.stringify(scope)}`;
  const cached = modelCache.get(cacheKey);
  if (cached?.version === version) return withViewerEstimates(cached, tournamentId);

  const underWay = building.get(cacheKey);
  if (underWay?.version === version) return withViewerEstimates(await underWay.model, tournamentId);

  const fit = (async (): Promise<TournamentModel> => {
  const fitStarted = performance.now();

  const scores = await loadScores(playerIds, {
    source,
    leaderboardIds: scope.source === 'POOL_ONLY' ? [...poolLeaderboardIds] : undefined,
  });

  const maxScores: Record<string, number> = {};
  for (const s of scores) maxScores[s.leaderboardId] = s.leaderboard.maxScore;

  // Anomalies are classified over everything fetched, before scoping: the
  // test compares a score with the player's own norm and with the rest of its
  // map's column, and trimming either first would move the yardstick.
  const flags = classifyFails(
    scores.map((s) => ({
      playerId: s.playerId,
      leaderboardId: s.leaderboardId,
      acc: s.accuracy,
    })),
  );
  const failKeys = new Set<string>();
  scores.forEach((s, i) => {
    if (flags[i]) failKeys.add(failKey(s.playerId, s.leaderboardId));
  });

  const scoped: ScopedScore[] = scores.map((s) => ({
    playerId: s.playerId,
    leaderboardId: s.leaderboardId,
    acc: s.accuracy,
    isDnf: failKeys.has(failKey(s.playerId, s.leaderboardId)),
    timeset: s.timeset,
    inPool: poolLeaderboardIds.has(s.leaderboardId),
    ranked: s.leaderboard.ranked,
  }));

  const { observations, excluded, playerCount, mapCount } = applyScope(scoped, scope);

  // Which complexity to fit is decided by cross-validation - a grid of fits
  // over many folds, seconds of work - on the advice thread. The model itself
  // is one fit, done here with the best settings known so far: the ones last
  // chosen for this tournament, or the plain additive model, which is what
  // cross-validation picks on a pool-sized board anyway. If the thread comes
  // back with something different, the next render refits with it.
  const dataKey = JSON.stringify(observations.map((o) => [o.playerId, o.leaderboardId, o.acc]));
  const settled = fitChoice.get(cacheKey);
  const chosen: FitOptions = settled?.chosen ?? { latentFactors: 0, biasRegularization: 0.5 };
  const model = fitSkillModel(observations, chosen);

  if (settled?.dataKey !== dataKey && fitChoosing.get(cacheKey) !== dataKey) {
    fitChoosing.set(cacheKey, dataKey);
    void runChooseModel([...observations])
      .then(async (better) => {
        if (fitChoosing.get(cacheKey) !== dataKey) return;
        fitChoosing.delete(cacheKey);
        fitChoice.set(cacheKey, { dataKey, chosen: better });
        if (JSON.stringify(better) === JSON.stringify(chosen)) return;

        // A different model means different predictions: drop the cached one
        // and bring open match pages up to date. Pool pages pick it up on
        // their next refresh.
        modelCache.delete(cacheKey);
        const live = await prisma.match.findMany({
          where: { tournamentId, state: { not: 'COMPLETE' } },
          select: { id: true },
        });
        await Promise.all(live.map((m) => announceMatchChange(m.id)));
      })
      .catch((err) => {
        if (fitChoosing.get(cacheKey) === dataKey) fitChoosing.delete(cacheKey);
        console.error('[model] choosing fit options failed:', err);
      });
  }

  const observed = new Set(observations.map((o) => failKey(o.playerId, o.leaderboardId)));
  const detailed = scores
    .filter((s) => observed.has(failKey(s.playerId, s.leaderboardId)))
    .map((s) => ({
      playerId: s.playerId,
      leaderboardId: s.leaderboardId,
      acc: s.accuracy,
      isDnf: failKeys.has(failKey(s.playerId, s.leaderboardId)),
      missedNotes: s.missedNotes,
      badCuts: s.badCuts,
      fullCombo: s.fullCombo,
      pauses: s.pauses,
      accLeft: s.accLeft,
      accRight: s.accRight,
      timeset: s.timeset,
    }));

  // One spelling per kind: an organiser's "Tech" and the ratings guess "tech"
  // are the same kind of map, and have to rank as one.
  const categories: Record<string, string | null> = Object.fromEntries(
    poolMaps.map((pm) => [pm.leaderboardId, canonicalKind(pm.category)]),
  );

  // Where no organiser has tagged a map - which is every map outside the
  // pools - a ranked one still has BeatLeader's ratings to guess from. That is what makes a wider scope worth
  // having for play styles: hundreds of scores per kind of map instead of one.
  for (const s of scores) {
    categories[s.leaderboardId] ??= canonicalKind(
      categorizeMap({
        acc: s.leaderboard.accRating,
        pass: s.leaderboard.passRating,
        tech: s.leaderboard.techRating,
      }),
    );
  }

  const profiles = buildPlayerProfiles({ scores: detailed, model, categories });

  const built: TournamentModel = {
    model,
    failModel: buildFailModel({ scores: detailed, model }),
    profiles,
    styles: buildPlayStyles({ profiles, scores: detailed, categories }),
    scope,
    failKeys,
    excluded,
    observationCount: observations.length,
    playerCount,
    mapCount,
    maxScores,
    chosenLatentFactors: chosen.latentFactors ?? 0,
    estimates: new Map(),
    scores: detailed,
    categories,
    version,
  };
  modelCache.set(cacheKey, built);
  // This runs on the request thread, so how long it takes is how long the site
  // stalls when scores change. Worth being able to see.
  console.info(
    `[model] fitted ${observations.length} scores for ${playerCount} players in ${Math.round(performance.now() - fitStarted)}ms`,
  );
  return built;
  })();

  building.set(cacheKey, { version, model: fit });
  try {
    return withViewerEstimates(await fit, tournamentId);
  } finally {
    // Whether it worked or not, it is no longer under way. A failure must not be handed to the next caller.
    if (building.get(cacheKey)?.model === fit) building.delete(cacheKey);
  }
}

export const ESTIMATES_COOKIE = 'bscs-estimates';

/** tournamentId -> failKey -> accuracy (0..1), as kept in the viewer's session cookie. */
export type EstimateCookie = Record<string, Record<string, number>>;

export function parseEstimateCookie(raw: string | undefined): EstimateCookie {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as EstimateCookie) : {};
  } catch {
    return {};
  }
}

/**
 * Lay the viewer's own estimates over the shared model.
 *
 * An estimate is one person's opinion, so it is kept in their browser session
 * and applied only to what they are shown. The fitted model underneath is
 * shared and cached; this makes a per-viewer copy and marks its version, so
 * anything cached off the back of it (match advice) is not shared either.
 */
async function withViewerEstimates(
  shared: TournamentModel,
  tournamentId: string,
): Promise<TournamentModel> {
  let mine: Record<string, number> | undefined;
  try {
    mine = parseEstimateCookie((await cookies()).get(ESTIMATES_COOKIE)?.value)[tournamentId];
  } catch {
    // Outside a request there is no viewer, and so no estimates.
  }
  const entries = Object.entries(mine ?? {}).filter(
    ([, acc]) => typeof acc === 'number' && acc > 0 && acc <= 1,
  );
  if (entries.length === 0) return shared;

  return {
    ...shared,
    estimates: new Map(entries),
    version: `${shared.version}|viewer:${JSON.stringify(entries.sort())}`,
  };
}

export const failKey = (playerId: string, leaderboardId: string): string =>
  `${playerId}::${leaderboardId}`;

/**
 * A prediction function shaped for the simulator. Where the player has a real
 * score on the map, `acc` is anchored to it - Kadence is simulated around the
 * 50% she actually scores on Spin Eternally, not the 88% her other maps imply.
 */
export function predictorFor(built: TournamentModel) {
  return (playerId: string, leaderboardId: string) => {
    const prediction = built.model.predict(playerId, leaderboardId);
    // A real score always wins; an estimate only stands in where there is none.
    const estimate =
      prediction.observedAcc == null
        ? built.estimates.get(failKey(playerId, leaderboardId))
        : undefined;
    return {
      acc: estimate ?? prediction.acc,
      sigmaLogit: prediction.sigmaLogit,
      failProbability: built.failModel.probability(playerId, leaderboardId),
    };
  };
}

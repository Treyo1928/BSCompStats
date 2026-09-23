import { prisma } from '@bscs/db';
import { loadScores, runsPulse, scoreSaberPulse, type ScoreSource } from './score-sources';
import {
  applyScope,
  buildPlayerProfiles,
  classifyFails,
  statsScopeSchema,
  DEFAULT_STATS_SCOPE,
  type PlayerProfile,
  type ScoreDetail,
  type ScopedScore,
  type StatsScope,
} from '@bscs/core/stats';

/**
 * The scores a tournament's stats are worked out from - what its players have
 * actually set, and nothing estimated.
 *
 * The scope decides which scores are in view: the tournament's pools by
 * default, or a player's ranked maps or whole history on the wider stats
 * views. See packages/core/src/stats/scope.ts.
 */

export interface TournamentData {
  profiles: Record<string, PlayerProfile>;
  scope: StatsScope;
  /**
   * Scores classified as abandoned runs, keyed by `failKey`. The one source of
   * truth: the board reads this rather than re-deriving it. A low score on a
   * map beyond the player is not in here.
   */
  failKeys: Set<string>;
  /** Why scores were left out of view. */
  excluded: Record<string, number>;
  scoreCount: number;
  /** Players whose recorded runs BeatLeader shows, out of those on rosters. */
  runsKnownFor: number;
  playerCount: number;
  mapCount: number;
  /** leaderboardId -> maxScore, so callers can turn accuracy back into points. */
  maxScores: Record<string, number>;
  /** The scores in view. */
  scores: ScoreDetail[];
  /** Changes whenever anything this was built from changes. */
  version: string;
}

/** One per tournament and view, reused until what it was built from changes. */
const dataCache = new Map<string, TournamentData>();
/** Builds under way, so everything asking at the same moment waits for one. */
const building = new Map<string, { version: string; data: Promise<TournamentData> }>();

export async function buildTournamentData(
  tournamentId: string,
  overrideScope?: Partial<StatsScope>,
  /** Which platform's scores. Both, unless someone asks to see one alone. */
  source: ScoreSource = 'both',
): Promise<TournamentData> {
  const scope = statsScopeSchema.parse({ ...(DEFAULT_STATS_SCOPE as object), ...(overrideScope ?? {}) });

  const members = await prisma.teamMember.findMany({
    where: { team: { division: { tournamentId } } },
    select: { playerId: true },
  });
  const playerIds = [...new Set(members.map((m) => m.playerId))];

  const poolMaps = await prisma.poolMap.findMany({
    where: { pool: { tournamentId } },
    select: { leaderboardId: true },
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
    pulse._count,
    pulse._max.timeset,
    pulse._sum.baseScore,
    source,
    source === 'beatleader' ? '' : await scoreSaberPulse(playerIds),
    await runsPulse(playerIds),
  ]);
  const cacheKey = `${tournamentId}|${source}|${JSON.stringify(scope)}`;
  const cached = dataCache.get(cacheKey);
  if (cached?.version === version) return cached;
  const underWay = building.get(cacheKey);
  if (underWay?.version === version) return underWay.data;

  const build = (async (): Promise<TournamentData> => {
    const scores = await loadScores(playerIds, {
      source,
      leaderboardIds: scope.source === 'POOL_ONLY' ? [...poolLeaderboardIds] : undefined,
    });

    const maxScores: Record<string, number> = {};
    for (const s of scores) maxScores[s.leaderboardId] = s.leaderboard.maxScore;

    // Abandoned runs are classified over everything fetched, before scoping:
    // the test compares a score with the player's own norm and with the rest
    // of its map's column, and trimming either first would move the yardstick.
    const flags = classifyFails(
      scores.map((s) => ({ playerId: s.playerId, leaderboardId: s.leaderboardId, acc: s.accuracy })),
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

    const runsKnownFor =
      source === 'scoresaber'
        ? 0
        : await prisma.player.count({ where: { id: { in: playerIds }, attemptsPublic: true } });

    const inView = new Set(observations.map((o) => failKey(o.playerId, o.leaderboardId)));
    const detailed: ScoreDetail[] = scores
      .filter((s) => inView.has(failKey(s.playerId, s.leaderboardId)))
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

    const profiles = buildPlayerProfiles(detailed);
    const built: TournamentData = {
      profiles,
      scope,
      failKeys,
      excluded,
      scoreCount: observations.length,
      runsKnownFor,
      playerCount,
      mapCount,
      maxScores,
      scores: detailed,
      version,
    };
    dataCache.set(cacheKey, built);
    return built;
  })();

  building.set(cacheKey, { version, data: build });
  try {
    return await build;
  } finally {
    // Whether it worked or not, it is no longer under way. A failure must not be handed to the next caller.
    if (building.get(cacheKey)?.data === build) building.delete(cacheKey);
  }
}

export const failKey = (playerId: string, leaderboardId: string): string =>
  `${playerId}::${leaderboardId}`;

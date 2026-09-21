import { prisma } from '@bscs/db';
import {
  applyScope,
  buildFailModel,
  buildPlayerProfiles,
  classifyFails,
  fitBestModel,
  statsScopeSchema,
  DEFAULT_STATS_SCOPE,
  type FailModel,
  type PlayerProfile,
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
}

export async function buildTournamentModel(
  tournamentId: string,
  overrideScope?: Partial<StatsScope>,
): Promise<TournamentModel> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { defaultFormat: true },
  });

  const stored = (tournament?.defaultFormat as { statsScope?: unknown } | null)?.statsScope;
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
    select: { leaderboardId: true },
  });
  const poolLeaderboardIds = new Set(poolMaps.map((pm) => pm.leaderboardId));

  const scores = playerIds.length
    ? await prisma.score.findMany({
        where: {
          playerId: { in: playerIds },
          ...(scope.source === 'POOL_ONLY'
            ? { leaderboardId: { in: [...poolLeaderboardIds] } }
            : {}),
        },
        select: {
          playerId: true,
          leaderboardId: true,
          baseScore: true,
          accuracy: true,
          missedNotes: true,
          badCuts: true,
          fullCombo: true,
          pauses: true,
          accLeft: true,
          accRight: true,
          timeset: true,
          leaderboard: { select: { maxScore: true, ranked: true } },
        },
      })
    : [];

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

  const { model, chosen } = fitBestModel(observations);

  const detailed = scores
    .filter((s) =>
      observations.some(
        (o) => o.playerId === s.playerId && o.leaderboardId === s.leaderboardId,
      ),
    )
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

  const categories = Object.fromEntries(
    (
      await prisma.poolMap.findMany({
        where: { pool: { tournamentId } },
        select: { leaderboardId: true, category: true },
      })
    ).map((pm) => [pm.leaderboardId, pm.category]),
  );

  return {
    model,
    failModel: buildFailModel({ scores: detailed, model }),
    profiles: buildPlayerProfiles({ scores: detailed, model, categories }),
    scope,
    failKeys,
    excluded,
    observationCount: observations.length,
    playerCount,
    mapCount,
    maxScores,
    chosenLatentFactors: chosen.latentFactors ?? 0,
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
    return {
      acc: prediction.acc,
      sigmaLogit: prediction.sigmaLogit,
      failProbability: built.failModel.probability(playerId, leaderboardId),
    };
  };
}

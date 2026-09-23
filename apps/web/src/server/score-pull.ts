import { prisma } from '@bscs/db';
import { BL_END_TYPES } from '@bscs/core/beatleader';
import {
  DEFAULT_TOLERANCE_SECONDS,
  pickMatchRuns,
  type PlayerRuns,
  type PulledEnd,
  type PulledRun,
  type PullResult,
} from '@bscs/core/match';
import { beatLeader } from './pools';

/**
 * Fetching a match map's runs from BeatLeader. The choosing is in
 * packages/core/match/pull.ts; this is the talking to BeatLeader and the
 * database either side of it.
 */

export interface PullTarget {
  matchId: string;
  matchMapId: string;
  teamAId: string;
  teamBId: string;
  leaderboardId: string;
  maxScore: number;
  duration: number;
  /** The run being filled in: 1, or the latest replay's. */
  attempt: number;
  /** Unix seconds the run opened for play. */
  since: number;
  /** Someone has said this map's scores are final. */
  closed: boolean;
  /** Who is fielded on the map, by team. A player on both sides plays once and counts for each. */
  lineups: Array<{ teamId: string; playerIds: string[] }>;
  players: Map<string, { name: string; beatLeaderId: string }>;
  hash: string;
  difficultyName: string;
  modeName: string;
  options: { toleranceSeconds: number };
}

export async function loadPullTarget(matchId: string, matchMapId: string): Promise<PullTarget | null> {
  const matchMap = await prisma.matchMap.findFirst({
    where: { id: matchMapId, matchId },
    select: {
      replayCalledByTeamIds: true,
      runOpenedAt: true,
      scoresClosedAt: true,
      match: { select: { teamAId: true, teamBId: true, tournament: { select: { scorePull: true } } } },
      poolMap: {
        select: {
          leaderboard: {
            select: {
              id: true,
              maxScore: true,
              duration: true,
              difficultyName: true,
              modeName: true,
              map: { select: { hash: true, duration: true } },
            },
          },
        },
      },
      lineups: {
        select: {
          teamId: true,
          slots: {
            orderBy: { slot: 'asc' },
            select: { player: { select: { id: true, name: true, beatLeaderId: true } } },
          },
        },
      },
    },
  });
  if (!matchMap) return null;

  const stored = (matchMap.match.tournament.scorePull ?? {}) as { toleranceSeconds?: number };
  const players = new Map<string, { name: string; beatLeaderId: string }>();
  for (const lineup of matchMap.lineups) {
    for (const slot of lineup.slots) players.set(slot.player.id, { name: slot.player.name, beatLeaderId: slot.player.beatLeaderId });
  }
  const lb = matchMap.poolMap.leaderboard;
  return {
    matchId,
    matchMapId,
    teamAId: matchMap.match.teamAId,
    teamBId: matchMap.match.teamBId,
    leaderboardId: lb.id,
    maxScore: lb.maxScore,
    duration: lb.duration || lb.map.duration,
    attempt: 1 + matchMap.replayCalledByTeamIds.length,
    since: Math.floor(matchMap.runOpenedAt.getTime() / 1000),
    closed: matchMap.scoresClosedAt != null,
    lineups: matchMap.lineups.map((l) => ({ teamId: l.teamId, playerIds: l.slots.map((s) => s.player.id) })),
    players,
    hash: lb.map.hash,
    difficultyName: lb.difficultyName,
    modeName: lb.modeName,
    options: {
      toleranceSeconds:
        typeof stored.toleranceSeconds === 'number' ? stored.toleranceSeconds : DEFAULT_TOLERANCE_SECONDS,
    },
  };
}

/**
 * Every fielded player's runs on the map, as BeatLeader has them. For a
 * player who keeps their stats private, their leaderboard score stands in:
 * it is what BeatLeader will say, and only when it is new is it this run.
 */
export async function fetchRuns(target: PullTarget): Promise<PlayerRuns[]> {
  return Promise.all(
    [...target.players].map(async ([playerId, player]): Promise<PlayerRuns> => {
      const attempts = await beatLeader.getPlayerMapAttempts(player.beatLeaderId, target.leaderboardId);
      // Whether their runs show is learned here as well as by the worker; the
      // teams page and the player card read it.
      await prisma.player.updateMany({
        where: { id: playerId, OR: [{ attemptsPublic: null }, { attemptsPublic: attempts === 'private' }] },
        data: { attemptsPublic: attempts !== 'private', attemptsCheckedAt: new Date() },
      });
      if (attempts !== 'private') {
        return {
          playerId,
          playerName: player.name,
          runsPublic: true,
          runs: attempts.map(
            (a): PulledRun => ({
              id: a.id,
              source: 'RUN',
              endType: (BL_END_TYPES[a.type as keyof typeof BL_END_TYPES] ?? 'UNKNOWN') as PulledEnd,
              timeset: a.timeset || a.timepost || 0,
              time: a.time,
              accuracy: a.accuracy,
              baseScore: a.baseScore,
              modifiers: a.modifiers ?? '',
              replayUrl: a.replay ?? null,
            }),
          ),
        };
      }
      const best = await beatLeader.getPlayerScore(player.beatLeaderId, target.hash, target.difficultyName, target.modeName);
      return {
        playerId,
        playerName: player.name,
        runsPublic: false,
        runs: best
          ? [
              {
                id: best.id,
                source: 'SCORE',
                endType: 'CLEAR',
                timeset: Number(best.timeset) || 0,
                time: target.duration,
                accuracy: best.accuracy,
                baseScore: best.baseScore,
                modifiers: best.modifiers ?? '',
                replayUrl: best.replay ?? null,
              },
            ]
          : [],
      };
    }),
  );
}

export function choose(target: PullTarget, runs: PlayerRuns[]): PullResult {
  return pickMatchRuns(runs, {
    since: target.since,
    duration: target.duration || undefined,
    ...target.options,
  });
}

/**
 * Write the chosen runs in as this map's scores, for every side each player
 * is fielded on. The score is what the run scored; for a fail that is the
 * points it had when it ended, which is what the player scored in the match.
 *
 * A score someone typed in is theirs to change: a pull never overwrites one.
 * Returns the players actually written.
 */
export async function writeRuns(
  target: PullTarget,
  chosen: ReadonlyArray<{ playerId: string; run: PulledRun }>,
): Promise<string[]> {
  const typed = await prisma.matchMapAttempt.findMany({
    where: { matchMapId: target.matchMapId, attempt: target.attempt, source: 'MANUAL' },
    select: { teamId: true, playerId: true },
  });
  const isTyped = (teamId: string, playerId: string) => typed.some((t) => t.teamId === teamId && t.playerId === playerId);
  const written = new Set<string>();
  const writes = [];
  for (const { playerId, run } of chosen) {
    const score = Math.max(0, Math.round(run.baseScore));
    const accuracy = target.maxScore > 0 ? Math.min(1, score / target.maxScore) : run.accuracy;
    for (const lineup of target.lineups) {
      if (!lineup.playerIds.includes(playerId) || isTyped(lineup.teamId, playerId)) continue;
      written.add(playerId);
      const data = {
        score,
        accuracy,
        source: 'AUTO',
        beatLeaderScoreId: run.source === 'SCORE' ? run.id : null,
        beatLeaderAttemptId: run.source === 'RUN' ? run.id : null,
        endType: run.endType,
        timeset: run.timeset,
        replayUrl: run.replayUrl,
      };
      writes.push(
        prisma.matchMapAttempt.upsert({
          where: {
            matchMapId_teamId_playerId_attempt: {
              matchMapId: target.matchMapId,
              teamId: lineup.teamId,
              playerId,
              attempt: target.attempt,
            },
          },
          create: { matchMapId: target.matchMapId, teamId: lineup.teamId, playerId, attempt: target.attempt, ...data },
          update: data,
        }),
      );
    }
  }
  await prisma.$transaction(writes);
  return [...written];
}

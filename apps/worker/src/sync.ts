import { prisma } from '@bscs/db';
import {
  BeatLeaderClient,
  difficultyName,
  modeName,
  type BLScore,
} from '@bscs/core/beatleader';
import { hasScoreAlteringModifier, mapLimit } from '@bscs/core';
import { config } from './config.js';
import { log } from './log.js';
import { CHANNELS, publish, type ScoreUpdate } from './bus.js';

export const client = new BeatLeaderClient({
  baseUrl: config.BEATLEADER_API_URL,
  concurrency: config.BEATLEADER_CONCURRENCY,
});

/**
 * Everything the app is currently watching: one row per (player, leaderboard)
 * that appears in some pool alongside a player on some team.
 *
 * This is the set the poller walks and the set the live socket filters against.
 */
export interface TrackedPair {
  playerId: string;
  beatLeaderId: string;
  playerName: string;
  leaderboardId: string;
  hash: string;
  difficultyName: string;
  modeName: string;
}

export async function loadTrackedPairs(poolId?: string): Promise<TrackedPair[]> {
  const poolMaps = await prisma.poolMap.findMany({
    where: poolId ? { poolId } : undefined,
    select: {
      poolId: true,
      leaderboard: {
        select: {
          id: true,
          difficultyName: true,
          modeName: true,
          map: { select: { hash: true } },
        },
      },
      pool: { select: { tournamentId: true } },
    },
  });
  if (!poolMaps.length) return [];

  const tournamentIds = [...new Set(poolMaps.map((pm) => pm.pool.tournamentId))];

  // Players on any team in the same tournament as the pool.
  const members = await prisma.teamMember.findMany({
    where: { team: { division: { tournamentId: { in: tournamentIds } } } },
    select: {
      player: { select: { id: true, beatLeaderId: true, name: true } },
      team: { select: { division: { select: { tournamentId: true } } } },
    },
  });

  const byTournament = new Map<string, Map<string, TrackedPair['playerId']>>();
  const playerDetails = new Map<string, { beatLeaderId: string; name: string }>();

  for (const member of members) {
    const tournamentId = member.team.division.tournamentId;
    const set = byTournament.get(tournamentId) ?? new Map();
    set.set(member.player.id, member.player.id);
    byTournament.set(tournamentId, set);
    playerDetails.set(member.player.id, {
      beatLeaderId: member.player.beatLeaderId,
      name: member.player.name,
    });
  }

  const pairs: TrackedPair[] = [];
  const seen = new Set<string>();

  for (const poolMap of poolMaps) {
    const players = byTournament.get(poolMap.pool.tournamentId);
    if (!players) continue;

    for (const playerId of players.keys()) {
      const details = playerDetails.get(playerId);
      if (!details) continue;

      const key = `${playerId}::${poolMap.leaderboard.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      pairs.push({
        playerId,
        beatLeaderId: details.beatLeaderId,
        playerName: details.name,
        leaderboardId: poolMap.leaderboard.id,
        hash: poolMap.leaderboard.map.hash,
        difficultyName: poolMap.leaderboard.difficultyName,
        modeName: poolMap.leaderboard.modeName,
      });
    }
  }

  return pairs;
}

/**
 * Write a score, and say whether it actually changed anything.
 *
 * Scores only ever move up - BeatLeader reports a player's best - so a write
 * that would lower a stored score is a sign of a stale read and is ignored.
 *
 * A run with a score-altering modifier is not stored at all. The live socket
 * carries every run a player posts, practice included, and a Slower Song run
 * can out-score a clean best; once stored, "only ever move up" would then keep
 * the real best out for good. The history and the ScoreSaber side already
 * skip such runs, so this is the rule everywhere.
 */
export async function upsertScore(
  playerId: string,
  leaderboardId: string,
  score: BLScore,
): Promise<{ written: boolean; improved: boolean }> {
  if (hasScoreAlteringModifier(score.modifiers)) {
    return { written: false, improved: false };
  }

  const existing = await prisma.score.findUnique({
    where: { playerId_leaderboardId: { playerId, leaderboardId } },
    select: { baseScore: true, beatLeaderScoreId: true, modifiers: true },
  });

  if (existing && existing.beatLeaderScoreId === score.id) {
    return { written: false, improved: false };
  }
  // A modified run stored before this rule is replaced by any clean one.
  const cleanExisting = existing && !hasScoreAlteringModifier(existing.modifiers);
  if (cleanExisting && score.baseScore < existing.baseScore) {
    return { written: false, improved: false };
  }

  const data = {
    beatLeaderScoreId: score.id,
    baseScore: score.baseScore,
    modifiedScore: score.modifiedScore ?? score.baseScore,
    accuracy: score.accuracy ?? 0,
    pp: score.pp ?? 0,
    accPP: score.accPP ?? 0,
    passPP: score.passPP ?? 0,
    techPP: score.techPP ?? 0,
    rank: score.rank ?? 0,
    modifiers: score.modifiers ?? '',
    missedNotes: score.missedNotes ?? 0,
    badCuts: score.badCuts ?? 0,
    bombCuts: score.bombCuts ?? 0,
    wallsHit: score.wallsHit ?? 0,
    pauses: score.pauses ?? 0,
    fullCombo: score.fullCombo ?? false,
    maxCombo: score.maxCombo ?? 0,
    accLeft: score.accLeft ?? 0,
    accRight: score.accRight ?? 0,
    hmd: score.hmd ?? 0,
    controller: score.controller ?? 0,
    platform: score.platform ?? null,
    replayUrl: score.replay ?? null,
    timeset: Number(score.timeset ?? 0) || 0,
    fetchedAt: new Date(),
  };

  await prisma.score.upsert({
    where: { playerId_leaderboardId: { playerId, leaderboardId } },
    create: { playerId, leaderboardId, ...data },
    update: data,
  });

  // Append-only history. The REST API only exposes a current best, so this is
  // the only record of how a score got there.
  await prisma.scoreEvent
    .create({
      data: {
        playerId,
        leaderboardId,
        beatLeaderScoreId: score.id,
        baseScore: score.baseScore,
        accuracy: score.accuracy ?? 0,
        modifiers: score.modifiers ?? '',
        missedNotes: score.missedNotes ?? 0,
        fullCombo: score.fullCombo ?? false,
        replayUrl: score.replay ?? null,
        timeset: Number(score.timeset ?? 0) || 0,
      },
    })
    .catch(() => {
      // Unique on (player, leaderboard, scoreId): seeing the same score from
      // both the socket and a poll is expected, not an error.
    });

  return { written: true, improved: !cleanExisting || score.baseScore > existing.baseScore };
}

/** Fetch and store one tracked pair. */
export async function syncPair(pair: TrackedPair): Promise<boolean> {
  const score = await client.getPlayerScore(
    pair.beatLeaderId,
    pair.hash,
    pair.difficultyName,
    pair.modeName,
  );
  if (!score) return false;

  const { written, improved } = await upsertScore(pair.playerId, pair.leaderboardId, score);
  if (!written) return false;

  const update: ScoreUpdate = {
    playerId: pair.playerId,
    playerName: pair.playerName,
    leaderboardId: pair.leaderboardId,
    baseScore: score.baseScore,
    accuracy: score.accuracy ?? 0,
    improved,
    source: 'poll',
    at: Date.now(),
  };
  await publish(CHANNELS.scoreUpdate, update);
  return true;
}

export async function syncAll(poolId?: string): Promise<{ checked: number; written: number }> {
  const pairs = await loadTrackedPairs(poolId);
  if (!pairs.length) return { checked: 0, written: 0 };

  let written = 0;
  await mapLimit(pairs, config.BEATLEADER_CONCURRENCY, async (pair) => {
    try {
      if (await syncPair(pair)) written++;
    } catch (err) {
      log.warn(`sync failed for ${pair.playerName} on ${pair.leaderboardId}`, err);
    }
  });

  return { checked: pairs.length, written };
}

export { difficultyName, modeName };

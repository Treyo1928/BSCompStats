import { prisma, type AttemptEnd } from '@bscs/db';
import { BL_END_TYPES, type BLAttempt } from '@bscs/core/beatleader';
import { client } from './sync.js';
import { log } from './log.js';

/**
 * The runs behind the leaderboard: fails, restarts, quits and every clear,
 * for players who show their stats publicly on BeatLeader.
 *
 * A leaderboard only ever shows a player's best clear, so a map they have
 * tried ten times and never finished looks exactly like one they have never
 * opened. BeatLeader records every run the mod uploads, but serves them only
 * where the player has turned on "show my stats publicly" - to anyone at all
 * then, and to nobody otherwise, our OAuth sign-in included (its stats
 * endpoints read BeatLeader's own session, not an OAuth token).
 *
 * So each rostered player is asked, one pool map at a time. A 401 on the first
 * map settles it for that player until tomorrow. Records are immutable, keyed
 * by BeatLeader's id, so a sync is an insert of whatever is new.
 */

const HOUR = 60 * 60 * 1000;
/** How often a player who shows their runs is re-read. */
const SYNC_EVERY = 2 * HOUR;
/** How often a player who does not is asked again - the setting is theirs to flip. */
const RECHECK_EVERY = 24 * HOUR;

export interface AttemptSyncOptions {
  /** Only these players, and now, whatever the schedule says. */
  playerIds?: string[];
  force?: boolean;
}

export async function syncAttempts(
  options: AttemptSyncOptions = {},
): Promise<{ players: number; written: number; hidden: number }> {
  const now = Date.now();
  const players = await prisma.player.findMany({
    where: {
      ...(options.playerIds ? { id: { in: options.playerIds } } : { teamMembers: { some: {} } }),
    },
    select: {
      id: true,
      name: true,
      beatLeaderId: true,
      attemptsPublic: true,
      attemptsCheckedAt: true,
      attemptsSyncedAt: true,
    },
  });

  const due = players.filter((p) => {
    if (options.force) return true;
    if (p.attemptsPublic === false) {
      return !p.attemptsCheckedAt || now - p.attemptsCheckedAt.getTime() > RECHECK_EVERY;
    }
    return !p.attemptsSyncedAt || now - p.attemptsSyncedAt.getTime() > SYNC_EVERY;
  });
  if (due.length === 0) return { players: 0, written: 0, hidden: 0 };

  // Every map in any pool: the runs worth having are on maps people are
  // preparing for. Their history elsewhere is another matter and another size.
  const poolMaps = await prisma.poolMap.findMany({
    select: { leaderboardId: true },
    distinct: ['leaderboardId'],
  });
  const leaderboardIds = poolMaps.map((m) => m.leaderboardId);

  let synced = 0;
  let written = 0;
  let hidden = 0;

  for (const player of due) {
    try {
      let visible: boolean | null = null;
      for (const leaderboardId of leaderboardIds) {
        const result = await client.getPlayerMapAttempts(player.beatLeaderId, leaderboardId);
        if (result === 'private') {
          visible = false;
          break;
        }
        visible = true;
        written += await storeAttempts(player.id, leaderboardId, result);
      }

      if (visible === false) {
        hidden++;
        await prisma.player.update({
          where: { id: player.id },
          data: { attemptsPublic: false, attemptsCheckedAt: new Date() },
        });
      } else {
        synced++;
        await prisma.player.update({
          where: { id: player.id },
          data: {
            // No pool maps at all leaves visibility unknown, not proven.
            attemptsPublic: visible,
            attemptsCheckedAt: new Date(),
            attemptsSyncedAt: new Date(),
          },
        });
      }
    } catch (err) {
      log.warn(`attempts sync failed for ${player.name}`, err);
    }
  }

  return { players: synced, written, hidden };
}

async function storeAttempts(playerId: string, leaderboardId: string, attempts: BLAttempt[]): Promise<number> {
  if (attempts.length === 0) return 0;
  const rows = attempts
    .filter((a) => Number.isFinite(a.id) && a.accuracy >= 0 && a.accuracy <= 1)
    .map((a) => ({
      playerId,
      leaderboardId,
      beatLeaderAttemptId: a.id,
      endType: (BL_END_TYPES[a.type as keyof typeof BL_END_TYPES] ?? 'UNKNOWN') as AttemptEnd,
      time: a.time,
      accuracy: a.accuracy,
      baseScore: a.baseScore,
      modifiers: a.modifiers ?? '',
      missedNotes: a.missedNotes ?? 0,
      badCuts: a.badCuts ?? 0,
      replayUrl: a.replay ?? null,
      timeset: a.timeset || a.timepost || 0,
    }));
  const { count } = await prisma.attempt.createMany({ data: rows, skipDuplicates: true });
  return count;
}

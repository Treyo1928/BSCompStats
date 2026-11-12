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
 * by BeatLeader's id, so a sync is an insert of whatever is new (plus the
 * full-combo flag on runs stored before it was kept).
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
      if (visible) await resolveModifiers(player.id);

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
      beatLeaderScoreId: a.scoreId && a.scoreId > 0 ? a.scoreId : null,
      endType: (BL_END_TYPES[a.type as keyof typeof BL_END_TYPES] ?? 'UNKNOWN') as AttemptEnd,
      time: a.time,
      accuracy: a.accuracy,
      baseScore: a.baseScore,
      modifiers: a.modifiers ?? '',
      missedNotes: a.missedNotes ?? 0,
      badCuts: a.badCuts ?? 0,
      fullCombo: typeof a.fullCombo === 'boolean' ? a.fullCombo : null,
      replayUrl: a.replay ?? null,
      timeset: a.timeset || a.timepost || 0,
    }));
  const { count } = await prisma.attempt.createMany({ data: rows, skipDuplicates: true });
  // Records never change, but ones stored before the full-combo flag was kept lack it: fill it in.
  for (const fullCombo of [true, false]) {
    const ids = rows.filter((r) => r.fullCombo === fullCombo).map((r) => r.beatLeaderAttemptId);
    if (ids.length === 0) continue;
    await prisma.attempt.updateMany({ where: { beatLeaderAttemptId: { in: ids }, fullCombo: null }, data: { fullCombo } });
  }
  // Likewise the score a clear became.
  const linked = rows.filter((r) => r.beatLeaderScoreId != null);
  if (linked.length > 0) {
    const missing = await prisma.attempt.findMany({
      where: { beatLeaderAttemptId: { in: linked.map((r) => r.beatLeaderAttemptId) }, beatLeaderScoreId: null },
      select: { beatLeaderAttemptId: true },
    });
    const scoreOf = new Map(linked.map((r) => [r.beatLeaderAttemptId, r.beatLeaderScoreId]));
    for (const { beatLeaderAttemptId } of missing) {
      await prisma.attempt.update({ where: { beatLeaderAttemptId }, data: { beatLeaderScoreId: scoreOf.get(beatLeaderAttemptId) } });
    }
  }
  return count;
}

/**
 * BeatLeader leaves a run's modifiers off its record - No Fail kicking in, Pro
 * Mode, a slower song, all of it - though the score the run became has them.
 * So a clear's modifiers are read from that score once: from the scores
 * already stored where one is, else from BeatLeader. A run that never became a
 * score keeps an empty, unchecked list.
 */
async function resolveModifiers(playerId: string): Promise<void> {
  const open = await prisma.attempt.findMany({
    where: { playerId, endType: 'CLEAR', modifiersChecked: false, beatLeaderScoreId: { not: null } },
    select: { id: true, beatLeaderScoreId: true },
  });
  if (open.length === 0) return;
  const scoreIds = open.map((a) => a.beatLeaderScoreId!);
  const query = { where: { beatLeaderScoreId: { in: scoreIds } }, select: { beatLeaderScoreId: true, modifiers: true } };
  const stored = [...(await prisma.scoreEvent.findMany(query)), ...(await prisma.score.findMany(query))];
  const known = new Map<number, string>();
  for (const r of stored) if (r.beatLeaderScoreId != null) known.set(r.beatLeaderScoreId, r.modifiers);
  for (const attempt of open) {
    const scoreId = attempt.beatLeaderScoreId!;
    let modifiers = known.get(scoreId);
    if (modifiers === undefined) {
      try {
        const score = await client.getScore(String(scoreId));
        if (!score) {
          // Gone from BeatLeader: nothing more will be learned, so it is settled as it stands.
          await prisma.attempt.update({ where: { id: attempt.id }, data: { modifiersChecked: true } });
          continue;
        }
        modifiers = score.modifiers ?? '';
      } catch (err) {
        log.warn(`attempts: could not read score ${scoreId}; trying again next sync`, err);
        return;
      }
    }
    await prisma.attempt.update({ where: { id: attempt.id }, data: { modifiers, modifiersChecked: true } });
  }
}

import { prisma, type AttemptEnd } from '@bscs/db';
import { BL_END_TYPES, readReplayInfo, type BLAttempt, type ReplayInfo } from '@bscs/core/beatleader';
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
      if (visible) await resolveModifiers(player.id, player.beatLeaderId);

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
 * Mode, a slower song, all of it. A clear's are read once: from the score it
 * became, where that is stored here, else from the start of its replay, which
 * is where BeatLeader reads a score's own from, else from BeatLeader's copy of
 * the score. Most clears never became a score (only a new best does), so the
 * replay is the usual source.
 */
async function resolveModifiers(playerId: string, beatLeaderId: string): Promise<void> {
  const open = await prisma.attempt.findMany({
    where: { playerId, endType: 'CLEAR', modifiersChecked: false },
    select: { id: true, beatLeaderScoreId: true, baseScore: true, replayUrl: true },
  });
  if (open.length === 0) return;
  const scoreIds = open.flatMap((a) => (a.beatLeaderScoreId != null ? [a.beatLeaderScoreId] : []));
  const query = { where: { beatLeaderScoreId: { in: scoreIds } }, select: { beatLeaderScoreId: true, modifiers: true } };
  const stored = scoreIds.length ? [...(await prisma.scoreEvent.findMany(query)), ...(await prisma.score.findMany(query))] : [];
  const known = new Map<number, string>();
  for (const r of stored) if (r.beatLeaderScoreId != null) known.set(r.beatLeaderScoreId, r.modifiers);

  for (const attempt of open) {
    let modifiers = attempt.beatLeaderScoreId != null ? known.get(attempt.beatLeaderScoreId) : undefined;
    if (modifiers === undefined && attempt.replayUrl) {
      let info: ReplayInfo | null | 'gone';
      try {
        info = await readReplayStart(attempt.replayUrl);
      } catch (err) {
        log.warn(`attempts: could not read replay ${attempt.replayUrl}; trying again next sync`, err);
        return;
      }
      if (info && info !== 'gone' && replayIsRun(info, beatLeaderId, attempt.baseScore)) modifiers = info.modifiers;
    }
    if (modifiers === undefined && attempt.beatLeaderScoreId != null) {
      try {
        const score = await client.getScore(String(attempt.beatLeaderScoreId));
        if (score) modifiers = score.modifiers ?? '';
      } catch (err) {
        log.warn(`attempts: could not read score ${attempt.beatLeaderScoreId}; trying again next sync`, err);
        return;
      }
    }
    if (modifiers === undefined) log.warn(`attempts: no modifiers to be had for run ${attempt.id}; left unknown`);
    await prisma.attempt.update({
      where: { id: attempt.id },
      data: modifiers === undefined ? { modifiersChecked: true } : { modifiers, modifiersChecked: true },
    });
  }
}

/**
 * Whether a replay is this run's. BeatLeader re-scores old replays, so the
 * header's score can be a few points off the run's: same player and within 1%.
 */
function replayIsRun(info: ReplayInfo, beatLeaderId: string, baseScore: number): boolean {
  return info.playerId === beatLeaderId && Math.abs(info.score - baseScore) <= Math.max(1, baseScore) * 0.01;
}

/** Replays run to megabytes; the info section is in the first few hundred bytes. */
const REPLAY_HEAD_BYTES = 4096;

/**
 * The info section of a replay, reading only as much of the file as that takes
 * (BeatLeader ignores range requests, so the download is cut short instead).
 * 'gone' where BeatLeader no longer has it; null where it is not a replay.
 */
async function readReplayStart(url: string): Promise<ReplayInfo | null | 'gone'> {
  const res = await fetch(url, { headers: { 'User-Agent': 'BSCompStats' }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const head = new Uint8Array(REPLAY_HEAD_BYTES);
  let filled = 0;
  try {
    while (filled < REPLAY_HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, REPLAY_HEAD_BYTES - filled);
      head.set(value.subarray(0, take), filled);
      filled += take;
      const info = readReplayInfo(head.subarray(0, filled));
      if (info) return info;
    }
    return readReplayInfo(head.subarray(0, filled));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

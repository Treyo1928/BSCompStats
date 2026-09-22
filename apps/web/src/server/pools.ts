import { prisma } from '@bscs/db';
import {
  BeatLeaderClient,
  extractPlaylistId,
  parsePlaylist,
  resolvePlaylistEntries,
  type ResolvedMap,
} from '@bscs/core/beatleader';
import { ScoreSaberClient } from '@bscs/core/scoresaber';
import { env } from '@/lib/env';
import { fetchPublicJson } from './safe-fetch';

export const beatLeader = new BeatLeaderClient({
  baseUrl: env.BEATLEADER_API_URL,
  concurrency: 4,
});

/** One client, so the gap between ScoreSaber requests holds across actions rather than per call. */
export const scoreSaber = new ScoreSaberClient();

export interface ImportResult {
  poolId: string;
  imported: number;
  failed: Array<{ hash: string; songName?: string; reason: string }>;
  skipped: Array<{ songName?: string; reason: string }>;
  title?: string;
}

/**
 * Import a map pool from a BeatLeader playlist link, a ScoreSaber playlist, or
 * a `.bplist` file.
 *
 * The three sources converge quickly: every one of them ultimately names a map
 * hash plus a difficulty, and from there the BeatLeader leaderboard id is
 * derived arithmetically rather than looked up. That is why this costs one API
 * call per song rather than one per difficulty.
 */
export async function importPool(options: {
  tournamentId: string;
  name: string;
  source: string;
  /** Raw playlist JSON, when the user uploaded a file instead of a link. */
  rawPlaylist?: unknown;
}): Promise<ImportResult> {
  let playlistJson: unknown = options.rawPlaylist;
  let sourceType = 'upload';
  let sourceRef = options.name;

  if (!playlistJson) {
    const playlistId = extractPlaylistId(options.source);
    if (playlistId) {
      sourceType = 'beatleader';
      sourceRef = playlistId;
      playlistJson = await beatLeader.getPlaylist(playlistId);
      if (!playlistJson) {
        throw new Error(`BeatLeader has no playlist ${playlistId}.`);
      }
    } else {
      // Any URL that serves a bplist - ScoreSaber, a Discord attachment, a
      // self-hosted file. Nothing here is BeatLeader-specific.
      const url = options.source.trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(
          'Paste a BeatLeader playlist link, a direct link to a .bplist file, or upload the file.',
        );
      }
      sourceType = 'url';
      sourceRef = url;
      try {
        playlistJson = await fetchPublicJson(url, 25 * 1024 * 1024);
      } catch {
        // Deliberately vague: the status of an arbitrary URL, fetched from
        // inside the server's network, is not something to report back.
        throw new Error('Could not fetch a playlist from that link.');
      }
    }
  }

  const parsed = parsePlaylist(playlistJson);
  if (!parsed.entries.length) {
    throw new Error(
      parsed.skipped.length
        ? `No usable maps. ${parsed.skipped[0]!.reason}.`
        : 'That playlist has no maps in it.',
    );
  }

  const { resolved, failed } = await resolvePlaylistEntries(beatLeader, parsed.entries);

  const pool = await prisma.mapPool.upsert({
    where: {
      tournamentId_name: { tournamentId: options.tournamentId, name: options.name },
    },
    create: {
      tournamentId: options.tournamentId,
      name: options.name,
      sourceType,
      sourceRef,
    },
    update: { sourceType, sourceRef },
  });

  await persistMaps(resolved);

  // Replace the pool's contents rather than merging: re-importing a playlist
  // should mean "this is the pool now", including removals.
  //
  // Except maps a match has already picked, banned or played: those rows
  // cascade into the match record, so removing one would quietly erase
  // finished matches. They stay in the pool instead.
  await prisma.poolMap.deleteMany({
    where: {
      poolId: pool.id,
      leaderboardId: { notIn: resolved.map((r) => r.leaderboard.id) },
      matchMaps: { none: {} },
      bans: { none: {} },
    },
  });

  let order = 0;
  for (const item of resolved) {
    // Once, not in both branches: both are evaluated when the argument is built.
    const position = order++;
    await prisma.poolMap.upsert({
      where: {
        poolId_leaderboardId: { poolId: pool.id, leaderboardId: item.leaderboard.id },
      },
      create: {
        poolId: pool.id,
        leaderboardId: item.leaderboard.id,
        order: position,
      },
      update: { order: position },
    });
  }

  return {
    poolId: pool.id,
    imported: resolved.length,
    failed,
    skipped: parsed.skipped,
    title: parsed.title,
  };
}

/** Write maps and leaderboards, leaving anything already stored up to date. */
export async function persistMaps(resolved: readonly ResolvedMap[]): Promise<void> {
  for (const item of resolved) {
    await prisma.beatMap.upsert({
      where: { id: item.map.id },
      create: item.map,
      update: item.map,
    });

    const { mapId: _mapId, id, ...rest } = item.leaderboard;
    await prisma.leaderboard.upsert({
      where: { id },
      create: item.leaderboard,
      update: rest,
    });
  }
}

/** Add a single map to a pool by BeatSaver/BeatLeader hash or leaderboard id. */
export async function addMapToPool(
  poolId: string,
  hash: string,
  difficultyValue: number,
  mode = 1,
): Promise<string> {
  const song = await beatLeader.getMapByHash(hash);
  if (!song) throw new Error('BeatLeader does not know that map hash.');

  const difficulty = song.difficulties?.find(
    (d) => d.value === difficultyValue && d.mode === mode,
  );
  if (!difficulty) throw new Error('That map has no such difficulty.');

  const { toResolvedMap } = await import('@bscs/core/beatleader');
  const resolved = toResolvedMap(song, difficulty);
  await persistMaps([resolved]);

  const count = await prisma.poolMap.count({ where: { poolId } });
  await prisma.poolMap.upsert({
    where: { poolId_leaderboardId: { poolId, leaderboardId: resolved.leaderboard.id } },
    create: { poolId, leaderboardId: resolved.leaderboard.id, order: count },
    update: {},
  });

  return resolved.leaderboard.id;
}

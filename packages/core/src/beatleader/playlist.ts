import { z } from 'zod';
import type { BLDifficulty, BLSong, BPList } from './types.js';
import {
  makeLeaderboardId,
  normalizeHash,
  parseDifficulty,
  parseMode,
} from './ids.js';
import type { BeatLeaderClient } from './client.js';
import { mapLimit } from '../util/limit.js';

/**
 * A playlist entry reduced to what identifies a leaderboard. Playlists name a
 * difficulty by text ("expertPlus") and a characteristic ("Standard"); the
 * leaderboard id is derived once the song's BeatLeader id is known.
 */
export interface PlaylistEntry {
  hash: string;
  difficultyValue: number;
  mode: number;
  /** Only for error messages - the API is authoritative for the real name. */
  songNameHint?: string;
}

const bpListSchema = z.object({
  playlistTitle: z.string().optional(),
  playlistAuthor: z.string().optional(),
  playlistDescription: z.string().optional(),
  songs: z
    .array(
      z.object({
        hash: z.string().optional(),
        key: z.string().optional(),
        songName: z.string().optional(),
        levelAuthorName: z.string().optional(),
        difficulties: z
          .array(
            z.object({
              name: z.string(),
              characteristic: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
});

export interface ParsedPlaylist {
  title?: string;
  author?: string;
  description?: string;
  entries: PlaylistEntry[];
  /** Songs we could not use, with the reason, so the import UI can show them. */
  skipped: Array<{ songName?: string; reason: string }>;
}

/**
 * Parse a `.bplist` / BeatLeader playlist payload.
 *
 * A song with no `difficulties` array means "every difficulty", which we cannot
 * resolve without knowing the map - those are reported in `skipped` rather than
 * silently dropped, because a pool that quietly loses a map is worse than one
 * that refuses to import.
 */
export function parsePlaylist(raw: unknown): ParsedPlaylist {
  const parsed = bpListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Not a valid playlist file: ${parsed.error.issues[0]?.message}`);
  }
  // `image` is intentionally ignored - BeatLeader embeds a multi-megabyte
  // base64 cover in it and nothing here needs it.
  const data = parsed.data as BPList;

  const entries: PlaylistEntry[] = [];
  const skipped: ParsedPlaylist['skipped'] = [];
  const seen = new Set<string>();

  for (const song of data.songs) {
    if (!song.hash) {
      skipped.push({ songName: song.songName, reason: 'no map hash in playlist' });
      continue;
    }
    const hash = normalizeHash(song.hash);

    if (!song.difficulties?.length) {
      skipped.push({
        songName: song.songName,
        reason: 'playlist did not say which difficulty to use',
      });
      continue;
    }

    for (const diff of song.difficulties) {
      const difficultyValue = parseDifficulty(diff.name);
      const mode = parseMode(diff.characteristic);

      if (difficultyValue === null) {
        skipped.push({
          songName: song.songName,
          reason: `unrecognised difficulty "${diff.name}"`,
        });
        continue;
      }
      if (mode === null) {
        skipped.push({
          songName: song.songName,
          reason: `unrecognised characteristic "${diff.characteristic}"`,
        });
        continue;
      }

      const key = `${hash}:${difficultyValue}:${mode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      entries.push({
        hash,
        difficultyValue,
        mode,
        songNameHint: song.songName,
      });
    }
  }

  return {
    title: data.playlistTitle,
    author: data.playlistAuthor,
    description: data.playlistDescription,
    entries,
    skipped,
  };
}

/** Everything needed to persist one pool map. */
export interface ResolvedMap {
  map: {
    id: string;
    hash: string;
    name: string;
    subName: string | null;
    author: string | null;
    mapper: string | null;
    bpm: number;
    duration: number;
    coverImage: string | null;
    downloadUrl: string | null;
    uploadTime: number;
  };
  leaderboard: {
    id: string;
    mapId: string;
    difficultyValue: number;
    difficultyName: string;
    mode: number;
    modeName: string;
    customName: string | null;
    maxScore: number;
    status: number;
    ranked: boolean;
    stars: number;
    accRating: number;
    passRating: number;
    techRating: number;
    predictedAcc: number;
    njs: number;
    nps: number;
    notes: number;
    bombs: number;
    walls: number;
    chains: number;
    sliders: number;
    duration: number;
    peakEBPM: number;
    speedTags: number;
    styleTags: number;
    featureTags: number;
  };
}

export interface ResolveResult {
  resolved: ResolvedMap[];
  failed: Array<{ hash: string; songName?: string; reason: string }>;
}

/**
 * Turn playlist entries into map + leaderboard rows.
 *
 * One request per *song* (not per difficulty), because the leaderboard id is
 * derived arithmetically rather than looked up. Songs appearing at several
 * difficulties therefore cost a single call.
 */
export async function resolvePlaylistEntries(
  client: BeatLeaderClient,
  entries: readonly PlaylistEntry[],
  concurrency = 4,
): Promise<ResolveResult> {
  const uniqueHashes = [...new Set(entries.map((e) => e.hash))];

  const songs = new Map<string, BLSong | null>();
  await mapLimit(uniqueHashes, concurrency, async (hash) => {
    songs.set(hash, await client.getMapByHash(hash));
  });

  const resolved: ResolvedMap[] = [];
  const failed: ResolveResult['failed'] = [];

  for (const entry of entries) {
    const song = songs.get(entry.hash) ?? null;
    if (!song) {
      failed.push({
        hash: entry.hash,
        songName: entry.songNameHint,
        reason: 'BeatLeader does not know this map hash',
      });
      continue;
    }

    const difficulty = song.difficulties?.find(
      (d) => d.value === entry.difficultyValue && d.mode === entry.mode,
    );
    if (!difficulty) {
      failed.push({
        hash: entry.hash,
        songName: song.name ?? entry.songNameHint,
        reason: `map has no ${entry.difficultyValue}/${entry.mode} difficulty`,
      });
      continue;
    }

    resolved.push(toResolvedMap(song, difficulty));
  }

  return { resolved, failed };
}

export function toResolvedMap(song: BLSong, difficulty: BLDifficulty): ResolvedMap {
  const leaderboardId = makeLeaderboardId(song.id, difficulty.value, difficulty.mode);

  return {
    map: {
      id: song.id,
      hash: normalizeHash(song.hash),
      name: song.name,
      subName: song.subName || null,
      author: song.author || null,
      mapper: song.mapper || null,
      bpm: song.bpm ?? 0,
      duration: song.duration ?? 0,
      coverImage: song.coverImage || null,
      downloadUrl: song.downloadUrl || null,
      uploadTime: song.uploadTime ?? 0,
    },
    leaderboard: {
      id: leaderboardId,
      mapId: song.id,
      difficultyValue: difficulty.value,
      difficultyName: difficulty.difficultyName,
      mode: difficulty.mode,
      modeName: difficulty.modeName,
      customName: difficulty.customDifficultyName || null,
      maxScore: difficulty.maxScore ?? 0,
      status: difficulty.status ?? 0,
      // status 3 is "ranked"; tournament pools are usually 0 (unranked) or 5.
      ranked: difficulty.status === 3,
      stars: num(difficulty.stars),
      accRating: num(difficulty.accRating),
      passRating: num(difficulty.passRating),
      techRating: num(difficulty.techRating),
      predictedAcc: num(difficulty.predictedAcc),
      njs: num(difficulty.njs),
      nps: num(difficulty.nps),
      notes: int(difficulty.notes),
      bombs: int(difficulty.bombs),
      walls: int(difficulty.walls),
      chains: int(difficulty.chains),
      sliders: int(difficulty.sliders),
      duration: int(difficulty.duration) || (song.duration ?? 0),
      peakEBPM: num(difficulty.peakSustainedEBPM),
      speedTags: int(difficulty.speedTags),
      styleTags: int(difficulty.styleTags),
      featureTags: int(difficulty.featureTags),
    },
  };
}

const num = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const int = (v: number | null | undefined): number => Math.round(num(v));

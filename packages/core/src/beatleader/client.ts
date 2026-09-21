import type {
  BLLeaderboardPage,
  BLPlayer,
  BLScore,
  BLSong,
  BPList,
} from './types.js';
import { normalizeHash } from './ids.js';
import { createLimiter, sleep } from '../util/limit.js';

export interface BeatLeaderClientOptions {
  baseUrl?: string;
  /** Simultaneous in-flight requests. Default 4 - be a good API citizen. */
  concurrency?: number;
  /** Retries on 429 / 5xx before giving up. */
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class BeatLeaderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'BeatLeaderError';
  }
}

export class BeatLeaderClient {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly limit: ReturnType<typeof createLimiter>;

  constructor(options: BeatLeaderClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.beatleader.com').replace(/\/$/, '');
    this.maxRetries = options.maxRetries ?? 4;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.doFetch = options.fetchImpl ?? fetch;
    this.limit = createLimiter(options.concurrency ?? 4);
  }

  /**
   * Returns null on 404 so callers can treat "no score yet" as an ordinary
   * outcome instead of an exception - it is by far the common case when a pool
   * has just been imported.
   */
  private async get<T>(path: string): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;

    return this.limit(async () => {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        let res: Response;
        try {
          res = await this.doFetch(url, {
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { accept: 'application/json' },
          });
        } catch (err) {
          if (attempt === this.maxRetries) {
            throw new BeatLeaderError(
              `Request failed: ${(err as Error).message}`,
              0,
              url,
            );
          }
          await sleep(backoffMs(attempt));
          continue;
        }

        if (res.status === 404) return null;

        if (res.status === 429 || res.status >= 500) {
          if (attempt === this.maxRetries) {
            throw new BeatLeaderError(`HTTP ${res.status}`, res.status, url);
          }
          // Honour Retry-After when the server sends one.
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : backoffMs(attempt),
          );
          continue;
        }

        if (!res.ok) {
          throw new BeatLeaderError(`HTTP ${res.status}`, res.status, url);
        }

        return (await res.json()) as T;
      }
      return null;
    });
  }

  /**
   * Song + every difficulty, including maxScore and the rating vector. One call
   * per song resolves a whole pool entry, because leaderboard ids are derived
   * rather than looked up.
   */
  async getMapByHash(hash: string): Promise<BLSong | null> {
    return this.get<BLSong>(`/map/hash/${normalizeHash(hash)}`);
  }

  async getLeaderboard(
    leaderboardId: string,
    page = 1,
    count = 10,
  ): Promise<BLLeaderboardPage | null> {
    return this.get<BLLeaderboardPage>(
      `/leaderboard/${encodeURIComponent(leaderboardId)}?page=${page}&count=${count}`,
    );
  }

  /**
   * One player's score on one difficulty. ~3 KB, versus paginating an entire
   * leaderboard to find them - this is the workhorse of score ingestion.
   */
  async getPlayerScore(
    playerId: string,
    hash: string,
    difficultyName: string,
    modeName: string,
  ): Promise<BLScore | null> {
    return this.get<BLScore>(
      `/score/${encodeURIComponent(playerId)}/${normalizeHash(hash)}/` +
        `${encodeURIComponent(difficultyName)}/${encodeURIComponent(modeName)}`,
    );
  }

  async getPlayer(playerId: string): Promise<BLPlayer | null> {
    return this.get<BLPlayer>(`/player/${encodeURIComponent(playerId)}`);
  }

  async searchPlayers(query: string): Promise<BLPlayer[]> {
    const res = await this.get<{ data?: BLPlayer[] }>(
      `/players?search=${encodeURIComponent(query)}&count=20`,
    );
    return res?.data ?? [];
  }

  /**
   * A page of a player's scores, newest first by default. Used both for the
   * stats model (which wants their whole history) and as a cheap way to notice
   * recent activity with one request per player instead of one per map.
   */
  async getPlayerScores(
    playerId: string,
    options: { page?: number; count?: number; sortBy?: string; order?: string } = {},
  ): Promise<{ data: BLScore[]; total: number }> {
    const { page = 1, count = 100, sortBy = 'date', order = 'desc' } = options;
    const res = await this.get<{
      data?: BLScore[];
      metadata?: { total?: number };
    }>(
      `/player/${encodeURIComponent(playerId)}/scores` +
        `?page=${page}&count=${count}&sortBy=${sortBy}&order=${order}`,
    );
    return { data: res?.data ?? [], total: res?.metadata?.total ?? 0 };
  }

  /** Every score a player has, walked page by page. */
  async getAllPlayerScores(
    playerId: string,
    maxPages = 20,
  ): Promise<BLScore[]> {
    const out: BLScore[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, total } = await this.getPlayerScores(playerId, {
        page,
        count: 100,
      });
      out.push(...data);
      if (data.length < 100 || out.length >= total) break;
    }
    return out;
  }

  /**
   * Playlists come back with a multi-megabyte base64 cover embedded in
   * `image`. It is dropped here so it can never reach the database or a log.
   */
  async getPlaylist(playlistId: string): Promise<BPList | null> {
    const raw = await this.get<BPList>(`/playlist/${encodeURIComponent(playlistId)}`);
    if (!raw) return null;
    const { image: _image, ...rest } = raw;
    return rest as BPList;
  }
}

function backoffMs(attempt: number): number {
  // 500ms, 1s, 2s, 4s ... with jitter so a burst of workers does not resynchronise.
  return Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250;
}

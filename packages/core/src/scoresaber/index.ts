/**
 * ScoreSaber's public API. No key, no sign-in: anything here is what anyone
 * can read from a profile page. 400 requests a minute are allowed; this stays
 * well under by pausing between calls.
 */

export interface SSPlayer {
  id: string;
  name: string;
  country: string;
  pp: number;
  rank: number;
  countryRank: number;
  banned: boolean;
  scoreStats?: {
    rankedPlayCount: number;
    totalPlayCount: number;
    /** A percentage, 0..100. */
    averageRankedAccuracy: number;
  };
}

export interface SSPlayerBasic {
  id: string;
  name: string;
  profilePicture?: string;
  country?: string;
  pp?: number;
  rank?: number;
}

export interface SSPlayerScore {
  score: {
    baseScore: number;
    modifiedScore: number;
    pp: number;
    modifiers: string;
    fullCombo: boolean;
    missedNotes: number;
    badCuts: number;
    /** ISO date. */
    timeSet: string;
  };
  leaderboard: {
    id: number;
    songHash: string;
    songName: string;
    stars: number;
    ranked: boolean;
    maxScore: number;
    /** `difficulty` is 1 Easy .. 9 ExpertPlus - the same numbers BeatLeader uses. */
    difficulty: { difficulty: number; gameMode: string };
  };
}

/**
 * A ScoreSaber id out of whatever was pasted: a bare id, or a profile link
 * (scoresaber.com/u/7656..., with or without anything after it). Null if it
 * does not look like either.
 */
export function parseScoreSaberId(input: string): string | null {
  const text = input.trim();
  const fromUrl = /scoresaber\.com\/u\/(\d{5,20})/i.exec(text)?.[1];
  if (fromUrl) return fromUrl;
  return /^\d{5,20}$/.test(text) ? text : null;
}

/** A Steam id is 17 digits starting 7656, and is the one kind of id BeatLeader and ScoreSaber share. */
export const looksLikeSteamId = (id: string): boolean => /^7656\d{13}$/.test(id);

export class ScoreSaberClient {
  private last = 0;

  constructor(
    private readonly baseUrl = 'https://scoresaber.com/api',
    /** Minimum gap between requests. 250ms is 240 a minute, under the 400 allowed. */
    private readonly gapMs = 250,
  ) {}

  private async get<T>(path: string): Promise<T | null> {
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.last = Date.now();

    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'user-agent': 'BSCompStats', accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    // Not on ScoreSaber is an answer, not a failure.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`ScoreSaber ${response.status} for ${path}`);
    return (await response.json()) as T;
  }

  /** Players by name. ScoreSaber wants at least four characters and answers 404 for no matches. */
  async searchPlayers(query: string): Promise<SSPlayerBasic[]> {
    const res = await this.get<{ players?: SSPlayerBasic[] }>(`/players?search=${encodeURIComponent(query)}`);
    return res?.players ?? [];
  }

  getPlayer(id: string): Promise<SSPlayer | null> {
    return this.get<SSPlayer>(`/player/${encodeURIComponent(id)}/full`);
  }

  /** One page of a player's scores, newest first. 100 is the most ScoreSaber gives at once. */
  async getScores(id: string, page: number): Promise<{ scores: SSPlayerScore[]; total: number }> {
    const res = await this.get<{ playerScores?: SSPlayerScore[]; metadata?: { total?: number } }>(
      `/player/${encodeURIComponent(id)}/scores?limit=100&sort=recent&page=${page}`,
    );
    return { scores: res?.playerScores ?? [], total: res?.metadata?.total ?? 0 };
  }
}

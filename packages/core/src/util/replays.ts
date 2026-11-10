/**
 * Replays a player chose to show off on stream ("showcase replays"): what a
 * pasted link is, and how one is stored on a tournament's player.
 */

/** One stored replay. Everything but `ref` is what BeatLeader said about it, for listing. */
export interface ShowcaseReplay {
  /** What a replay viewer is given: a BeatLeader replay link, or a .bsor file's address. */
  ref: string;
  /** BeatLeader's score id, where the replay is a BeatLeader score. */
  scoreId?: string;
  song?: string;
  mapper?: string;
  difficulty?: string;
  /** 0..1 */
  accuracy?: number;
  /** The name of whoever played it. */
  player?: string;
}

export type ReplayRef = { kind: 'beatleader'; scoreId: string; ref: string } | { kind: 'file'; ref: string };

/**
 * A replay as someone pastes it: a BeatLeader replay or score link, a bare
 * score id, or the address of a .bsor file. Null for anything else.
 */
export function parseReplayRef(raw: string): ReplayRef | null {
  const text = raw.trim();
  if (!text || text.length > 500) return null;
  const id =
    /^(?:bl:)?(\d{1,12})$/i.exec(text)?.[1] ??
    /^https?:\/\/(?:www\.)?(?:replay\.)?beatleader\.(?:com|xyz|net)\/[^\s]*[?&]scoreId=(\d{1,12})(?:&|#|$)/i.exec(text)?.[1] ??
    /^https?:\/\/(?:www\.)?beatleader\.(?:com|xyz|net)\/score\/(\d{1,12})(?:[/?#]|$)/i.exec(text)?.[1] ??
    /[?&]scoreIdBL=(\d{1,12})(?:&|#|$)/i.exec(text)?.[1];
  if (id) return { kind: 'beatleader', scoreId: id, ref: `https://replay.beatleader.com/?scoreId=${id}` };
  if (/^https:\/\/[^\s?#]+\.bsor(?:\?[^\s#]*)?$/i.test(text)) return { kind: 'file', ref: text };
  return null;
}

/** Stored replays read back: anything that is not a replay is dropped. */
export function parseShowcaseReplays(stored: unknown): ShowcaseReplay[] {
  if (!Array.isArray(stored)) return [];
  const out: ShowcaseReplay[] = [];
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.ref !== 'string' || !parseReplayRef(o.ref)) continue;
    const text = (key: string) => (typeof o[key] === 'string' && o[key] ? { [key]: (o[key] as string).slice(0, 200) } : {});
    out.push({
      ref: o.ref,
      ...text('scoreId'),
      ...text('song'),
      ...text('mapper'),
      ...text('difficulty'),
      ...text('player'),
      ...(typeof o.accuracy === 'number' && Number.isFinite(o.accuracy) ? { accuracy: o.accuracy } : {}),
    });
  }
  return out;
}

/** How many replays a player may put in themself; organisers may add more. */
export const SHOWCASE_REPLAYS_PER_PLAYER = 2;
export const SHOWCASE_REPLAYS_MAX = 8;

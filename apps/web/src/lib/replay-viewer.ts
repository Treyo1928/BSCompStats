/**
 * Where replays open: the tournament's own replay viewer (ChroViewer, set by
 * REPLAY_VIEWER_URL) where there is one, else BeatLeader's. Only our own
 * viewer can show a player's chosen saber colours.
 */
export interface Sabers {
  /** "#rrggbb" */
  left: string;
  right: string;
}

/** Our viewer's address, without a trailing slash; null where the site has none. */
export function viewerBase(): string | null {
  const url = (process.env.REPLAY_VIEWER_URL ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(url) ? url : null;
}

/** The viewer settings that put a player's colours on their sabers, notes and the lights that follow them. */
export function saberSettings(sabers: Sabers | null | undefined): Record<string, unknown> | null {
  if (!sabers) return null;
  return {
    customColors: true,
    preferReplayColors: false,
    leftColor: sabers.left,
    rightColor: sabers.right,
    environmentLeftColor: sabers.left,
    environmentRightColor: sabers.right,
    environmentLeftBoostColor: sabers.left,
    environmentRightBoostColor: sabers.right,
  };
}

/**
 * A link that plays a replay: a BeatLeader score (by id) or a raw replay file.
 * `embed`: only the 3D view, starting by itself (for a frame in a page).
 * Null where there is neither a score id nor a file.
 */
export function replayHref(
  replay: { scoreId?: number | null; file?: string | null },
  options: { sabers?: Sabers | null; embed?: boolean; base?: string | null } = {},
): string | null {
  if (!replay.scoreId && !replay.file) return null;
  const base = options.base === undefined ? viewerBase() : options.base;
  if (!base) {
    return replay.scoreId
      ? `https://replay.beatleader.com/?scoreId=${replay.scoreId}`
      : `https://replay.beatleader.com/?link=${encodeURIComponent(replay.file!)}`;
  }
  const q = new URLSearchParams();
  if (replay.scoreId) q.set('scoreIdBL', String(replay.scoreId));
  else q.set('replayUrl', replay.file!);
  if (options.embed) {
    q.set('hideUI', 'true');
    q.set('autoplay', 'true');
  }
  const settings = saberSettings(options.sabers);
  if (settings) q.set('settings', JSON.stringify(settings));
  return `${base}/?${q}`;
}

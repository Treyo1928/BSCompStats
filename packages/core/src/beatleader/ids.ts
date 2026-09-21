/**
 * BeatLeader leaderboard IDs are not opaque - they are the song id with the
 * difficulty value and mode appended:
 *
 *   song "2d93e" + Expert (7) + Standard (1) -> "2d93e71"
 *   song "2d93e" + ExpertPlus (9) + Standard (1) -> "2d93e91"
 *
 * Both verified against live API responses. This is what lets a playlist
 * import resolve a whole pool with one request per *song* rather than one per
 * difficulty, and it means we never need a leaderboard-id lookup table.
 */

export const DIFFICULTY_VALUES = {
  easy: 1,
  normal: 3,
  hard: 5,
  expert: 7,
  expertPlus: 9,
} as const;

export type DifficultyKey = keyof typeof DIFFICULTY_VALUES;

export const MODE_VALUES = {
  standard: 1,
  oneSaber: 2,
  noArrows: 3,
  '90degree': 4,
  '360degree': 5,
  lightshow: 6,
  lawless: 7,
} as const;

const DIFFICULTY_NAMES: Record<number, string> = {
  1: 'Easy',
  3: 'Normal',
  5: 'Hard',
  7: 'Expert',
  9: 'ExpertPlus',
};

const MODE_NAMES: Record<number, string> = {
  1: 'Standard',
  2: 'OneSaber',
  3: 'NoArrows',
  4: '90Degree',
  5: '360Degree',
  6: 'Lightshow',
  7: 'Lawless',
};

/** Human label for a difficulty value, e.g. 9 -> "Expert+". */
export function difficultyLabel(value: number): string {
  const name = DIFFICULTY_NAMES[value];
  if (!name) return `Difficulty ${value}`;
  return name === 'ExpertPlus' ? 'Expert+' : name;
}

export function difficultyName(value: number): string {
  return DIFFICULTY_NAMES[value] ?? `Difficulty ${value}`;
}

export function modeName(value: number): string {
  return MODE_NAMES[value] ?? `Mode ${value}`;
}

/**
 * Accepts every spelling seen in the wild: playlist files use "expertPlus",
 * the API returns "ExpertPlus", and people type "Expert+" or "ex+".
 */
export function parseDifficulty(raw: string | number): number | null {
  if (typeof raw === 'number') return raw in DIFFICULTY_NAMES ? raw : null;

  const v = raw.trim().toLowerCase().replace(/[\s_-]/g, '');
  switch (v) {
    case 'easy':
    case 'e':
      return 1;
    case 'normal':
    case 'n':
      return 3;
    case 'hard':
    case 'h':
      return 5;
    case 'expert':
    case 'ex':
    case 'x':
      return 7;
    case 'expertplus':
    case 'expert+':
    case 'ex+':
    case 'x+':
    case 'exp':
      return 9;
    default: {
      const n = Number(v);
      return Number.isInteger(n) && n in DIFFICULTY_NAMES ? n : null;
    }
  }
}

export function parseMode(raw: string | number): number | null {
  if (typeof raw === 'number') return raw in MODE_NAMES ? raw : null;

  const v = raw.trim().toLowerCase().replace(/[\s_-]/g, '');
  for (const [key, value] of Object.entries(MODE_VALUES)) {
    if (key.toLowerCase() === v) return value;
  }
  // "SoloStandard" (ScoreSaber) and "Standard" both mean the same mode.
  if (v.startsWith('solo')) return parseMode(v.slice(4));
  return null;
}

/**
 * The whole point of this module: build a leaderboard id without an API call.
 */
export function makeLeaderboardId(
  songId: string,
  difficultyValue: number,
  mode: number,
): string {
  return `${songId}${difficultyValue}${mode}`;
}

/**
 * Split a leaderboard id back into its parts. The last two characters are the
 * difficulty and mode - both are single digits in every id BeatLeader issues.
 */
export function parseLeaderboardId(
  id: string,
): { songId: string; difficultyValue: number; mode: number } | null {
  const trimmed = id.trim();
  if (trimmed.length < 3) return null;

  const modeChar = trimmed.slice(-1);
  const diffChar = trimmed.slice(-2, -1);
  const songId = trimmed.slice(0, -2);

  const mode = Number(modeChar);
  const difficultyValue = Number(diffChar);

  if (!songId) return null;
  if (!Number.isInteger(mode) || !Number.isInteger(difficultyValue)) return null;
  if (!(difficultyValue in DIFFICULTY_NAMES)) return null;

  return { songId, difficultyValue, mode };
}

/**
 * Pull a leaderboard id out of whatever a person pasted: a bare id, a
 * BeatLeader leaderboard URL, or the `/leaderboard/global/<id>` variant the
 * site uses for ranked boards.
 */
export function extractLeaderboardId(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;

  const match = v.match(/leaderboard\/(?:global\/)?([A-Za-z0-9]+)/);
  if (match?.[1]) return match[1];

  return /^[A-Za-z0-9]+$/.test(v) ? v : null;
}

/** Pull a BeatSaver key out of a beatsaver.com URL, e.g. ".../maps/3185d". */
export function extractBeatSaverKey(raw: string): string | null {
  const match = raw.trim().match(/beatsaver\.com\/maps\/([A-Za-z0-9]+)/i);
  if (match?.[1]) return match[1].toLowerCase();
  return /^[a-f0-9]{1,6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

/**
 * Pull a playlist id out of a BeatLeader playlist URL or a bare number.
 * Accepts https://beatleader.com/playlist/110086 and "110086".
 */
export function extractPlaylistId(raw: string): string | null {
  const v = raw.trim();
  const match = v.match(/playlist\/(\d+)/);
  if (match?.[1]) return match[1];
  return /^\d+$/.test(v) ? v : null;
}

/** BeatLeader stores hashes uppercase in some fields, lowercase in others. */
export function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase();
}

/**
 * How a difficulty should read on screen.
 *
 * Mappers often name a difficulty after the one it sits on - BeatLeader has
 * "Safe bet (Hard)" as the custom name of a Hard - so appending the difficulty
 * unconditionally produces "Safe bet (Hard) (Hard)". Only add it when it is not
 * already in there.
 */
export function displayDifficulty(
  difficultyValue: number,
  customName?: string | null,
): string {
  const base = difficultyLabel(difficultyValue);
  const custom = customName?.trim();
  if (!custom) return base;

  const haystack = custom.toLowerCase();
  const needles = [base.toLowerCase(), difficultyName(difficultyValue).toLowerCase()];
  if (needles.some((n) => haystack.includes(n))) return custom;

  return `${custom} (${base})`;
}

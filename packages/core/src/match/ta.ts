import { z } from 'zod';

/**
 * TournamentAssistant (TA) mode.
 *
 * On match night an organiser loads a map for the players in its lineups, and
 * once they are all in their headsets with it loaded, starts the song for all
 * of them at the same moment. The worker holds the connection to TA (see
 * TaLink): it sees the request, does the TA side, and writes down how it is
 * going - which is what is checked here. That report is shown to everyone
 * watching the match, so it is held to a fixed shape and size.
 *
 * A start goes: waiting (a lineup player is not connected to TA yet) ->
 * loading (their games are fetching the map) -> ready (all loaded; waiting
 * for "Start song") -> playing -> finished. `error` ends it early; a restart
 * begins again.
 */

export const TA_PHASES = ['waiting', 'loading', 'ready', 'playing', 'finished', 'error'] as const;
export type TaPhase = (typeof TA_PHASES)[number];

/**
 * One player in a start: `missing` is not connected to TA, `failed` could not
 * load the map or failed the song, `quit` left the song before it ended.
 */
export const TA_PLAYER_STATES = ['loading', 'ready', 'playing', 'finished', 'failed', 'quit', 'missing'] as const;
export type TaPlayerState = (typeof TA_PLAYER_STATES)[number];

/** A map is played by two lineups; this is generous for any format and still small. */
export const TA_MAX_PLAYERS = 32;
export const TA_MAX_MESSAGE = 500;

const isoDate = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO date, e.g. 2026-10-29T19:30:00Z');

export const taStatusSchema = z
  .object({
    phase: z.enum(TA_PHASES),
    message: z.string().max(TA_MAX_MESSAGE).optional(),
    players: z
      .array(
        z
          .object({
            playerId: z.string().min(1).max(64),
            state: z.enum(TA_PLAYER_STATES),
            score: z.number().int().min(0).max(100_000_000).optional(),
            accuracy: z.number().min(0).max(1).optional(),
          })
          .strict(),
      )
      .max(TA_MAX_PLAYERS)
      .optional(),
    startedAt: isoDate.optional(),
  })
  .strict();

/** What the bridge reports, as it arrives. */
export type TaStatusInput = z.infer<typeof taStatusSchema>;

/** What is stored and shown: the report, plus when the site received it. */
export interface TaStatus extends TaStatusInput {
  /** Server time the report arrived, ISO. */
  reportedAt: string;
}

/**
 * Check a bridge's report. Answers the status to store, or a message naming
 * the first thing wrong with it - the bridge's author is the one reading it.
 */
export function parseTaStatus(input: unknown, now: Date = new Date()): { status: TaStatus } | { error: string } {
  const parsed = taStatusSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? `status.${issue.path.join('.')}` : 'status';
    return { error: `${where}: ${issue.message}` };
  }
  const ids = (parsed.data.players ?? []).map((p) => p.playerId);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) return { error: `status.players: ${twice} is listed twice.` };
  return {
    status: {
      ...parsed.data,
      ...(parsed.data.startedAt ? { startedAt: new Date(parsed.data.startedAt).toISOString() } : {}),
      reportedAt: now.toISOString(),
    },
  };
}

/** A stored status read back, or null if it is not one (never written, or written by something else). */
export function readTaStatus(stored: unknown): TaStatus | null {
  if (!stored || typeof stored !== 'object') return null;
  const { reportedAt, ...rest } = stored as Record<string, unknown>;
  const parsed = taStatusSchema.safeParse(rest);
  if (!parsed.success || typeof reportedAt !== 'string') return null;
  return { ...parsed.data, reportedAt };
}

/**
 * The map to play next: the first one whose scores are still open, in playing
 * order - every other map by its slot, then the tiebreaker.
 */
export function nextMapToPlay<T extends { order: number; isTiebreaker: boolean; scoresClosed: boolean }>(
  maps: readonly T[],
): T | null {
  const inOrder = [...maps].sort(
    (a, b) => Number(a.isTiebreaker) - Number(b.isTiebreaker) || a.order - b.order,
  );
  return inOrder.find((m) => !m.scoresClosed) ?? null;
}

// ---------------------------------------------------------------------------
//  The TA link: settings, and what the worker sees
// ---------------------------------------------------------------------------

/** TA's public server, the one the game plugin lists by default. */
export const TA_DEFAULT_HOST = 'server.tournamentassistant.net';
export const TA_DEFAULT_PORT = 8676;

/** How songs are started in TA for a tournament. */
export interface TaOptions {
  /** Players cannot fail: the song plays to the end whatever their energy. TA's own "Disable Fail". */
  disableFail: boolean;
  /** Players cannot pause. */
  disablePause: boolean;
  /** Show TA's in-game scoreboard of the other players in the match. */
  showScoreboard: boolean;
  /**
   * A song that ran cleanly closes its own map: every lineup player's score came from TA, so there is nothing for
   * an organiser to check first. Any other ending (someone left the song, or dropped off TA) leaves the map open.
   * An organiser can always reopen a closed map.
   */
  autoClose: boolean;
  /** Beat Saber's own modifiers, applied to every song started from the site (TA's names, see TA_MODIFIERS). */
  modifiers: TaModifier[];
  /** Scores from these songs are not submitted to ScoreSaber. */
  disableScoresaberSubmission: boolean;
  /** Players' custom notes are switched off, so the stream sees the normal ones. */
  disableCustomNotesOnStream: boolean;
}

/** The gameplay modifiers TA can start a song with, as TA names them, in the order its own app lists them. */
export const TA_MODIFIERS = [
  'NoFail', 'GhostNotes', 'DisappearingArrows', 'NoBombs', 'NoObstacles', 'NoArrows', 'FastSong', 'SuperFastSong', 'FastNotes',
  'SlowSong', 'InstaFail', 'FailOnClash', 'BatteryEnergy', 'ProMode', 'ZenMode', 'SmallCubes', 'StrictAngles',
] as const;
export type TaModifier = (typeof TA_MODIFIERS)[number];
export const TA_MODIFIER_LABELS: Record<TaModifier, string> = {
  NoFail: 'No Fail', GhostNotes: 'Ghost Notes', DisappearingArrows: 'Disappearing Arrows', NoBombs: 'No Bombs', NoObstacles: 'No Walls',
  NoArrows: 'No Arrows', FastSong: 'Faster Song', SuperFastSong: 'Super Fast Song', FastNotes: 'Fast Notes', SlowSong: 'Slower Song',
  InstaFail: 'One Life', FailOnClash: 'Fail on Saber Clash', BatteryEnergy: 'Four Lives', ProMode: 'Pro Mode', ZenMode: 'Zen Mode',
  SmallCubes: 'Small Notes', StrictAngles: 'Strict Angles',
};
/** Modifiers that cannot be on together: only the first of each group that is set is kept. */
const TA_MODIFIER_GROUPS: TaModifier[][] = [
  ['FastSong', 'SuperFastSong', 'SlowSong'],
  ['NoFail', 'InstaFail', 'BatteryEnergy'],
  ['GhostNotes', 'DisappearingArrows'],
];
export function cleanTaModifiers(raw: unknown): TaModifier[] {
  const asked = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  const kept = TA_MODIFIERS.filter((m) => asked.has(m));
  return kept.filter((m) => {
    const group = TA_MODIFIER_GROUPS.find((g) => g.includes(m));
    return !group || kept.find((k) => group.includes(k)) === m;
  });
}

export const DEFAULT_TA_OPTIONS: TaOptions = { disableFail: true, disablePause: false, showScoreboard: false, autoClose: true, modifiers: [], disableScoresaberSubmission: false, disableCustomNotesOnStream: false };

/** Stored options read back; anything missing or odd falls to the default. */
export function parseTaOptions(stored: unknown): TaOptions {
  const o = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  type Flag = 'disableFail' | 'disablePause' | 'showScoreboard' | 'autoClose' | 'disableScoresaberSubmission' | 'disableCustomNotesOnStream';
  const flag = (key: Flag) => (typeof o[key] === 'boolean' ? (o[key] as boolean) : DEFAULT_TA_OPTIONS[key]);
  return {
    disableFail: flag('disableFail'), disablePause: flag('disablePause'), showScoreboard: flag('showScoreboard'), autoClose: flag('autoClose'),
    modifiers: cleanTaModifiers(o.modifiers),
    disableScoresaberSubmission: flag('disableScoresaberSubmission'), disableCustomNotesOnStream: flag('disableCustomNotesOnStream'),
  };
}

/** Where the worker's connection to TA stands. */
export const TA_LINK_PHASES = [
  /** Switched off, or no worker is running. */
  'off',
  'connecting',
  /** Connected, but TA wants a sign-in: `authUrl` is where to do it. */
  'signIn',
  /** Signed in; no TA tournament chosen yet. */
  'noTournament',
  /** Signed in and in the tournament: maps can be started. */
  'ready',
  'error',
] as const;
export type TaLinkPhase = (typeof TA_LINK_PHASES)[number];

/** Someone connected to the TA tournament. */
export interface TaUser {
  guid: string;
  name: string;
  /** Steam, Oculus or Quest id; empty for coordinators and overlays. */
  platformId: string;
  kind: 'player' | 'coordinator';
  /** What TA says they are doing. */
  playState: 'menu' | 'waiting' | 'inGame';
  downloadState: 'none' | 'downloading' | 'downloaded' | 'error';
  /** The mods their game reports, where TA collects them. */
  mods: string[];
  /** The roster player this is, where one matches (TA id, else BeatLeader id, else name). */
  playerId: string | null;
  isMock: boolean;
}

export interface TaTournamentSummary {
  guid: string;
  name: string;
  /** How many people are connected to it right now. */
  users: number;
}

/**
 * Everything the worker knows about a tournament's TA link right now. Kept in
 * Redis and replaced whole on every change; gone when the worker is.
 */
export interface TaLinkState {
  tournamentId: string;
  phase: TaLinkPhase;
  /** Plain words for `error`, or a note for the other phases. */
  message: string | null;
  host: string;
  port: number;
  /** Who the worker is signed in as, where it is. */
  signedInAs: string | null;
  /** Discord sign-in address while `phase` is signIn (TA's own OAuth page). */
  authUrl: string | null;
  /** The TA tournaments this sign-in can see, to choose from. */
  tournaments: TaTournamentSummary[];
  /** The chosen TA tournament, once joined. */
  tournament: (TaTournamentSummary & {
    replayStreaming: boolean;
    allowMockClients: boolean;
    /**
     * Only people with a role in the TA tournament see it in game (TA's "allow unauthorized view" switched off).
     * The site then keeps the roster in TA as players, by the id TA knows each of them by.
     */
    playersOnly: boolean;
    /** The rest of TA's own tournament settings, as its coordinator app shows them. */
    showTournamentButton: boolean;
    showQualifierButton: boolean;
    enableTeams: boolean;
    enablePools: boolean;
    replayRecording: boolean;
    /** How long TA keeps recorded replays: '30d' | '90d' | '1y' | '3y'. */
    replayRetention: TaReplayRetention;
    /** Mods players may not have installed, by name. */
    bannedMods: string[];
    scoreUpdateFrequency: number;
    /** Permissions this sign-in holds in it, as TA names them. */
    permissions: string[];
  }) | null;
  users: TaUser[];
  /** Unix ms the worker wrote this. */
  at: number;
}

/** Redis names shared by the web app and the worker. */
export const TA_KEYS = {
  /** GET: a TaLinkState as JSON. Expires by itself if the worker stops. */
  state: (tournamentId: string) => `bscs:ta:state:${tournamentId}`,
  /** PUBLISH: a TaCommand as JSON, from the web app to the worker. */
  commands: 'bscs:ta:cmd',
  /** GET: the worker's answer to command `id`, a TaReply as JSON. Short-lived. */
  reply: (id: string) => `bscs:ta:reply:${id}`,
  /** PUBLISH: a TaLive as JSON, while a map is being played. */
  live: 'bscs:ta:live',
} as const;

/** How long a link state stays readable without the worker refreshing it. */
export const TA_STATE_TTL_SECONDS = 45;

/** What the web app can ask the worker to do. Each carries the tournament it is about. */
export type TaCommand = { id: string; tournamentId: string } & (
  /** Settings or a match changed: look again now rather than at the next tick. */
  | { type: 'poke' }
  /** Drop the connection and sign in afresh (after the address or token changed). */
  | { type: 'reconnect' }
  /** A person signed in through TA's Discord page; trade their short-lived token for a bot token of our own. */
  | { type: 'adoptToken'; token: string }
  /** Join this TA tournament, giving our bot the rights it needs if the signed-in person can. */
  | { type: 'chooseTournament'; guid: string }
  | { type: 'createTournament'; name: string }
  | { type: 'setReplayStreaming'; on: boolean }
  | { type: 'setAllowMockClients'; on: boolean }
  /** Hide the TA tournament from everyone but its players and staff (and give TA the roster), or open it again. */
  | { type: 'setPlayersOnly'; on: boolean }
  /** Bring TA's list of players in step with the roster now. Answers with { added, removed, players }. */
  | { type: 'syncPlayers' }
  | { type: 'setScoreUpdateFrequency'; frames: number }
  /** One of TA's own tournament settings. */
  | { type: 'setTournamentSetting'; setting: TaTournamentSetting }
  /** Delete the TA tournament from TA for good (TA's "End Tournament"). */
  | { type: 'deleteTournament' }
  /** A change to these players' games right now (TA users, by guid): swap colours or hands, or hide one colour's notes. */
  | { type: 'playerCommand'; command: TaPlayerCommand; guids: string[] }
  /** Send these TA users (by guid) back to the menu. */
  | { type: 'returnToMenu'; guids: string[] }
  | { type: 'listAuthorizedUsers' }
  | { type: 'addAuthorizedUser'; discordId: string; role: 'admin' | 'coordinator' | 'player' | 'view_only' }
  | { type: 'removeAuthorizedUser'; discordId: string }
);
export const TA_REPLAY_RETENTIONS = ['30d', '90d', '1y', '3y'] as const;
export type TaReplayRetention = (typeof TA_REPLAY_RETENTIONS)[number];
export type TaTournamentSetting =
  | { key: 'name'; value: string }
  | { key: 'bannedMods'; value: string[] }
  | { key: 'showTournamentButton' | 'showQualifierButton' | 'enableTeams' | 'enablePools' | 'replayRecording'; value: boolean }
  | { key: 'replayRetention'; value: TaReplayRetention };
export const TA_PLAYER_COMMANDS = ['flipColors', 'flipHands', 'disableBlueNotes', 'disableRedNotes'] as const;
export type TaPlayerCommand = (typeof TA_PLAYER_COMMANDS)[number];

/** A TaCommand without the fields the sender fills in for every command. */
export type TaCommandBody = TaCommand extends infer C ? (C extends unknown ? Omit<C, 'id' | 'tournamentId'> : never) : never;

export type TaReply = { ok: true; data?: unknown } | { ok: false; error: string };

/** Someone allowed into a TA tournament without being a player: an admin, a coordinator, a bot. */
export interface TaAuthorizedUser {
  discordId: string;
  name: string;
  avatar: string | null;
  roles: string[];
}

/** One player's numbers while a song runs. */
export interface TaLivePlayer {
  playerId: string;
  teamId: string;
  /** Position in the team's lineup, 0-based. */
  slot: number;
  /** The id TA streams their live replay under. */
  platformId: string;
  score: number;
  /** 0..1, of the notes so far. */
  accuracy: number;
  combo: number;
  misses: number;
  /** Seconds into the song. */
  songPosition: number;
  finished: boolean;
}

/** A song being played, a few times a second. `phase: 'over'` once: it has stopped (finished or cancelled). */
export interface TaLive {
  matchId: string;
  matchMapId: string;
  phase: 'playing' | 'over';
  /** Unix ms the song was started for everyone. */
  startedAt: number;
  players: TaLivePlayer[];
  at: number;
}

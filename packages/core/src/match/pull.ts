/**
 * Filling in a match map's scores from BeatLeader.
 *
 * Everyone on a map plays it at the same moment, off one countdown, so their
 * runs start together - and a run says when it started: when it ended, less
 * how far into the song it got. That is what picks out the runs a map was
 * played with, not "the latest run": someone may play the map again before
 * the button is pressed, and the button may be pressed long after the song,
 * or before everyone has finished.
 *
 * So, among the runs since the map opened, the moment the most players
 * started together is the go; each player's run from that moment is theirs.
 * A player with nothing there yet is waiting - pressing again later picks
 * them up. Nothing needs to be started when the song starts, and whoever is
 * coordinating can be playing too.
 *
 * Players who keep their BeatLeader stats private show only a new personal
 * best, as a leaderboard score. When it lines up with the others it is this
 * run; when there is none, the run was not a best and has to be typed in.
 */

export type PulledEnd = 'UNKNOWN' | 'CLEAR' | 'FAIL' | 'RESTART' | 'QUIT' | 'PRACTICE';

export interface PulledRun {
  /** BeatLeader's id for the run (a scorestats attempt) or the score. */
  id: number;
  source: 'RUN' | 'SCORE';
  endType: PulledEnd;
  /** Unix seconds when the run ended. */
  timeset: number;
  /** Seconds into the song when it ended (for a clear, usually the level's length - see runStart). */
  time: number;
  /** 0..1, over what had been played when it ended. */
  accuracy: number;
  baseScore: number;
  modifiers: string;
  /** The .bsor, or null. */
  replayUrl: string | null;
}

export interface PlayerRuns {
  playerId: string;
  playerName: string;
  /** Private: only new personal bests are visible, as leaderboard scores. */
  runsPublic: boolean;
  runs: readonly PulledRun[];
}

export interface PullOptions {
  /** Unix seconds the map opened for play: runs before it are not this map's. */
  since: number;
  /** How far apart two players' starts may be and still be the same go. */
  toleranceSeconds: number;
  /** The song's length in seconds, where known. */
  duration?: number;
}

export type PickStatus =
  /** Started with the others: saved without asking. */
  | 'MATCHED'
  /** Started with the others, but something about it wants a person's eye. */
  | 'CHECK'
  /** No run from that go yet - not finished, or private and not a best. */
  | 'WAITING';

export interface PlayerPick {
  playerId: string;
  playerName: string;
  status: PickStatus;
  chosen: PulledRun | null;
  /** Every run since the map opened, latest first - what someone may pick instead. */
  candidates: PulledRun[];
  /** Why it is CHECK or WAITING, or what is worth knowing about a MATCHED run. */
  notes: string[];
}

export interface PullResult {
  picks: PlayerPick[];
  /** Unix seconds the go started. Null when nobody has a run yet. */
  startedAt: number | null;
}

export const DEFAULT_TOLERANCE_SECONDS = 15;
/** Runs are allowed to start this long before the map opened: clocks and clicks differ. */
const OPEN_SLACK_SECONDS = 60;

/**
 * When a run started, from when it ended and how far into the song it got.
 *
 * For a clear, BeatLeader's `time` is usually the length of the level - 166.6s
 * on a 167s song - but not always: real clears on a 156s song came back as
 * 138s and 36s. Where it is plausible (at least half the song) it is used, as
 * it is the more exact; otherwise the song's length is.
 */
export function runStart(run: Pick<PulledRun, 'timeset' | 'time' | 'endType'>, duration?: number): number {
  let played = run.time;
  if (run.endType === 'CLEAR' && duration && duration > 0 && !(run.time >= duration / 2 && run.time <= duration + 5)) {
    played = duration;
  }
  return run.timeset - Math.max(0, played);
}

const END_WORDS: Record<PulledEnd, string> = {
  UNKNOWN: 'ended without saying how',
  CLEAR: 'cleared',
  FAIL: 'failed',
  RESTART: 'was restarted',
  QUIT: 'was quit',
  PRACTICE: 'was practice',
};

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function pickMatchRuns(players: readonly PlayerRuns[], options: PullOptions): PullResult {
  const start = (run: PulledRun) => runStart(run, options.duration);
  const byPlayer = players.map((player) => ({
    player,
    candidates: player.runs
      .filter((r) => r.endType !== 'PRACTICE' && start(r) >= options.since - OPEN_SLACK_SECONDS)
      .sort((a, b) => b.timeset - a.timeset),
  }));

  // The go: the start time the most players have a run near, the latest of
  // those if two gos drew as many.
  const near = (a: number, b: number) => Math.abs(a - b) <= options.toleranceSeconds;
  let best: { at: number; players: number } | null = null;
  for (const { candidates } of byPlayer) {
    for (const run of candidates) {
      const at = start(run);
      const count = byPlayer.filter((p) => p.candidates.some((r) => near(start(r), at))).length;
      if (!best || count > best.players || (count === best.players && at > best.at)) best = { at, players: count };
    }
  }
  // Settle on the middle of the go rather than whichever run seeded it.
  let startedAt: number | null = null;
  if (best) {
    const starts = byPlayer
      .flatMap((p) => p.candidates.filter((r) => near(start(r), best!.at)).map(start))
      .sort((a, b) => a - b);
    startedAt = starts[Math.floor((starts.length - 1) / 2)]!;
  }

  const picks = byPlayer.map(({ player, candidates }): PlayerPick => {
    const base = { playerId: player.playerId, playerName: player.playerName, candidates };
    // Two runs from the go is a restart straight into a fresh start: the later one is the run.
    const fromGo =
      startedAt == null
        ? []
        : candidates.filter((r) => Math.abs(start(r) - startedAt!) <= options.toleranceSeconds * 2);
    const chosen = fromGo.sort((a, b) => start(b) - start(a))[0] ?? null;

    if (!chosen) {
      const notes = [
        !player.runsPublic
          ? 'Nothing new from them. Their BeatLeader stats are private, so only a new personal best shows up - if this run was not one, type it in.'
          : candidates.length > 0
            ? `No run that started with the others yet. Their latest ${candidates.length === 1 ? 'one' : `of ${candidates.length}`} started ${describeOffset(start(candidates[0]!) - (startedAt ?? start(candidates[0]!)))}.`
            : 'No run on this map yet - still playing, or not uploaded yet. Pull again in a moment.',
      ];
      return { ...base, status: 'WAITING', chosen: null, notes };
    }

    const notes: string[] = [];
    let status: PickStatus = 'MATCHED';
    if (chosen.endType !== 'CLEAR') notes.push(`Their run ${END_WORDS[chosen.endType]} at ${clock(chosen.time)} into the song.`);
    // A fail is a result. A restart or a quit is someone stopping - whether that
    // counts, or a later run does, is a person's call.
    if (chosen.endType === 'RESTART' || chosen.endType === 'QUIT' || chosen.endType === 'UNKNOWN') status = 'CHECK';
    // No Fail is expected in matches - it changes nothing unless someone
    // dies - so only other modifiers are worth a look.
    const modifiers = chosen.modifiers.split(',').map((m) => m.trim()).filter((m) => m && m.toUpperCase() !== 'NF');
    if (modifiers.length) {
      notes.push(`Played with modifiers: ${modifiers.join(', ')}.`);
      status = 'CHECK';
    }
    if (startedAt != null && Math.abs(start(chosen) - startedAt) > options.toleranceSeconds) {
      notes.push(`Started ${describeOffset(start(chosen) - startedAt)} - is this the right run?`);
      status = 'CHECK';
    }
    return { ...base, status, chosen, notes };
  });

  return { picks, startedAt };
}

function describeOffset(seconds: number): string {
  const s = Math.round(seconds);
  if (Math.abs(s) < 1) return 'with the others';
  const side = s > 0 ? 'after' : 'before';
  const a = Math.abs(s);
  if (a < 120) return `${a}s ${side} the others`;
  if (a < 2 * 3600) return `${Math.round(a / 60)} min ${side} the others`;
  if (a < 2 * 86400) return `${Math.round(a / 3600)} hours ${side} the others`;
  return `${Math.round(a / 86400)} days ${side} the others`;
}

/**
 * What the runs behind a leaderboard say.
 *
 * A leaderboard keeps one number per player and map: their best clear. Nothing
 * on it says that a player has tried a map ten times and never finished it,
 * or that their one clear came after a run of fails. BeatLeader does record
 * every run the mod uploads - clears, fails, restarts and quits - and, for
 * players who show their stats publicly, serves them. This turns those runs
 * into the two kinds of evidence the model can use.
 *
 * - Where a player has **no clear**, their best run is their number on the map,
 *   whether it ended in a fail, a restart or a quit. It is what they were
 *   scoring while they played, which is what the leaderboard would show had
 *   they finished, and it stands in for a score in full. "Best" prefers
 *   length over accuracy: a high accuracy is easy to hold for the opening and
 *   hard to keep, so the longest run of ten notes or more is taken, and only
 *   among runs within a tenth of the song of that one is the highest accuracy
 *   chosen (`pickBestRun`). Where they do have a clear, that is their score on
 *   the map, as it is on the leaderboard.
 *   BeatLeader does not say how many notes a run reached, but its accuracy
 *   is the score over the most that could have been scored by that point,
 *   and that most is a fixed function of the notes passed (`notesPassed`).
 * - **Whether runs finish** feeds the fail model. A fail is a run that did not.
 *   A quit counts the same once it is well under way; one abandoned in the
 *   first seconds is a false start, and a restart is by definition one.
 *   Practice runs say nothing about either.
 */

export type RunEnd = 'UNKNOWN' | 'CLEAR' | 'FAIL' | 'RESTART' | 'QUIT' | 'PRACTICE';

export interface Run {
  playerId: string;
  leaderboardId: string;
  endType: RunEnd;
  /** Seconds into the song when it ended. */
  time: number;
  /** 0..1, up to that point. */
  accuracy: number;
  /** Unix seconds. */
  timeset: number;
  /** Points scored up to that point. */
  baseScore?: number;
  missedNotes?: number;
  badCuts?: number;
}

export interface RunObservation {
  playerId: string;
  leaderboardId: string;
  acc: number;
  timeset: number;
  /** Always 1: the best run stands in for a score in full. */
  weight: number;
}

export interface RunOutcome {
  playerId: string;
  leaderboardId: string;
  finished: boolean;
}

export interface RunEvidence {
  /** One per cell: the best run standing in for a score, on maps the player has never cleared. */
  observations: RunObservation[];
  /** Every run that says whether the player finishes this map. */
  outcomes: RunOutcome[];
}

export interface RunEvidenceInput {
  runs: readonly Run[];
  /** leaderboardId -> song length in seconds, where known. */
  durations: Readonly<Record<string, number>>;
  /** `${playerId}::${leaderboardId}` of every cell that has a clear on the leaderboard. */
  cleared: ReadonlySet<string>;
  /** Least share of the song a quit must cover to count as a fail rather than a false start. */
  minProgress?: number;
  /** How many notes a run must hit before its accuracy means anything. */
  minNotesHit?: number;
}

const DEFAULT_MIN_PROGRESS = 0.2;
export const DEFAULT_MIN_NOTES_HIT = 10;

export function runEvidence(input: RunEvidenceInput): RunEvidence {
  const minProgress = input.minProgress ?? DEFAULT_MIN_PROGRESS;
  const minNotes = input.minNotesHit ?? DEFAULT_MIN_NOTES_HIT;
  const observations: RunObservation[] = [];
  const outcomes: RunOutcome[] = [];
  const best = new Map<string, Run>();
  const candidates = new Map<string, Run[]>();

  for (const run of input.runs) {
    const progress = runProgress(run, input.durations[run.leaderboardId]);
    const key = `${run.playerId}::${run.leaderboardId}`;

    switch (run.endType) {
      case 'CLEAR':
        outcomes.push({ playerId: run.playerId, leaderboardId: run.leaderboardId, finished: true });
        break;
      case 'FAIL':
        outcomes.push({ playerId: run.playerId, leaderboardId: run.leaderboardId, finished: false });
        break;
      case 'QUIT':
        if (progress >= minProgress) {
          outcomes.push({ playerId: run.playerId, leaderboardId: run.leaderboardId, finished: false });
        }
        break;
      default:
        break;
    }

    if (isBestRunCandidate(run, minNotes) && !input.cleared.has(key)) {
      const list = candidates.get(key) ?? [];
      list.push(run);
      candidates.set(key, list);
    }
  }

  for (const [key, list] of candidates) {
    const leaderboardId = key.slice(key.indexOf('::') + 2);
    best.set(key, pickBestRun(list, input.durations[leaderboardId]));
  }

  for (const [, run] of best) {
    observations.push({
      playerId: run.playerId,
      leaderboardId: run.leaderboardId,
      acc: run.accuracy,
      timeset: run.timeset,
      weight: 1,
    });
  }

  return { observations, outcomes };
}

/** Runs within this share of the song of the longest one are judged on accuracy instead. */
export const BEST_RUN_LENGTH_MARGIN = 0.1;

/**
 * The run that stands for the player on a map they have not cleared: the
 * longest, or the most accurate of those within a tenth of the song's length
 * of it. A minute at 80% says more than ten seconds at 95%. Without a known
 * song length, the margin is a tenth of the longest run.
 */
export function pickBestRun<T extends Pick<Run, 'time' | 'accuracy'>>(runs: readonly T[], duration?: number): T {
  if (runs.length === 0) throw new Error('pickBestRun needs at least one run');
  const longest = runs.reduce((a, b) => (b.time > a.time ? b : a));
  const margin = BEST_RUN_LENGTH_MARGIN * (duration && duration > 0 ? duration : longest.time);
  return runs
    .filter((r) => r.time >= longest.time - margin)
    .reduce((a, b) => (b.accuracy > a.accuracy ? b : a));
}

/** A run whose accuracy can stand for the player on the map: not a clear, not practice, and ten notes hit. */
export function isBestRunCandidate(
  run: Pick<Run, 'endType' | 'time' | 'accuracy' | 'baseScore' | 'missedNotes' | 'badCuts'>,
  minNotes = DEFAULT_MIN_NOTES_HIT,
): boolean {
  return (
    (run.endType === 'FAIL' || run.endType === 'RESTART' || run.endType === 'QUIT') &&
    run.accuracy > 0 &&
    run.accuracy <= 1 &&
    notesHit(run) >= minNotes
  );
}

/**
 * The most a run can score over its first n notes: 115 a note, times the
 * combo multiplier, which is 1 for the first two notes, 2 for the next four,
 * 4 for the next eight and 8 from then on. Chains, arcs and bombs are left
 * out; they move it a little on a few maps and not at all on most.
 */
export function maxScoreForNotes(n: number): number {
  if (n <= 0) return 0;
  if (n <= 2) return 115 * n;
  if (n <= 6) return 230 + 230 * (n - 2);
  if (n <= 14) return 1150 + 460 * (n - 6);
  return 4830 + 920 * (n - 14);
}

/**
 * How many notes a run got through, from its score and accuracy: accuracy is
 * the score over `maxScoreForNotes` of the notes passed, so the latter is the
 * inverse. Zero when there is nothing to go on.
 */
export function notesPassed(run: Pick<Run, 'accuracy' | 'baseScore'>): number {
  if (!run.baseScore || !(run.accuracy > 0)) return 0;
  const max = run.baseScore / run.accuracy;
  if (max <= 230) return Math.round(max / 115);
  if (max <= 1150) return Math.round(2 + (max - 230) / 230);
  if (max <= 4830) return Math.round(6 + (max - 1150) / 460);
  return Math.round(14 + (max - 4830) / 920);
}

/** Notes passed less the ones missed or cut badly. */
export function notesHit(run: Pick<Run, 'accuracy' | 'baseScore' | 'missedNotes' | 'badCuts'>): number {
  return Math.max(0, notesPassed(run) - (run.missedNotes ?? 0) - (run.badCuts ?? 0));
}

/**
 * How much of the song a run covered, 0..1. Without a known length, a run is
 * judged by the clock alone: a minute in is well under way on any map.
 */
export function runProgress(run: Pick<Run, 'time' | 'endType'>, duration: number | undefined): number {
  if (run.endType === 'CLEAR') return 1;
  if (duration && duration > 0) return Math.max(0, Math.min(1, run.time / duration));
  return Math.max(0, Math.min(1, run.time / 60));
}

import { accuracyForRaw, mapScale, rawCurve, type PointsCurve } from './points.js';

/**
 * How a map is decided, and by how much.
 *
 * - `ACCURACY`: the team's average accuracy, which is what the league sheets
 *   have always done. On one map that picks the same winner as adding up
 *   scores.
 * - `MATCH_POINTS`: each player's accuracy through the match points curve
 *   first, then averaged (see points.ts).
 *
 * A replay adds runs, it never replaces them. Which of them count is the
 * tournament's call (`ReplayCounting`): by default the team's best run
 * together, the way a pair plays it; or each player's own best, mixed across
 * runs.
 */
export type ScoringMode = 'ACCURACY' | 'MATCH_POINTS';
export const SCORING_MODES: readonly ScoringMode[] = ['ACCURACY', 'MATCH_POINTS'];

export function parseScoringMode(raw: unknown): ScoringMode {
  return raw === 'MATCH_POINTS' ? 'MATCH_POINTS' : 'ACCURACY';
}

/**
 * Which runs count once a map has been replayed.
 *
 * - `BEST_PAIR`: the team's best run of the map as a whole - its players'
 *   scores from the same go, never one player's first run beside another's
 *   replay.
 * - `BEST_EACH`: each player's own best run, whichever go it came from.
 */
export type ReplayCounting = 'BEST_PAIR' | 'BEST_EACH';
export const REPLAY_COUNTINGS: readonly ReplayCounting[] = ['BEST_PAIR', 'BEST_EACH'];

export function parseReplayCounting(raw: unknown): ReplayCounting {
  return raw === 'BEST_EACH' ? 'BEST_EACH' : 'BEST_PAIR';
}

export interface Scoring {
  mode: ScoringMode;
  curve: PointsCurve;
  /** Which runs of a replayed map count. BEST_PAIR when left out. */
  replays?: ReplayCounting;
  /**
   * A failed run (No Fail kicked in and halved it) counts doubled back, as
   * though they had not failed. Off when left out: it counts as scored.
   */
  doubleFails?: boolean;
}

export interface RecordedRun {
  teamId: string;
  playerId: string;
  score: number;
  accuracy: number;
  /** Which go at the map: 1 for the first, 2 for the first replay... 1 when left out. */
  attempt?: number;
  /**
   * They failed. `score` and `accuracy` are then stored doubled back from No
   * Fail's halving; they count that way only under `doubleFails`.
   */
  failed?: boolean;
}

/** A run as it counts under the match's scoring: a fail halved again unless fails count double. */
export function asCounted<T extends RecordedRun>(run: T, scoring: Pick<Scoring, 'doubleFails'>): T {
  if (!run.failed || scoring.doubleFails) return run;
  return { ...run, score: Math.round(run.score / 2), accuracy: run.accuracy / 2 };
}

export interface CountedRun {
  playerId: string;
  /** The go this run was from. */
  attempt: number;
  /** As it counts: a fail is doubled only where the match says fails count double. */
  score: number;
  accuracy: number;
  /** Null outside MATCH_POINTS, or where the map has no perfect accuracy to scale by. */
  points: number | null;
}

/** One team's figures for a set of runs: a whole go at the map, or the runs that counted. */
export interface RunsScore {
  runs: CountedRun[];
  totalScore: number;
  /** Mean accuracy, or the accuracy whose points are the team's mean points. */
  accEquivalent: number;
  /** Mean match points. Null outside MATCH_POINTS or without a perfect accuracy. */
  points: number | null;
  /** What the map is decided on: mean accuracy, or the mean of the unscaled curve. */
  key: number;
}

/** One go at the map by one team, scored as a whole. */
export interface GoScore extends RunsScore {
  attempt: number;
  /** Every player who posted on any go posted on this one. A go still missing someone is never the counted one under BEST_PAIR. */
  complete: boolean;
  /** This go is the one that counts (BEST_PAIR, or BEST_EACH where every counted run came from it). */
  counted: boolean;
}

export interface TeamMapScore {
  /** The runs that count. */
  runs: CountedRun[];
  totalScore: number;
  /** Mean accuracy, or the accuracy whose points are the team's mean points. */
  accEquivalent: number;
  /** Mean match points. Null outside MATCH_POINTS or without a perfect accuracy. */
  points: number | null;
  /** What the map is decided on: mean accuracy, or the mean of the unscaled curve. */
  key: number;
  /** The go that counted; null where BEST_EACH took runs from more than one. */
  attempt: number | null;
  /** Every go the team has posted on, first run first. */
  goes: GoScore[];
}

export interface MapResult {
  /** Keyed by team id; absent for a team with nothing recorded. */
  teams: Record<string, TeamMapScore>;
  /** Set once both teams have posted and one is ahead. */
  winnerId: string | null;
  /** Both teams have posted. */
  decided: boolean;
  /**
   * How much more accuracy each player on the losing side would have needed
   * for the map to finish level. Null while undecided, on a tie, or when not
   * even 100% from all of them would have done it.
   */
  catchUp: number | null;
  /**
   * Per player on the losing side: the accuracy they alone would have needed
   * to add, everyone else's run as it was, for the map to finish level. Null
   * for a player where not even 100% would have done it. Empty while
   * undecided or on a tie.
   */
  catchUpAlone: Record<string, number | null>;
}

const attemptOf = (run: RecordedRun) => run.attempt ?? 1;

/** Each player's best run for one team, whichever go it came from. */
export function bestRuns(runs: readonly RecordedRun[], teamId: string): RecordedRun[] {
  const best = new Map<string, RecordedRun>();
  for (const run of runs) {
    if (run.teamId !== teamId) continue;
    const held = best.get(run.playerId);
    if (!held || run.score > held.score) best.set(run.playerId, run);
  }
  return [...best.values()];
}

/** A set of one team's runs, through the match's scoring. */
function scoreRuns(counted: readonly RecordedRun[], scoring: Scoring, scale: number | null): RunsScore {
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const totalScore = counted.reduce((sum, r) => sum + r.score, 0);
  const base = (r: RecordedRun) => ({ playerId: r.playerId, attempt: attemptOf(r), score: r.score, accuracy: r.accuracy });

  if (scoring.mode === 'ACCURACY') {
    const acc = mean(counted.map((r) => r.accuracy));
    return {
      runs: counted.map((r) => ({ ...base(r), points: null })),
      totalScore,
      accEquivalent: acc,
      points: null,
      key: acc,
    };
  }

  const raw = mean(counted.map((r) => rawCurve(r.accuracy, scoring.curve)));
  return {
    runs: counted.map((r) => ({
      ...base(r),
      points: scale == null ? null : scale * rawCurve(r.accuracy, scoring.curve),
    })),
    totalScore,
    // A mean of values the curve produced is always one it can produce.
    accEquivalent: accuracyForRaw(raw, scoring.curve) ?? 1,
    points: scale == null ? null : scale * raw,
    key: raw,
  };
}

export function scoreTeam(
  runs: readonly RecordedRun[],
  teamId: string,
  scoring: Scoring,
  /** The map's perfect accuracy, where one is known. */
  perfectAcc: number | null,
): TeamMapScore | null {
  const own = runs.filter((r) => r.teamId === teamId).map((r) => asCounted(r, scoring));
  if (own.length === 0) return null;
  const scale = perfectAcc != null && perfectAcc > 0 ? mapScale(perfectAcc, scoring.curve) : null;

  // Each go at the map on its own, as the pair played it.
  const byGo = new Map<number, RecordedRun[]>();
  for (const run of own) {
    const go = byGo.get(attemptOf(run)) ?? [];
    // A player twice on one go (shouldn't happen) counts once, their best.
    const twice = go.findIndex((r) => r.playerId === run.playerId);
    if (twice < 0) go.push(run);
    else if (run.score > go[twice]!.score) go[twice] = run;
    byGo.set(attemptOf(run), go);
  }
  const everyone = new Set(own.map((r) => r.playerId)).size;
  const goes: GoScore[] = [...byGo.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attempt, go]) => ({
      ...scoreRuns(go, scoring, scale),
      attempt,
      complete: go.length === everyone,
      counted: false,
    }));

  let counted: RunsScore;
  let attempt: number | null;
  if (parseReplayCounting(scoring.replays) === 'BEST_PAIR') {
    // The best whole go. One still missing someone's score is not a pair's
    // run yet, unless no go has everyone (then the fullest, best of those).
    const full = Math.max(...goes.map((g) => g.runs.length));
    let best: GoScore | null = null;
    for (const go of goes) {
      if (go.runs.length !== full) continue;
      if (!best || go.key > best.key) best = go;
    }
    best!.counted = true;
    counted = best!;
    attempt = best!.attempt;
  } else {
    counted = scoreRuns(bestRuns(own, teamId), scoring, scale);
    const from = new Set(counted.runs.map((r) => r.attempt));
    attempt = from.size === 1 ? [...from][0]! : null;
    for (const go of goes) go.counted = go.attempt === attempt && go.complete;
  }

  return { ...counted, attempt, goes };
}

export function mapResult(
  runs: readonly RecordedRun[],
  teamIds: readonly [string, string],
  scoring: Scoring,
  perfectAcc: number | null,
): MapResult {
  const teams: Record<string, TeamMapScore> = {};
  for (const id of teamIds) {
    const scored = scoreTeam(runs, id, scoring, perfectAcc);
    if (scored) teams[id] = scored;
  }
  const [a, b] = teamIds.map((id) => teams[id]);
  if (!a || !b) return { teams, winnerId: null, decided: false, catchUp: null, catchUpAlone: {} };
  if (a.key === b.key) return { teams, winnerId: null, decided: true, catchUp: null, catchUpAlone: {} };

  const aWins = a.key > b.key;
  const winner = aWins ? a : b;
  const loser = aWins ? b : a;
  return {
    teams,
    winnerId: aWins ? teamIds[0] : teamIds[1],
    decided: true,
    catchUp: catchUp(loser, winner.key, scoring),
    catchUpAlone: Object.fromEntries(
      loser.runs.map((r) => [r.playerId, catchUpAlone(loser, r.playerId, winner.key, scoring)]),
    ),
  };
}

/**
 * The accuracy one player on the losing side would have needed to add, on
 * their own, for their team to draw level - their teammates' runs as they
 * were. The team's key is a mean, so that player has to make up the whole
 * gap times the team's size.
 */
function catchUpAlone(loser: TeamMapScore, playerId: string, target: number, scoring: Scoring): number | null {
  const run = loser.runs.find((r) => r.playerId === playerId);
  if (!run) return null;
  const n = loser.runs.length;
  const value = (acc: number) => (scoring.mode === 'ACCURACY' ? acc : rawCurve(acc, scoring.curve));
  const others = loser.runs.reduce((sum, r) => (r === run ? sum : sum + value(r.accuracy)), 0);
  const needed = target * n - others;
  const acc = scoring.mode === 'ACCURACY' ? (needed <= 1 + 1e-12 ? needed : null) : accuracyForRaw(needed, scoring.curve);
  if (acc == null) return null;
  return Math.max(0, acc - run.accuracy);
}

/**
 * The accuracy every player on the losing side would have needed to add for
 * their team to draw level: the one figure that answers "how close was it"
 * for each of them. Under ACCURACY that is simply the gap in averages; under
 * the curve a point is worth more near the top, so it is solved for.
 */
function catchUp(loser: TeamMapScore, target: number, scoring: Scoring): number | null {
  if (scoring.mode === 'ACCURACY') return target - loser.key;
  const reached = (delta: number) =>
    loser.runs.reduce((sum, r) => sum + rawCurve(Math.min(1, r.accuracy + delta), scoring.curve), 0) /
    loser.runs.length;
  if (reached(1) < target) return null;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (reached(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Maps won by each side: a map counts once both sides have posted; the
 * tiebreaker only when the other maps finish level. The one count the match
 * page, the tournament page, link previews and completing a match all use.
 */
export function tallyMaps(
  maps: ReadonlyArray<{ isTiebreaker: boolean; perfectAcc: number | null; attempts: readonly RecordedRun[] }>,
  teamAId: string,
  teamBId: string,
  scoring: Scoring,
): { a: number; b: number } {
  let a = 0;
  let b = 0;
  const count = (map: (typeof maps)[number]) => {
    const { winnerId } = mapResult(map.attempts, [teamAId, teamBId], scoring, map.perfectAcc);
    if (winnerId === teamAId) a++;
    else if (winnerId === teamBId) b++;
  };
  maps.filter((m) => !m.isTiebreaker).forEach(count);
  if (a === b) maps.filter((m) => m.isTiebreaker).forEach(count);
  return { a, b };
}

/**
 * Totals across every map, for a format decided on aggregate: scores added up
 * under ACCURACY, each map's mean points under MATCH_POINTS. A map with no
 * perfect accuracy is scaled as though 100% were perfect, so that it still
 * counts.
 */
export function aggregateTotals(
  maps: ReadonlyArray<{ perfectAcc: number | null; attempts: readonly RecordedRun[] }>,
  teamAId: string,
  teamBId: string,
  scoring: Scoring,
): { a: number; b: number } {
  const total = (teamId: string) =>
    maps.reduce((sum, map) => {
      const team = scoreTeam(map.attempts, teamId, scoring, map.perfectAcc ?? 1);
      if (!team) return sum;
      return sum + (scoring.mode === 'ACCURACY' ? team.totalScore : (team.points ?? 0));
    }, 0);
  return { a: total(teamAId), b: total(teamBId) };
}

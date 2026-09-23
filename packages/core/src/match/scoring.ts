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
 * A player's counted run is their best one on the map - a replay adds runs,
 * it never replaces them.
 */
export type ScoringMode = 'ACCURACY' | 'MATCH_POINTS';
export const SCORING_MODES: readonly ScoringMode[] = ['ACCURACY', 'MATCH_POINTS'];

export function parseScoringMode(raw: unknown): ScoringMode {
  return raw === 'MATCH_POINTS' ? 'MATCH_POINTS' : 'ACCURACY';
}

export interface Scoring {
  mode: ScoringMode;
  curve: PointsCurve;
}

export interface RecordedRun {
  teamId: string;
  playerId: string;
  score: number;
  accuracy: number;
}

export interface CountedRun {
  playerId: string;
  score: number;
  accuracy: number;
  /** Null outside MATCH_POINTS, or where the map has no perfect accuracy to scale by. */
  points: number | null;
}

export interface TeamMapScore {
  runs: CountedRun[];
  totalScore: number;
  /** Mean accuracy, or the accuracy whose points are the team's mean points. */
  accEquivalent: number;
  /** Mean match points. Null outside MATCH_POINTS or without a perfect accuracy. */
  points: number | null;
  /** What the map is decided on: mean accuracy, or the mean of the unscaled curve. */
  key: number;
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
}

/** Each player's best run for one team. */
export function bestRuns(runs: readonly RecordedRun[], teamId: string): RecordedRun[] {
  const best = new Map<string, RecordedRun>();
  for (const run of runs) {
    if (run.teamId !== teamId) continue;
    const held = best.get(run.playerId);
    if (!held || run.score > held.score) best.set(run.playerId, run);
  }
  return [...best.values()];
}

export function scoreTeam(
  runs: readonly RecordedRun[],
  teamId: string,
  scoring: Scoring,
  /** The map's perfect accuracy, where one is known. */
  perfectAcc: number | null,
): TeamMapScore | null {
  const counted = bestRuns(runs, teamId);
  if (counted.length === 0) return null;
  const scale = perfectAcc != null && perfectAcc > 0 ? mapScale(perfectAcc, scoring.curve) : null;
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const totalScore = counted.reduce((sum, r) => sum + r.score, 0);

  if (scoring.mode === 'ACCURACY') {
    const acc = mean(counted.map((r) => r.accuracy));
    return {
      runs: counted.map((r) => ({ playerId: r.playerId, score: r.score, accuracy: r.accuracy, points: null })),
      totalScore,
      accEquivalent: acc,
      points: null,
      key: acc,
    };
  }

  const raw = mean(counted.map((r) => rawCurve(r.accuracy, scoring.curve)));
  return {
    runs: counted.map((r) => ({
      playerId: r.playerId,
      score: r.score,
      accuracy: r.accuracy,
      points: scale == null ? null : scale * rawCurve(r.accuracy, scoring.curve),
    })),
    totalScore,
    // A mean of values the curve produced is always one it can produce.
    accEquivalent: accuracyForRaw(raw, scoring.curve) ?? 1,
    points: scale == null ? null : scale * raw,
    key: raw,
  };
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
  if (!a || !b) return { teams, winnerId: null, decided: false, catchUp: null };
  if (a.key === b.key) return { teams, winnerId: null, decided: true, catchUp: null };

  const aWins = a.key > b.key;
  const winner = aWins ? a : b;
  const loser = aWins ? b : a;
  return {
    teams,
    winnerId: aWins ? teamIds[0] : teamIds[1],
    decided: true,
    catchUp: catchUp(loser, winner.key, scoring),
  };
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

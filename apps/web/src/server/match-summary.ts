import {
  parsePointsCurve,
  parseScoringMode,
  tallyMaps as tallyUnder,
  type RecordedRun,
  type Scoring,
} from '@bscs/core/match';

/** How a match is scored, from its row. */
export function scoringOf(match: { scoring: string; pointsCurve: unknown }): Scoring {
  return { mode: parseScoringMode(match.scoring), curve: parsePointsCurve(match.pointsCurve) };
}

/**
 * What counts as a perfect score on a pool map: the organisers' figure, or
 * BeatLeader's predicted accuracy where the tournament allows it and the map
 * has one. Null when neither; match points then cannot be shown for the map,
 * though it is still decided on the curve.
 */
export function perfectAccOf(
  poolMap: { perfectAcc: number | null; leaderboard: { predictedAcc: number } },
  fromBeatLeader: boolean,
): { value: number | null; source: 'ORGANISERS' | 'BEATLEADER' | null } {
  if (poolMap.perfectAcc != null && poolMap.perfectAcc > 0) return { value: poolMap.perfectAcc, source: 'ORGANISERS' };
  if (fromBeatLeader && poolMap.leaderboard.predictedAcc > 0) {
    return { value: poolMap.leaderboard.predictedAcc, source: 'BEATLEADER' };
  }
  return { value: null, source: null };
}

/**
 * Maps won by each side, under the match's own scoring. The one count the
 * match page, the tournament page, link previews and completing a match all
 * use. Who wins a map never depends on its perfect accuracy, so none is needed.
 */
export function tallyMaps(
  maps: ReadonlyArray<{ isTiebreaker: boolean; attempts: readonly RecordedRun[] }>,
  teamAId: string,
  teamBId: string,
  match: { scoring: string; pointsCurve: unknown },
): { a: number; b: number } {
  return tallyUnder(
    maps.map((m) => ({ isTiebreaker: m.isTiebreaker, perfectAcc: null, attempts: m.attempts })),
    teamAId,
    teamBId,
    scoringOf(match),
  );
}

/** A select for what `tallyMaps` needs of a match's maps. */
export const TALLY_ATTEMPTS = { select: { teamId: true, playerId: true, score: true, accuracy: true } } as const;

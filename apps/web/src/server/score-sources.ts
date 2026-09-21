import { prisma } from '@bscs/db';

/**
 * Scores from both ranked platforms, on one set of map keys.
 *
 * BeatLeader and ScoreSaber are two leaderboards for the same game. Plenty of
 * players run one mod and not the other, or moved from one to the other years
 * in, so either alone is a partial record. Neither is the "real" one here: a
 * player's score on a map is the best they have set on it, wherever that was
 * recorded, unless the viewer asks to look at one platform by itself.
 *
 * The two number their leaderboards differently. What they share is the song
 * hash, the difficulty and the mode, so a ScoreSaber score is matched to the
 * BeatLeader leaderboard for the same chart where one is known - which also
 * gives it that map's max score, ratings and kind. Where none is known the
 * score still gets a key of its own ("ss:hash:difficulty"), so two players who
 * have both played it on ScoreSaber can still be compared on it.
 */

export type ScoreSource = 'both' | 'beatleader' | 'scoresaber';
export const SCORE_SOURCES: Record<ScoreSource, string> = {
  both: 'Both',
  beatleader: 'BeatLeader',
  scoresaber: 'ScoreSaber',
};
export const parseSource = (value: string | undefined): ScoreSource =>
  value === 'beatleader' || value === 'scoresaber' ? value : 'both';

export interface UnifiedScore {
  playerId: string;
  /** BeatLeader's leaderboard id where the chart is known there; otherwise "ss:<hash>:<difficulty>". */
  leaderboardId: string;
  platform: 'BL' | 'SS';
  baseScore: number;
  accuracy: number;
  missedNotes: number;
  badCuts: number;
  fullCombo: boolean;
  pauses: number;
  accLeft: number;
  accRight: number;
  timeset: number;
  /** That platform's pp for the score. Not comparable across platforms. */
  pp: number;
  modifiers: string;
  beatLeaderScoreId: number | null;
  leaderboard: { maxScore: number; ranked: boolean; accRating: number; passRating: number; techRating: number };
}

const NO_RATINGS = { accRating: 0, passRating: 0, techRating: 0 };

export async function loadScores(
  playerIds: readonly string[],
  options: {
    source: ScoreSource;
    /** Only these BeatLeader leaderboards - a pool. Omit for everything. */
    leaderboardIds?: readonly string[];
  },
): Promise<UnifiedScore[]> {
  if (playerIds.length === 0) return [];
  const only = options.leaderboardIds ? [...options.leaderboardIds] : null;

  const beatLeader =
    options.source === 'scoresaber'
      ? []
      : await prisma.score.findMany({
          where: { playerId: { in: [...playerIds] }, ...(only ? { leaderboardId: { in: only } } : {}) },
          select: {
            playerId: true,
            leaderboardId: true,
            baseScore: true,
            accuracy: true,
            missedNotes: true,
            badCuts: true,
            fullCombo: true,
            pauses: true,
            accLeft: true,
            accRight: true,
            timeset: true,
            pp: true,
            modifiers: true,
            beatLeaderScoreId: true,
            leaderboard: {
              select: { maxScore: true, ranked: true, accRating: true, passRating: true, techRating: true },
            },
          },
        });

  const out: UnifiedScore[] = beatLeader.map((s) => ({ ...s, platform: 'BL' as const }));
  if (options.source === 'beatleader') return out;

  // The charts a ScoreSaber score could be matched to: for a pool, the pool's; otherwise any we know.
  const charts = only
    ? await prisma.leaderboard.findMany({
        where: { id: { in: only }, mode: 1 },
        select: chartSelect,
      })
    : null;

  const scoreSaber = await prisma.scoreSaberScore.findMany({
    where: {
      playerId: { in: [...playerIds] },
      // A modified run is not evidence of what someone scores in a match - the same rule the BeatLeader history follows.
      modifiers: '',
      gameMode: 'SoloStandard',
      ...(charts ? { songHash: { in: charts.map((c) => c.map.hash) } } : {}),
    },
    select: {
      playerId: true,
      songHash: true,
      difficultyValue: true,
      maxScore: true,
      baseScore: true,
      accuracy: true,
      pp: true,
      ranked: true,
      fullCombo: true,
      missedNotes: true,
      badCuts: true,
      timeset: true,
    },
  });
  if (scoreSaber.length === 0) return out;

  const known =
    charts ??
    (await prisma.leaderboard.findMany({
      where: { mode: 1, map: { hash: { in: [...new Set(scoreSaber.map((s) => s.songHash))] } } },
      select: chartSelect,
    }));
  const chartOf = new Map(known.map((c) => [`${c.map.hash}:${c.difficultyValue}`, c]));

  const best = new Map(out.map((s) => [`${s.playerId}::${s.leaderboardId}`, s]));
  for (const s of scoreSaber) {
    const chart = chartOf.get(`${s.songHash}:${s.difficultyValue}`);
    if (only && !chart) continue;

    // BeatLeader's max score is the authoritative one, and ScoreSaber often has none for an unranked map.
    const maxScore = chart?.maxScore || s.maxScore;
    const accuracy = maxScore > 0 ? s.baseScore / maxScore : s.accuracy;
    if (!(accuracy > 0) || accuracy > 1.0001) continue;

    const leaderboardId = chart?.id ?? `ss:${s.songHash}:${s.difficultyValue}`;
    const key = `${s.playerId}::${leaderboardId}`;
    const existing = best.get(key);
    // The better run stands, whichever site it is on.
    if (existing && existing.accuracy >= accuracy) continue;

    best.set(key, {
      playerId: s.playerId,
      leaderboardId,
      platform: 'SS',
      baseScore: s.baseScore,
      accuracy,
      missedNotes: s.missedNotes,
      badCuts: s.badCuts,
      fullCombo: s.fullCombo,
      pauses: 0,
      // ScoreSaber does not record hand accuracy; zero on both reads as "no difference", which is what is known.
      accLeft: 0,
      accRight: 0,
      timeset: s.timeset,
      pp: s.pp,
      modifiers: '',
      beatLeaderScoreId: null,
      leaderboard: chart
        ? { maxScore: chart.maxScore, ranked: chart.ranked, accRating: chart.accRating, passRating: chart.passRating, techRating: chart.techRating }
        : { maxScore, ranked: s.ranked, ...NO_RATINGS },
    });
  }
  return [...best.values()];
}

const chartSelect = {
  id: true,
  difficultyValue: true,
  maxScore: true,
  ranked: true,
  accRating: true,
  passRating: true,
  techRating: true,
  map: { select: { hash: true } },
} as const;

/** Something that changes whenever the ScoreSaber scores for these players do - for cache versions. */
export async function scoreSaberPulse(playerIds: readonly string[]): Promise<string> {
  const pulse = await prisma.scoreSaberScore.aggregate({
    where: { playerId: { in: [...playerIds] } },
    _count: true,
    _max: { timeset: true },
    _sum: { baseScore: true },
  });
  return `${pulse._count}:${pulse._max.timeset ?? 0}:${pulse._sum.baseScore ?? 0}`;
}

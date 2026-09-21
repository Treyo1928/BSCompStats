import { categorizeMap } from '@bscs/core/beatleader';
import { prisma } from '@bscs/db';
import { difficultyLabel, displayDifficulty } from '@bscs/core/beatleader';
import { buildTournamentModel, failKey, type TournamentModel } from './stats';

/**
 * The pool board: every tracked player against every map in a pool.
 *
 * This is the direct replacement for the spreadsheet's qualifiers tab, with the
 * things a spreadsheet could not do - predictions for the cells nobody has
 * filled in, fail flags, and live updates.
 */

export interface BoardCell {
  leaderboardId: string;
  /** Null when the player has no score on this map. */
  score: number | null;
  acc: number | null;
  /** An anomaly - abandoned or disastrous. Not merely a low score on a hard map. */
  isDnf: boolean;
  fullCombo: boolean;
  misses: number;
  /** BeatLeader's web replay viewer for this score. Null when the score has no id. */
  replayUrl: string | null;
  /** Model estimate, shown when there is no real score. */
  predictedAcc: number;
  predictionConfidence: number;
  /** True when `predictedAcc` was entered by a person rather than modelled. */
  isEstimate: boolean;
  /** Roughly one standard deviation either side of the model's prediction. */
  predictedLow: number;
  predictedHigh: number;
  /** Rank within the column, 1-based. Null when unplayed. */
  rank: number | null;
}

export interface BoardRow {
  playerId: string;
  playerName: string;
  avatar: string | null;
  beatLeaderId: string;
  teamId: string | null;
  teamName: string | null;
  teamColor: string | null;
  teamColorSecondary: string | null;
  /** False for an absent player or a sub who is not switched in. */
  available: boolean;
  cells: BoardCell[];
  /** Mean accuracy over the maps they have played in this pool. */
  meanAcc: number | null;
  played: number;
}

export interface BoardMap {
  poolMapId: string;
  leaderboardId: string;
  name: string;
  subName: string | null;
  mapper: string | null;
  difficultyLabel: string;
  /** BeatLeader's numeric difficulty (1 Easy .. 9 Expert+), for colouring. */
  difficultyValue: number;
  /**
   * How unpredictable this map is relative to a typical one - the model's
   * per-map residual scale. Around 1 is ordinary; Spin Eternally is near 3.
   */
  scatter: number;
  customName: string | null;
  category: string | null;
  maxScore: number;
  coverImage: string | null;
  isTiebreaker: boolean;
  ranked: boolean;
  stars: number;
  /** Guessed from the ratings when nobody has labelled the map. */
  autoCategory: string | null;
  /** BeatLeader's difficulty ratings; all zero when it has not rated the map. */
  ratings: { acc: number; pass: number; tech: number };
  /** Mean accuracy across everyone who played it - how hard it proved to be. */
  fieldMeanAcc: number | null;
}

export interface PoolBoard {
  poolId: string;
  poolName: string;
  maps: BoardMap[];
  /** Rows grouped by team, the way the spreadsheet blocked them out. */
  teams: Array<{
    teamId: string | null;
    teamName: string;
    color: string;
    rows: BoardRow[];
  }>;
  model: TournamentModel;
}

export async function buildPoolBoard(
  poolId: string,
): Promise<PoolBoard | null> {
  const pool = await prisma.mapPool.findUnique({
    where: { id: poolId },
    select: {
      id: true,
      name: true,
      tournamentId: true,
      maps: {
        orderBy: { order: 'asc' },
        select: {
          id: true,
          leaderboardId: true,
          category: true,
          label: true,
          isTiebreaker: true,
          leaderboard: {
            select: {
              id: true,
              difficultyValue: true,
              customName: true,
              maxScore: true,
              ranked: true,
              stars: true,
              accRating: true,
              passRating: true,
              techRating: true,
              map: {
                select: { name: true, subName: true, mapper: true, coverImage: true },
              },
            },
          },
        },
      },
    },
  });
  if (!pool) return null;

  const members = await prisma.teamMember.findMany({
    where: { team: { division: { tournamentId: pool.tournamentId } } },
    orderBy: [{ team: { name: 'asc' } }, { order: 'asc' }],
    select: {
      available: true,
      player: { select: { id: true, name: true, avatar: true, beatLeaderId: true } },
      team: {
        select: { id: true, name: true, color: true, colorSecondary: true },
      },
    },
  });

  const leaderboardIds = pool.maps.map((m) => m.leaderboardId);
  const playerIds = [...new Set(members.map((m) => m.player.id))];

  const scores = playerIds.length
    ? await prisma.score.findMany({
        where: { playerId: { in: playerIds }, leaderboardId: { in: leaderboardIds } },
        select: {
          playerId: true,
          leaderboardId: true,
          baseScore: true,
          accuracy: true,
          fullCombo: true,
          missedNotes: true,
          badCuts: true,
          beatLeaderScoreId: true,
        },
      })
    : [];

  const scoreBy = new Map(scores.map((s) => [`${s.playerId}::${s.leaderboardId}`, s]));

  const model = await buildTournamentModel(pool.tournamentId);

  // Column ranks and field means, computed once per map.
  //
  // The field mean deliberately excludes anomalies. Madeleine is the easiest
  // map in the MSU pool and every real score on it is above 94%, but one
  // abandoned attempt at 20% drags the raw mean to 84% and makes it read as the
  // hardest map on the board. Scores on a map that is simply beyond the player
  // - the 50s on Spin Eternally - are real and do count: that is how hard the
  // map proved to be.
  const columnStats = new Map<string, { ranked: string[]; mean: number | null }>();
  for (const leaderboardId of leaderboardIds) {
    const column = scores
      .filter((s) => s.leaderboardId === leaderboardId)
      .sort((a, b) => b.baseScore - a.baseScore);

    const clean = column.filter(
      (s) => !model.failKeys.has(failKey(s.playerId, s.leaderboardId)),
    );

    columnStats.set(leaderboardId, {
      ranked: column.map((s) => s.playerId),
      mean: clean.length
        ? clean.reduce((acc, s) => acc + s.accuracy, 0) / clean.length
        : null,
    });
  }

  const maps: BoardMap[] = pool.maps.map((pm) => ({
    poolMapId: pm.id,
    leaderboardId: pm.leaderboardId,
    name: pm.leaderboard.map.name,
    subName: pm.leaderboard.map.subName,
    mapper: pm.leaderboard.map.mapper,
    // A mapper's own name for the difficulty is what players call it - the
    // scrim sheet says "Safe Bet (Hard)", not "Hard".
    difficultyLabel:
      pm.label ?? displayDifficulty(pm.leaderboard.difficultyValue, pm.leaderboard.customName),
    difficultyValue: pm.leaderboard.difficultyValue,
    scatter: model.model.mapSigmaScale[pm.leaderboardId] ?? 1,
    customName: pm.leaderboard.customName,
    category: pm.category,
    maxScore: pm.leaderboard.maxScore,
    coverImage: pm.leaderboard.map.coverImage,
    isTiebreaker: pm.isTiebreaker,
    ranked: pm.leaderboard.ranked,
    stars: pm.leaderboard.stars,
    autoCategory: categorizeMap({
      acc: pm.leaderboard.accRating,
      pass: pm.leaderboard.passRating,
      tech: pm.leaderboard.techRating,
    }),
    ratings: {
      acc: pm.leaderboard.accRating,
      pass: pm.leaderboard.passRating,
      tech: pm.leaderboard.techRating,
    },
    fieldMeanAcc: columnStats.get(pm.leaderboardId)?.mean ?? null,
  }));

  const rows: BoardRow[] = members.map((member) => {
    const cells: BoardCell[] = leaderboardIds.map((leaderboardId) => {
      const score = scoreBy.get(`${member.player.id}::${leaderboardId}`);
      const prediction = model.model.predict(member.player.id, leaderboardId);
      const estimate =
        prediction.observedAcc == null
          ? model.estimates.get(failKey(member.player.id, leaderboardId))
          : undefined;
      const column = columnStats.get(leaderboardId);
      const rank = score ? (column?.ranked.indexOf(member.player.id) ?? -1) + 1 : null;

      return {
        leaderboardId,
        score: score?.baseScore ?? null,
        acc: score?.accuracy ?? null,
        // The classifier's verdict, not a second opinion.
        isDnf: model.failKeys.has(failKey(member.player.id, leaderboardId)),
        fullCombo: score?.fullCombo ?? false,
        misses: (score?.missedNotes ?? 0) + (score?.badCuts ?? 0),
        // The stored replayUrl is the raw .bsor file, which a browser downloads.
        // The viewer takes the score id and plays it.
        replayUrl: score?.beatLeaderScoreId
          ? `https://replay.beatleader.com/?scoreId=${score.beatLeaderScoreId}`
          : null,
        predictedAcc: estimate ?? prediction.acc,
        predictionConfidence: prediction.confidence,
        isEstimate: estimate != null,
        predictedLow: prediction.accLow,
        predictedHigh: prediction.accHigh,
        rank: rank && rank > 0 ? rank : null,
      };
    });

    const played = cells.filter((c) => c.acc != null);
    const counted = played.filter((c) => !c.isDnf);

    return {
      playerId: member.player.id,
      playerName: member.player.name,
      avatar: member.player.avatar,
      beatLeaderId: member.player.beatLeaderId,
      teamId: member.team.id,
      teamName: member.team.name,
      teamColor: member.team.color,
      teamColorSecondary: member.team.colorSecondary,
      available: member.available,
      cells,
      // Abandoned runs are left out, as the legend under the board promises.
      meanAcc: counted.length
        ? counted.reduce((acc, c) => acc + (c.acc ?? 0), 0) / counted.length
        : null,
      played: played.length,
    };
  });

  // Group into team blocks, mirroring how the sheets laid it out.
  const teamOrder: string[] = [];
  const byTeam = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const key = row.teamId ?? 'unassigned';
    if (!byTeam.has(key)) {
      byTeam.set(key, []);
      teamOrder.push(key);
    }
    byTeam.get(key)!.push(row);
  }

  return {
    poolId: pool.id,
    poolName: pool.name,
    maps,
    teams: teamOrder.map((key) => {
      const teamRows = byTeam.get(key)!;
      return {
        teamId: key === 'unassigned' ? null : key,
        teamName: teamRows[0]?.teamName ?? 'Unassigned',
        color: teamRows[0]?.teamColor ?? '#4F46E5',
        rows: teamRows,
      };
    }),
    model,
  };
}

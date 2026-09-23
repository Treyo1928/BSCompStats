import { isBestRunCandidate, noFailTriggered, notesHit, pickBestRun, runProgress } from '@bscs/core/stats';
import { prisma } from '@bscs/db';
import { difficultyLabel, displayDifficulty } from '@bscs/core/beatleader';
import type { StatsScope } from '@bscs/core/stats';
import { buildTournamentData, failKey, type TournamentData } from './stats';
import { loadRuns, loadScores, type ScoreSource, type StoredRun } from './score-sources';

/**
 * The pool board: every tracked player against every map in a pool.
 *
 * This is the direct replacement for the spreadsheet's qualifiers tab, with the
 * things a spreadsheet could not do: live updates, the runs behind a map
 * nobody has cleared, and abandoned runs called out. Every cell is something a
 * player actually did - an empty one is a map they have not played.
 */

export interface BoardCell {
  leaderboardId: string;
  /** Null when the player has no score on this map. */
  score: number | null;
  acc: number | null;
  /** An anomaly - abandoned or disastrous. Not merely a low score on a hard map. */
  isDnf: boolean;
  fullCombo: boolean;
  /** No Fail kicked in on this score: the player died partway and played on. */
  noFail: boolean;
  misses: number;
  /** BeatLeader's web replay viewer for this score. Null when the score has no id. */
  replayUrl: string | null;
  /** Where the score shown was set. Null when there is none. */
  platform: 'BL' | 'SS' | null;
  /** Rank within the column, 1-based. Null when unplayed. */
  rank: number | null;
  /**
   * The runs BeatLeader recorded here, where the player shows them. Null when
   * they do not, or have never started the map.
   */
  runs: CellRuns | null;
  /**
   * True when `acc` is not a clear but the player's best run of ten notes or more
   * seconds on a map they have never cleared - their score here all the same.
   */
  isRun: boolean;
}

export interface CellRuns {
  /** Every run that was a real go at the map: clears, fails, and quits well under way. */
  total: number;
  finished: number;
  fails: number;
  /** Restarts, and quits in the first seconds. */
  falseStarts: number;
  /**
   * The best run that hit ten notes or more without clearing: the highest
   * accuracy, which is the player's number on the map while they have no
   * clear. Null when none got that far.
   */
  bestTry: { acc: number; progress: number; seconds: number; notesHit: number; replayUrl: string | null } | null;
  /** Runs that hit fewer than ten notes, whose accuracy says nothing. */
  shortTries: number;
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
  /** Their team here is a match-only side, not one entered in the tournament. */
  teamAdHoc: boolean;
  /** False for an absent player or a sub who is not switched in. */
  available: boolean;
  /** Whether BeatLeader shows this player's runs: true, false, or null for not yet asked. */
  runsVisible: boolean | null;
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
  customName: string | null;
  maxScore: number;
  coverImage: string | null;
  isTiebreaker: boolean;
  /** What counts as a perfect score here, for match points: the organisers' figure. */
  perfectAcc: number | null;
  /** BeatLeader's predicted accuracy for the map, where it has one. */
  blPredictedAcc: number | null;
  ranked: boolean;
  stars: number;
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
    /** A side put together for a match. Listed apart from the tournament's own teams. */
    adHoc: boolean;
    rows: BoardRow[];
  }>;
  data: TournamentData;
}

/**
 * Who a tournament's boards and stats are about: everyone on a team entered in
 * it, plus any match-only side that still has something to play. Once a
 * match-only team's matches are over it drops off, rather than sitting on the
 * board forever as a second copy of players who are already there.
 */
export function loadBoardMembers(tournamentId: string) {
  return prisma.teamMember.findMany({
    where: {
      team: {
        division: { tournamentId },
        OR: [
          { adHoc: false },
          { matchesAsA: { some: { state: { not: 'COMPLETE' } } } },
          { matchesAsB: { some: { state: { not: 'COMPLETE' } } } },
          { draftsAsA: { some: { matchId: null } } },
          { draftsAsB: { some: { matchId: null } } },
        ],
      },
    },
    // Entered teams first, so a player also on a match-only side is met there first.
    orderBy: [{ team: { adHoc: 'asc' } }, { team: { name: 'asc' } }, { order: 'asc' }],
    select: {
      available: true,
      isSub: true,
      role: true,
      player: {
        select: {
          id: true,
          name: true,
          avatar: true,
          beatLeaderId: true,
          pp: true,
          rank: true,
          accPp: true,
          techPp: true,
          passPp: true,
          rankedPlayCount: true,
          userId: true,
          scoreSaberId: true,
          ssPp: true,
          ssRank: true,
          ssCountryRank: true,
          ssRankedPlayCount: true,
          ssAvgRankedAcc: true,
          ssSyncedAt: true,
        },
      },
      team: {
        select: { id: true, name: true, color: true, colorSecondary: true, adHoc: true },
      },
    },
  });
}

export async function buildPoolBoard(
  poolId: string,
  /** Look at it over a different set of scores than the tournament is set to. */
  overrideScope?: Partial<StatsScope>,
  /** Which platform's scores to show and learn from. */
  source: ScoreSource = 'both',
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
          label: true,
          isTiebreaker: true,
          perfectAcc: true,
          leaderboard: {
            select: {
              id: true,
              difficultyValue: true,
              customName: true,
              maxScore: true,
              ranked: true,
              stars: true,
              predictedAcc: true,
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

  const members = await loadBoardMembers(pool.tournamentId);

  const leaderboardIds = pool.maps.map((m) => m.leaderboardId);
  const playerIds = [...new Set(members.map((m) => m.player.id))];

  const scores = await loadScores(playerIds, { source, leaderboardIds });

  const scoreBy = new Map(scores.map((s) => [`${s.playerId}::${s.leaderboardId}`, s]));
  const known = source === 'scoresaber' ? null : await loadRuns(playerIds, leaderboardIds);
  const runsBy = summariseRuns(known?.runs ?? [], known?.durations ?? {});

  const data = await buildTournamentData(pool.tournamentId, overrideScope, source);

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
      (s) => !data.failKeys.has(failKey(s.playerId, s.leaderboardId)),
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
    customName: pm.leaderboard.customName,
    maxScore: pm.leaderboard.maxScore,
    coverImage: pm.leaderboard.map.coverImage,
    isTiebreaker: pm.isTiebreaker,
    perfectAcc: pm.perfectAcc,
    blPredictedAcc: pm.leaderboard.predictedAcc > 0 ? pm.leaderboard.predictedAcc : null,
    ranked: pm.leaderboard.ranked,
    stars: pm.leaderboard.stars,
    fieldMeanAcc: columnStats.get(pm.leaderboardId)?.mean ?? null,
  }));

  const rows: BoardRow[] = members.map((member) => {
    const cells: BoardCell[] = leaderboardIds.map((leaderboardId) => {
      const score = scoreBy.get(`${member.player.id}::${leaderboardId}`);
      const column = columnStats.get(leaderboardId);
      const rank = score ? (column?.ranked.indexOf(member.player.id) ?? -1) + 1 : null;
      const runs = runsBy.get(`${member.player.id}::${leaderboardId}`) ?? null;
      // No clear, but a run of ten notes or more: its accuracy is their score
      // here, shown and counted like one.
      const bestTry = !score && runs?.bestTry ? runs.bestTry : null;

      return {
        leaderboardId,
        score: score?.baseScore ?? null,
        acc: score?.accuracy ?? bestTry?.acc ?? null,
        // The classifier's verdict, not a second opinion.
        isDnf: data.failKeys.has(failKey(member.player.id, leaderboardId)),
        fullCombo: score?.fullCombo ?? false,
        noFail: noFailTriggered(score?.modifiers),
        misses: (score?.missedNotes ?? 0) + (score?.badCuts ?? 0),
        platform: score?.platform ?? null,
        // The stored replayUrl is the raw .bsor file, which a browser downloads.
        // The viewer takes the score id and plays it.
        replayUrl: score?.beatLeaderScoreId
          ? `https://replay.beatleader.com/?scoreId=${score.beatLeaderScoreId}`
          : bestTry?.replayUrl
            ? `https://replay.beatleader.com/?link=${encodeURIComponent(bestTry.replayUrl)}`
            : null,
        rank: rank && rank > 0 ? rank : null,
        runs,
        isRun: bestTry != null,
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
      teamAdHoc: member.team.adHoc,
      available: member.available,
      runsVisible: known?.visible.get(member.player.id) ?? null,
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
        adHoc: teamRows[0]?.teamAdHoc ?? false,
        rows: teamRows,
      };
    }),
    data,
  };
}

/** The least of a song a run must cover to be a real go at it rather than a false start. */
const REAL_RUN_PROGRESS = 0.2;

function summariseRuns(runs: StoredRun[], durations: Record<string, number>): Map<string, CellRuns> {
  const out = new Map<string, CellRuns>();
  const candidates = new Map<string, StoredRun[]>();
  for (const run of runs) {
    const key = `${run.playerId}::${run.leaderboardId}`;
    const cell = out.get(key) ?? { total: 0, finished: 0, fails: 0, falseStarts: 0, bestTry: null, shortTries: 0 };
    const progress = runProgress(run, durations[run.leaderboardId]);
    switch (run.endType) {
      case 'CLEAR':
        cell.total++;
        cell.finished++;
        break;
      case 'FAIL':
        cell.total++;
        cell.fails++;
        break;
      case 'QUIT':
        if (progress >= REAL_RUN_PROGRESS) {
          cell.total++;
          cell.fails++;
        } else {
          cell.falseStarts++;
        }
        break;
      case 'RESTART':
        cell.falseStarts++;
        break;
      default:
        break;
    }
    if (run.endType === 'FAIL' || run.endType === 'RESTART' || run.endType === 'QUIT') {
      if (isBestRunCandidate(run)) {
        const list = candidates.get(key) ?? [];
        list.push(run);
        candidates.set(key, list);
      } else {
        cell.shortTries++;
      }
    }
    out.set(key, cell);
  }
  // The same choice the model makes: the longest run, or the most accurate
  // within a tenth of the song of it.
  for (const [key, list] of candidates) {
    const run = pickBestRun(list, durations[run0(list).leaderboardId]);
    out.get(key)!.bestTry = {
      acc: run.accuracy,
      progress: runProgress(run, durations[run.leaderboardId]),
      seconds: run.time,
      notesHit: notesHit(run),
      replayUrl: run.replayUrl,
    };
  }
  return out;
}

const run0 = (list: StoredRun[]): StoredRun => list[0]!;

import { prisma } from '@bscs/db';
import {
  parseFormat,
  currentStep,
  prepareAction,
  resolveMapPlan,
  isComplete,
  remainingMapIds,
  validateLineups,
  legalAdditions,
  displayDifficulty,
  type MatchFormat,
  type PickBanContext,
  type LineupInput,
  type ValidationResult,
} from './match-helpers';
import { mapResult, type CountedRun, type MapResult, type Scoring } from '@bscs/core/match';
import { perfectAccOf, scoringOf, tallyMaps } from './match-summary';

/** Everything the match room needs, assembled in one place. */

export interface MatchView {
  id: string;
  name: string;
  state: 'SETUP' | 'PICKBAN' | 'PLAYING' | 'COMPLETE';
  tournament: {
    id: string;
    slug: string;
    name: string;
    isPublic: boolean;
    captainsEnterScores: boolean;
    captainsPullScores: boolean;
  };
  /** How this match is scored, fixed when it was made. */
  scoring: Scoring;
  /** Lineups stay hidden from the other side until both teams have set every map. */
  blindLineups: boolean;
  /** Left off the tournament's match lists; the link still opens it. */
  unlisted: boolean;
  /** Set when the match was completed with a winner; null for a draw or an unfinished match. */
  winnerId: string | null;
  format: MatchFormat;
  teamA: TeamView;
  teamB: TeamView;
  coinFlipWinnerId: string | null;
  pool: {
    id: string;
    name: string;
    maps: PoolMapView[];
  };
  actions: Array<{
    seq: number;
    type: 'PICK' | 'BAN';
    teamId: string;
    teamName: string;
    poolMapId: string;
    mapName: string;
    actingUserName: string | null;
    onBehalf: boolean;
    createdAt: Date;
  }>;
  /** Null once pick/ban is over. */
  pending: { seq: number; type: 'PICK' | 'BAN'; teamId: string; availableMapIds: string[] } | null;
  plannedMaps: Array<{
    order: number;
    poolMapId: string;
    matchMapId: string | null;
    isTiebreaker: boolean;
    pickedByTeamId: string | null;
    map: PoolMapView;
    lineups: Record<string, string[]>;
    /** The runs that count, per team. */
    scores: Record<string, MatchScore[]>;
    /** Every go at the map per team, scored as a whole, and which one counted. */
    goes: Record<string, MatchGo[]>;
    /** team -> the rules its lineup here was saved in spite of, if any. */
    ruleBreaks: Record<string, string>;
    /** Every run as entered: team -> player -> attempt number -> the score shown in game, and whether they failed. */
    runs: Record<string, Record<string, Record<number, { shown: number; failed: boolean }>>>;
    /** Teams that have spent a replay here; each adds one more run of the map. */
    replayCalledByTeamIds: string[];
    /** Someone has said this map's scores are final. */
    scoresClosed: boolean;
    /** Who took the map and by how much, under the match's scoring. */
    result: MapResult;
  }>;
  scoreboard: { a: number; b: number };
}

/** One team's go at a map: first run, replay... */
export interface MatchGo {
  attempt: number;
  accEquivalent: number;
  points: number | null;
  /** Everyone who has posted on the map posted on this go. */
  complete: boolean;
  /** This go's runs are the ones that count. */
  counted: boolean;
  runs: MatchScore[];
}

export interface MatchScore {
  playerId: string;
  playerName: string;
  /** The go it was from: 1 for the first run, 2 for the first replay... */
  attempt: number;
  /** As it counts: a fail halved unless the match counts fails double. */
  score: number;
  accuracy: number;
  /** Match points, under MATCH_POINTS scoring where the map has a perfect accuracy. */
  points: number | null;
  /** AUTO when pulled from BeatLeader, MANUAL when typed in. */
  source: string;
  /** How the run ended, where it came from BeatLeader. */
  endType: string | null;
  /** They failed; No Fail halved it. Counted doubled back only under `scoring.doubleFails`. */
  failed: boolean;
  /** BeatLeader's replay viewer for the run, where there is one. */
  replayUrl: string | null;
}

export interface TeamView {
  id: string;
  name: string;
  color: string;
  colorSecondary: string | null;
  players: Array<{ id: string; name: string; avatar: string | null }>;
}

export interface PoolMapView {
  poolMapId: string;
  leaderboardId: string;
  name: string;
  mapper: string | null;
  coverImage: string | null;
  difficultyLabel: string;
  /** BeatLeader's numeric difficulty (1 Easy .. 9 Expert+), for colouring. */
  difficultyValue: number;
  maxScore: number;
  isTiebreaker: boolean;
  /** Song length in seconds, where known. */
  duration: number;
  /** What counts as a perfect score here, for match points, and whose figure it is. */
  perfectAcc: number | null;
  perfectSource: 'ORGANISERS' | 'BEATLEADER' | null;
}

export async function loadMatch(matchId: string): Promise<MatchView | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      tournament: {
        select: {
          id: true,
          slug: true,
          name: true,
          isPublic: true,
          defaultFormat: true,
          captainsEnterScores: true,
          captainsPullScores: true,
          perfectFromBeatLeader: true,
        },
      },
      teamA: { include: { members: { orderBy: { order: 'asc' }, include: { player: true } } } },
      teamB: { include: { members: { orderBy: { order: 'asc' }, include: { player: true } } } },
      pool: {
        include: {
          maps: {
            orderBy: { order: 'asc' },
            include: { leaderboard: { include: { map: true } } },
          },
        },
      },
      actions: {
        where: { undoneAt: null },
        orderBy: { seq: 'asc' },
        include: {
          team: { select: { name: true } },
          poolMap: { include: { leaderboard: { include: { map: true } } } },
          actingUser: { select: { name: true } },
          onBehalfOfUser: { select: { id: true } },
        },
      },
      maps: {
        orderBy: { order: 'asc' },
        include: {
          poolMap: { include: { leaderboard: { include: { map: true } } } },
          lineups: { include: { slots: { orderBy: { slot: 'asc' }, include: { player: true } } } },
          attempts: { include: { player: { select: { name: true } } }, orderBy: { attempt: 'asc' } },
        },
      },
    },
  });
  if (!match) return null;

  const format = parseFormat(match.format ?? match.tournament.defaultFormat);

  const scoring = scoringOf(match);
  const toPoolMapView = (pm: {
    id: string;
    leaderboardId: string;
    label: string | null;
    isTiebreaker: boolean;
    perfectAcc: number | null;
    leaderboard: {
      difficultyValue: number;
      customName: string | null;
      maxScore: number;
      duration: number;
      predictedAcc: number;
      map: { name: string; mapper: string | null; coverImage: string | null; duration: number };
    };
  }): PoolMapView => {
    const perfect = perfectAccOf(pm, match.tournament.perfectFromBeatLeader);
    return {
    poolMapId: pm.id,
    leaderboardId: pm.leaderboardId,
    name: pm.leaderboard.map.name,
    mapper: pm.leaderboard.map.mapper,
    coverImage: pm.leaderboard.map.coverImage,
    difficultyValue: pm.leaderboard.difficultyValue,
    difficultyLabel:
      pm.label ?? displayDifficulty(pm.leaderboard.difficultyValue, pm.leaderboard.customName),
    maxScore: pm.leaderboard.maxScore,
    isTiebreaker: pm.isTiebreaker,
    duration: pm.leaderboard.duration || pm.leaderboard.map.duration,
    perfectAcc: perfect.value,
    perfectSource: perfect.source,
    };
  };

  const poolMaps = match.pool.maps.map(toPoolMapView);
  const poolMapById = new Map(poolMaps.map((pm) => [pm.poolMapId, pm]));

  const ctx = buildPickBanContext(match, format);
  const pending = currentStep(ctx);
  const plan = resolveMapPlan(ctx);

  const matchMapByPoolMap = new Map(match.maps.map((mm) => [mm.poolMapId, mm]));

  const plannedMaps = plan.map((entry) => {
    const matchMap = matchMapByPoolMap.get(entry.poolMapId);
    const map = poolMapById.get(entry.poolMapId)!;
    const lineups: Record<string, string[]> = {};
    const runs: Record<string, Record<string, Record<number, { shown: number; failed: boolean }>>> = {};
    const ruleBreaks: Record<string, string> = {};

    for (const lineup of matchMap?.lineups ?? []) {
      if (lineup.ruleBreaks) ruleBreaks[lineup.teamId] = lineup.ruleBreaks;
      lineups[lineup.teamId] = lineup.slots.map((s) => s.playerId);
    }

    const attempts = matchMap?.attempts ?? [];
    for (const attempt of attempts) {
      ((runs[attempt.teamId] ??= {})[attempt.playerId] ??= {})[attempt.attempt] = {
        // A failed run is stored doubled; the results screen showed half.
        shown: attempt.failed ? Math.round(attempt.score / 2) : attempt.score,
        failed: attempt.failed,
      };
    }

    // A map replayed after a technical issue has more than one go; which
    // runs count is the match's rule, and the rules for that live in one place.
    const result = mapResult(attempts, [match.teamAId, match.teamBId], scoring, map.perfectAcc);
    const toScore = (teamId: string, counted: CountedRun): MatchScore => {
      const run = attempts.find(
        (a) => a.teamId === teamId && a.playerId === counted.playerId && a.attempt === counted.attempt,
      )!;
      return {
        playerId: counted.playerId,
        playerName: run.player.name,
        attempt: counted.attempt,
        score: counted.score,
        accuracy: counted.accuracy,
        points: counted.points,
        source: run.source,
        endType: run.endType,
        failed: run.failed,
        replayUrl: replayViewer(run),
      };
    };
    const scores: Record<string, MatchScore[]> = {};
    const goes: Record<string, MatchGo[]> = {};
    for (const [teamId, team] of Object.entries(result.teams)) {
      scores[teamId] = team.runs.map((counted) => toScore(teamId, counted));
      goes[teamId] = team.goes.map((go) => ({
        attempt: go.attempt,
        accEquivalent: go.accEquivalent,
        points: go.points,
        complete: go.complete,
        counted: go.counted,
        runs: go.runs.map((counted) => toScore(teamId, counted)),
      }));
    }

    return {
      order: entry.order,
      poolMapId: entry.poolMapId,
      matchMapId: matchMap?.id ?? null,
      isTiebreaker: entry.isTiebreaker,
      pickedByTeamId: entry.pickedByTeamId,
      map,
      lineups,
      ruleBreaks,
      scores,
      goes,
      runs,
      replayCalledByTeamIds: matchMap?.replayCalledByTeamIds ?? [],
      scoresClosed: matchMap?.scoresClosedAt != null,
      result,
    };
  });

  // Map wins, the same count completeMatch and the previews use.
  const { a, b } = tallyMaps(
    plannedMaps.map((planned) => ({
      isTiebreaker: planned.isTiebreaker,
      attempts: matchMapByPoolMap.get(planned.poolMapId)?.attempts ?? [],
    })),
    match.teamAId,
    match.teamBId,
    match,
  );

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    tournament: match.tournament,
    scoring,
    blindLineups: match.blindLineups,
    unlisted: match.unlisted,
    winnerId: match.winnerId,
    format,
    teamA: toTeamView(match.teamA, match.state === 'COMPLETE'),
    teamB: toTeamView(match.teamB, match.state === 'COMPLETE'),
    coinFlipWinnerId: match.coinFlipWinnerId,
    pool: { id: match.pool.id, name: match.pool.name, maps: poolMaps },
    actions: match.actions.map((action) => ({
      seq: action.seq,
      type: action.type,
      teamId: action.teamId,
      teamName: action.team.name,
      poolMapId: action.poolMapId,
      mapName: action.poolMap.leaderboard.map.name,
      actingUserName: action.actingUser?.name ?? null,
      onBehalf: Boolean(action.onBehalfOfUserId && action.onBehalfOfUserId !== action.actingUserId),
      createdAt: action.createdAt,
    })),
    pending,
    plannedMaps,
    scoreboard: { a, b },
  };
}

function toTeamView(team: {
  id: string;
  name: string;
  color: string;
  colorSecondary: string | null;
  members: Array<{
    available: boolean;
    player: { id: string; name: string; avatar: string | null };
  }>;
}, everyone: boolean): TeamView {
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    colorSecondary: team.colorSecondary,
    // Subs who are not switched in, and anyone absent, cannot be fielded - so
    // they are not offered in lineups. A finished
    // match keeps everyone, since its lineups name whoever actually played.
    players: team.members
      .filter((m) => everyone || m.available)
      .map((m) => ({
        id: m.player.id,
        name: m.player.name,
        avatar: m.player.avatar,
      })),
  };
}

export function buildPickBanContext(
  match: {
    teamAId: string;
    teamBId: string;
    coinFlipWinnerId: string | null;
    pool: { maps: Array<{ id: string; isTiebreaker: boolean }> };
    actions: Array<{ seq: number; type: 'PICK' | 'BAN'; teamId: string; poolMapId: string }>;
  },
  format: MatchFormat,
): PickBanContext {
  const coinWinnerTeamId = match.coinFlipWinnerId ?? match.teamAId;
  const coinLoserTeamId =
    coinWinnerTeamId === match.teamAId ? match.teamBId : match.teamAId;

  const designated =
    format.tiebreaker === 'DESIGNATED'
      ? (match.pool.maps.find((m) => m.isTiebreaker)?.id ?? null)
      : null;

  return {
    format,
    poolMapIds: match.pool.maps.map((m) => m.id),
    coinWinnerTeamId,
    coinLoserTeamId,
    designatedTiebreakerId: designated,
    actions: match.actions.map((a) => ({
      seq: a.seq,
      type: a.type,
      teamId: a.teamId,
      poolMapId: a.poolMapId,
    })),
  };
}

/**
 * BeatLeader's web replay viewer for a match run. It plays a score by its id,
 * or any run from the link to its .bsor - which is all a fail has.
 */
function replayViewer(run: { beatLeaderScoreId: number | null; replayUrl: string | null }): string | null {
  if (run.beatLeaderScoreId) return `https://replay.beatleader.com/?scoreId=${run.beatLeaderScoreId}`;
  if (run.replayUrl) return `https://replay.beatleader.com/?link=${encodeURIComponent(run.replayUrl)}`;
  return null;
}

export {
  prepareAction,
  isComplete,
  remainingMapIds,
  validateLineups,
  legalAdditions,
  type LineupInput,
  type ValidationResult,
};

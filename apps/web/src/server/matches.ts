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
import { buildTournamentModel, predictorFor, type TournamentModel } from './stats';
import {
  evaluateMaps,
  recommendAction,
  recommendLineups,
  type MapValue,
  type ActionAdvice,
  type SimMap,
  type LineupMap,
} from '@bscs/core/optimize';

/** Everything the match room needs, assembled in one place. */

export interface MatchView {
  id: string;
  name: string;
  state: 'SETUP' | 'PICKBAN' | 'PLAYING' | 'COMPLETE';
  tournament: { id: string; slug: string; name: string; isPublic: boolean };
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
    scores: Record<string, Array<{ playerId: string; playerName: string; score: number; accuracy: number }>>;
    totals: Record<string, number>;
  }>;
  scoreboard: { a: number; b: number };
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
  category: string | null;
  maxScore: number;
  isTiebreaker: boolean;
}

export async function loadMatch(matchId: string): Promise<MatchView | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      tournament: { select: { id: true, slug: true, name: true, isPublic: true, defaultFormat: true } },
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
          attempts: { include: { player: { select: { name: true } } } },
        },
      },
    },
  });
  if (!match) return null;

  const format = parseFormat(match.format ?? match.tournament.defaultFormat);

  const toPoolMapView = (pm: {
    id: string;
    leaderboardId: string;
    category: string | null;
    label: string | null;
    isTiebreaker: boolean;
    leaderboard: {
      difficultyValue: number;
      customName: string | null;
      maxScore: number;
      map: { name: string; mapper: string | null; coverImage: string | null };
    };
  }): PoolMapView => ({
    poolMapId: pm.id,
    leaderboardId: pm.leaderboardId,
    name: pm.leaderboard.map.name,
    mapper: pm.leaderboard.map.mapper,
    coverImage: pm.leaderboard.map.coverImage,
    difficultyValue: pm.leaderboard.difficultyValue,
    difficultyLabel:
      pm.label ?? displayDifficulty(pm.leaderboard.difficultyValue, pm.leaderboard.customName),
    category: pm.category,
    maxScore: pm.leaderboard.maxScore,
    isTiebreaker: pm.isTiebreaker,
  });

  const poolMaps = match.pool.maps.map(toPoolMapView);
  const poolMapById = new Map(poolMaps.map((pm) => [pm.poolMapId, pm]));

  const ctx = buildPickBanContext(match, format);
  const pending = currentStep(ctx);
  const plan = resolveMapPlan(ctx);

  const matchMapByPoolMap = new Map(match.maps.map((mm) => [mm.poolMapId, mm]));

  const plannedMaps = plan.map((entry) => {
    const matchMap = matchMapByPoolMap.get(entry.poolMapId);
    const lineups: Record<string, string[]> = {};
    const scores: Record<string, Array<{ playerId: string; playerName: string; score: number; accuracy: number }>> = {};
    const totals: Record<string, number> = {};

    for (const lineup of matchMap?.lineups ?? []) {
      lineups[lineup.teamId] = lineup.slots.map((s) => s.playerId);
    }

    // A map replayed after a technical issue produces a second attempt; the
    // counted score is each player's best.
    for (const attempt of matchMap?.attempts ?? []) {
      const list = (scores[attempt.teamId] ??= []);
      const existing = list.find((s) => s.playerId === attempt.playerId);
      if (existing) {
        if (attempt.score > existing.score) {
          existing.score = attempt.score;
          existing.accuracy = attempt.accuracy;
        }
      } else {
        list.push({
          playerId: attempt.playerId,
          playerName: attempt.player.name,
          score: attempt.score,
          accuracy: attempt.accuracy,
        });
      }
    }

    for (const [teamId, list] of Object.entries(scores)) {
      totals[teamId] = list.reduce((acc, s) => acc + s.score, 0);
    }

    return {
      order: entry.order,
      poolMapId: entry.poolMapId,
      matchMapId: matchMap?.id ?? null,
      isTiebreaker: entry.isTiebreaker,
      pickedByTeamId: entry.pickedByTeamId,
      map: poolMapById.get(entry.poolMapId)!,
      lineups,
      scores,
      totals,
    };
  });

  // Map wins, excluding the tiebreaker unless the regular maps finished level.
  let a = 0;
  let b = 0;
  for (const planned of plannedMaps.filter((m) => !m.isTiebreaker)) {
    const totalA = planned.totals[match.teamAId];
    const totalB = planned.totals[match.teamBId];
    if (totalA == null || totalB == null) continue;
    if (totalA > totalB) a++;
    else if (totalB > totalA) b++;
  }
  if (a === b) {
    const tb = plannedMaps.find((m) => m.isTiebreaker);
    const totalA = tb?.totals[match.teamAId];
    const totalB = tb?.totals[match.teamBId];
    if (totalA != null && totalB != null) {
      if (totalA > totalB) a++;
      else if (totalB > totalA) b++;
    }
  }

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    tournament: match.tournament,
    format,
    teamA: toTeamView(match.teamA),
    teamB: toTeamView(match.teamB),
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
  members: Array<{ player: { id: string; name: string; avatar: string | null } }>;
}): TeamView {
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    colorSecondary: team.colorSecondary,
    players: team.members.map((m) => ({
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

// ---------------------------------------------------------------------------
//  Advice
// ---------------------------------------------------------------------------

export interface MatchAdvice {
  /** Every pool map scored from the given team's point of view. */
  mapValues: MapValue[];
  /** Ranked advice for the action currently on the clock. */
  actionAdvice: ActionAdvice[];
  /** Recommended lineups, by objective. */
  lineups: {
    winProbability: { lineups: LineupMap; winProbability: number; expectedMargin: number; conceded: string[] } | null;
    expectedMargin: { lineups: LineupMap; winProbability: number; expectedMargin: number; conceded: string[] } | null;
  };
  /** Why there is no lineup advice, when there is none. */
  lineupsInfeasible: string | null;
  model: TournamentModel;
}

export async function buildAdvice(
  match: MatchView,
  forTeamId: string,
): Promise<MatchAdvice> {
  const model = await buildTournamentModel(match.tournament.id);
  const predict = predictorFor(model);

  const ourTeam = forTeamId === match.teamA.id ? match.teamA : match.teamB;
  const theirTeam = forTeamId === match.teamA.id ? match.teamB : match.teamA;

  const poolSimMaps: SimMap[] = match.pool.maps.map((pm) => ({
    id: pm.poolMapId,
    leaderboardId: pm.leaderboardId,
    maxScore: pm.maxScore,
    isTiebreaker: pm.isTiebreaker,
  }));

  const setup = {
    maps: poolSimMaps,
    format: match.format,
    // A Set: a shared player is on both rosters but is one person with one run.
    playerIds: [...new Set([...ourTeam.players, ...theirTeam.players].map((p) => p.id))],
    predict,
    iterations: 10_000,
    seed: hashSeed(match.id),
  };

  const mapValues =
    ourTeam.players.length >= match.format.playersPerMap &&
    theirTeam.players.length >= match.format.playersPerMap
      ? evaluateMaps({
          maps: poolSimMaps,
          format: match.format,
          ourRoster: ourTeam.players.map((p) => p.id),
          theirRoster: theirTeam.players.map((p) => p.id),
          setup,
        })
      : [];

  const actionAdvice = match.pending
    ? recommendAction(match.pending.type, match.pending.availableMapIds, mapValues)
    : [];

  // Lineup advice only makes sense once the maps are known.
  const playedSimMaps: SimMap[] = match.plannedMaps.map((pm) => ({
    id: pm.poolMapId,
    leaderboardId: pm.map.leaderboardId,
    maxScore: pm.map.maxScore,
    isTiebreaker: pm.isTiebreaker,
  }));

  const lineups: MatchAdvice['lineups'] = { winProbability: null, expectedMargin: null };
  let lineupsInfeasible: string | null = null;

  // ...and all of them: appearance limits and the duo rule are about the whole
  // card, so advice for a half-picked one is either wrong or "impossible".
  if (
    !match.pending &&
    playedSimMaps.length &&
    ourTeam.players.length >= match.format.playersPerMap
  ) {
    // The opponent's lineups are rarely known in advance, so assume they field
    // a reasonable spread rather than pretending we can see their card.
    const opponentLineups = assumeOpponentLineups(
      theirTeam.players.map((p) => p.id),
      playedSimMaps,
      match.format.playersPerMap,
    );

    for (const objective of ['WIN_PROBABILITY', 'EXPECTED_MARGIN'] as const) {
      const result = recommendLineups(
        { ...setup, maps: playedSimMaps },
        {
          maps: playedSimMaps,
          format: match.format,
          roster: ourTeam.players.map((p) => p.id),
          opponentLineups,
          objective,
        },
      );
      if (result.best) {
        const key = objective === 'WIN_PROBABILITY' ? 'winProbability' : 'expectedMargin';
        lineups[key] = {
          lineups: result.best.lineups,
          winProbability: result.best.winProbability,
          expectedMargin: result.best.expectedMargin,
          conceded: result.best.concededMapIds,
        };
      } else if (result.infeasible) {
        lineupsInfeasible = result.infeasible;
      }
    }
  }

  return { mapValues, actionAdvice, lineups, lineupsInfeasible, model };
}

/** A plausible opponent card: rotate through their roster evenly. */
function assumeOpponentLineups(
  roster: readonly string[],
  maps: readonly SimMap[],
  playersPerMap: number,
): LineupMap {
  const lineups: Record<string, string[]> = {};
  if (roster.length < playersPerMap) return lineups;

  let cursor = 0;
  for (const map of maps) {
    const group: string[] = [];
    for (let i = 0; i < playersPerMap; i++) {
      group.push(roster[cursor % roster.length]!);
      cursor++;
    }
    lineups[map.id] = group;
  }
  return lineups;
}

/** Stable per-match seed, so a reload shows the same numbers. */
function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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

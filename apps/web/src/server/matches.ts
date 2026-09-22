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
import { runMatchAdvice } from './advice-thread';
import { tallyMaps } from './match-summary';
import { announceMatchChange } from '@/lib/redis';
import type { MatchAdviceInput, MatchAdviceResult, SimMap } from '@bscs/core/optimize';

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
  };
  /** Lineups stay hidden from the other side until both teams have set every map. */
  blindLineups: boolean;
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
    scores: Record<string, Array<{ playerId: string; playerName: string; score: number; accuracy: number }>>;
    /** team -> the rules its lineup here was saved in spite of, if any. */
    ruleBreaks: Record<string, string>;
    /** Every run as entered: team -> player -> attempt number -> score. */
    runs: Record<string, Record<string, Record<number, number>>>;
    /** Teams that have spent a replay here; each adds one more run of the map. */
    replayCalledByTeamIds: string[];
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
      tournament: {
        select: {
          id: true,
          slug: true,
          name: true,
          isPublic: true,
          defaultFormat: true,
          captainsEnterScores: true,
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
    const runs: Record<string, Record<string, Record<number, number>>> = {};
    const ruleBreaks: Record<string, string> = {};

    for (const lineup of matchMap?.lineups ?? []) {
      if (lineup.ruleBreaks) ruleBreaks[lineup.teamId] = lineup.ruleBreaks;
      lineups[lineup.teamId] = lineup.slots.map((s) => s.playerId);
    }

    // A map replayed after a technical issue produces a second attempt; the
    // counted score is each player's best.
    for (const attempt of matchMap?.attempts ?? []) {
      ((runs[attempt.teamId] ??= {})[attempt.playerId] ??= {})[attempt.attempt] = attempt.score;
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
      ruleBreaks,
      scores,
      runs,
      replayCalledByTeamIds: matchMap?.replayCalledByTeamIds ?? [],
      totals,
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
  );

  return {
    id: match.id,
    name: match.name,
    state: match.state,
    tournament: match.tournament,
    blindLineups: match.blindLineups,
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
    // they are not offered in lineups or counted by the advice. A finished
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

// ---------------------------------------------------------------------------
//  Advice
// ---------------------------------------------------------------------------

export interface MatchAdvice extends MatchAdviceResult {
  model: TournamentModel;
  /**
   * True while the numbers are still being worked out on the advice thread.
   * What is shown meanwhile is the previous advice for this match and side, or
   * nothing yet; the page is told to refresh when the real thing lands.
   */
  calculating: boolean;
}

const EMPTY_ADVICE: MatchAdviceResult = {
  mapValues: [],
  actionAdvice: [],
  lineups: { winProbability: null, expectedMargin: null },
  lineupsInfeasible: null,
};

/** Finished advice per match and side, and what is being computed for each. */
const adviceCache = new Map<string, { key: string; result: MatchAdviceResult }>();
const adviceInFlight = new Map<string, string>();

/**
 * Advice for a match from one team's side - without ever making the page wait.
 *
 * The simulation is seconds of CPU. It runs on its own thread (see
 * advice-thread.ts), and this returns straight away: the finished advice if
 * its inputs have not changed, otherwise whatever was last known, flagged as
 * `calculating`. When the thread finishes, every open copy of the match page
 * is told to refresh over the same channel picks and bans use, and that render
 * finds the result waiting here.
 */
export async function buildAdvice(match: MatchView, forTeamId: string): Promise<MatchAdvice> {
  const model = await buildTournamentModel(match.tournament.id);
  const predict = predictorFor(model);

  const ourTeam = forTeamId === match.teamA.id ? match.teamA : match.teamB;
  const theirTeam = forTeamId === match.teamA.id ? match.teamB : match.teamA;
  const ourRoster = ourTeam.players.map((p) => p.id);
  const theirRoster = theirTeam.players.map((p) => p.id);

  const toSimMap = (pm: { poolMapId: string; leaderboardId: string; maxScore: number; isTiebreaker: boolean }): SimMap => ({
    id: pm.poolMapId,
    leaderboardId: pm.leaderboardId,
    maxScore: pm.maxScore,
    isTiebreaker: pm.isTiebreaker,
  });
  const poolMaps = match.pool.maps.map(toSimMap);
  const playedMaps = match.plannedMaps.map((pm) =>
    toSimMap({
      poolMapId: pm.poolMapId,
      leaderboardId: pm.map.leaderboardId,
      maxScore: pm.map.maxScore,
      isTiebreaker: pm.isTiebreaker,
    }),
  );

  // The model is closures and cannot cross to a thread, so flatten what the
  // simulation will ask it into a table. A few hundred cheap lookups.
  const predictions: MatchAdviceInput['predictions'] = {};
  for (const playerId of new Set([...ourRoster, ...theirRoster])) {
    const row: Record<string, ReturnType<typeof predict>> = {};
    for (const map of poolMaps) row[map.leaderboardId] = predict(playerId, map.leaderboardId);
    predictions[playerId] = row;
  }

  const input: MatchAdviceInput = {
    format: match.format,
    poolMaps,
    playedMaps,
    ourRoster,
    theirRoster,
    predictions,
    pending: match.pending
      ? { type: match.pending.type, availableMapIds: match.pending.availableMapIds }
      : null,
    iterations: 10_000,
    seed: hashSeed(match.id),
  };

  // Per viewer where the viewer has estimates of their own (they are part of
  // `predictions`), so two people with different opinions do not evict each other.
  const slot = `${match.id}:${forTeamId}:${model.estimates.size ? model.version.split('|viewer:')[1] : ''}`;
  const key = JSON.stringify(input);

  const cached = adviceCache.get(slot);
  if (cached?.key === key) return { ...cached.result, model, calculating: false };

  if (adviceInFlight.get(slot) !== key) {
    adviceInFlight.set(slot, key);
    void runMatchAdvice(input)
      .then((result) => {
        // Only if this is still what the slot wants: a pick made meanwhile has
        // already queued its own job, and this answer is to the old question.
        if (adviceInFlight.get(slot) !== key) return;
        adviceInFlight.delete(slot);
        adviceCache.set(slot, { key, result });
        // Matches finish; their advice need not be held for ever.
        if (adviceCache.size > 200) adviceCache.delete(adviceCache.keys().next().value!);
        return announceMatchChange(match.id);
      })
      .catch((err) => {
        if (adviceInFlight.get(slot) === key) adviceInFlight.delete(slot);
        console.error('[advice] failed:', err);
      });
  }

  // Stale beats blank for map values, which barely move between picks. Lineup
  // advice for a different card would mislead, so that waits for the real one.
  const stale = cached?.result;
  return {
    ...EMPTY_ADVICE,
    mapValues: stale?.mapValues ?? [],
    model,
    calculating: true,
  };
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

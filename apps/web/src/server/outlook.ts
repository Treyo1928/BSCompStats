import { prisma } from '@bscs/db';
import { evaluateMaps, type SimMap } from '@bscs/core/optimize';
import { parseFormat } from './match-helpers';
import { predictorFor } from './stats';
import type { PoolBoard } from './board';

/**
 * A pool seen from one team's side: who they should field on each map, how
 * that group is expected to score, and - against a chosen opponent - how likely
 * they are to take it.
 *
 * The match page already does this for a specific match. This is the same
 * question asked ahead of time, for any pairing, so a team can study a pool
 * before a match exists. It reads only what the board already shows publicly.
 */

export interface OutlookPlayer {
  id: string;
  name: string;
  avatar: string | null;
}

export interface OutlookMap {
  poolMapId: string;
  /** The team's strongest group on this map. */
  lineup: OutlookPlayer[];
  /** Mean accuracy that group is expected to post. */
  lineupAcc: number | null;
  /** Filled only when there is an opponent to measure against. */
  versus: {
    /** The two groups shown, head to head. */
    winProbability: number;
    /** Averaged over every group either side could field instead. */
    anyPairing: number;
    opponentLineup: OutlookPlayer[];
  } | null;
}

export interface PoolOutlook {
  playersPerMap: number;
  formatName: string;
  maps: OutlookMap[];
  /** Why there are no lineups, when the roster is too small to field one. */
  shortHanded: string | null;
}

export async function buildPoolOutlook(
  board: PoolBoard,
  tournamentId: string,
  teamId: string,
  opponentTeamId: string | null,
): Promise<PoolOutlook | null> {
  const team = board.teams.find((t) => t.teamId === teamId);
  if (!team) return null;
  const opponent = opponentTeamId
    ? (board.teams.find((t) => t.teamId === opponentTeamId && t.teamId !== teamId) ?? null)
    : null;

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { defaultFormat: true },
  });
  const format = parseFormat(tournament?.defaultFormat);
  const k = format.playersPerMap;

  const predict = predictorFor(board.model);
  const people = new Map<string, OutlookPlayer>();
  for (const t of board.teams) {
    for (const row of t.rows) {
      people.set(row.playerId, { id: row.playerId, name: row.playerName, avatar: row.avatar });
    }
  }
  const toPlayers = (ids: readonly string[]) =>
    ids.map((id) => people.get(id)).filter((p): p is OutlookPlayer => Boolean(p));
  const meanAcc = (ids: readonly string[], leaderboardId: string) =>
    ids.length ? ids.reduce((sum, id) => sum + predict(id, leaderboardId).acc, 0) / ids.length : null;

  const roster = team.rows.map((r) => r.playerId);
  if (roster.length < k) {
    return {
      playersPerMap: k,
      formatName: format.name,
      maps: [],
      shortHanded: `${team.teamName} has ${roster.length} player${roster.length === 1 ? '' : 's'}, and this format fields ${k} per map.`,
    };
  }

  const simMaps: SimMap[] = board.maps.map((m) => ({
    id: m.poolMapId,
    leaderboardId: m.leaderboardId,
    maxScore: m.maxScore,
    isTiebreaker: m.isTiebreaker,
  }));

  const opponentRoster = opponent?.rows.map((r) => r.playerId) ?? [];
  const values =
    opponent && opponentRoster.length >= k
      ? new Map(
          evaluateMaps({
            maps: simMaps,
            format,
            ourRoster: roster,
            theirRoster: opponentRoster,
            setup: {
              maps: simMaps,
              format,
              playerIds: [...new Set([...roster, ...opponentRoster])],
              predict,
              // Fewer draws than a match page: this re-renders on every live
              // score, and nobody is making a pick off the second decimal here.
              iterations: 4_000,
              seed: 1,
            },
          }).map((v) => [v.mapId, v]),
        )
      : null;

  const maps = board.maps.map((map): OutlookMap => {
    const value = values?.get(map.poolMapId);
    // Without an opponent there is nothing to simulate against, so the best
    // group is simply the k players expected to score highest.
    const lineupIds =
      value?.bestGroup ??
      [...roster]
        .sort((a, b) => predict(b, map.leaderboardId).acc - predict(a, map.leaderboardId).acc)
        .slice(0, k);

    return {
      poolMapId: map.poolMapId,
      lineup: toPlayers(lineupIds),
      lineupAcc: meanAcc(lineupIds, map.leaderboardId),
      versus: value
        ? {
            winProbability: value.bestVsBest,
            anyPairing: value.expected,
            opponentLineup: toPlayers(value.opponentBestGroup),
          }
        : null,
    };
  });

  return { playersPerMap: k, formatName: format.name, maps, shortHanded: null };
}

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
  /** Teams with fewer pairings than maps, which therefore had to repeat some. */
  repeatsNeeded: Array<{ teamName: string; available: number; maps: number }>;
}

export async function buildPoolOutlook(
  board: PoolBoard,
  tournamentId: string,
  teamId: string,
  opponentTeamId: string | null,
  options: { eachGroupOnce?: boolean } = {},
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

  // Whoever can actually be fielded: not the absent, not subs who are out.
  const roster = team.rows.filter((r) => r.available).map((r) => r.playerId);
  if (roster.length < k) {
    return {
      playersPerMap: k,
      formatName: format.name,
      maps: [],
      repeatsNeeded: [],
      shortHanded: `${team.teamName} has ${roster.length} player${roster.length === 1 ? '' : 's'}, and this format fields ${k} per map.`,
    };
  }

  const simMaps: SimMap[] = board.maps.map((m) => ({
    id: m.poolMapId,
    leaderboardId: m.leaderboardId,
    maxScore: m.maxScore,
    isTiebreaker: m.isTiebreaker,
  }));

  const opponentRoster = opponent?.rows.filter((r) => r.available).map((r) => r.playerId) ?? [];
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

  // With "each duo once" on, the best group per map is no longer independent:
  // a pairing spent on one map is gone for the rest, so each side's groups are
  // chosen across the whole pool. The tiebreaker is exempt where the format
  // says so, as in a match.
  //
  // A small roster has fewer pairings than a big pool has maps - four players
  // make six duos, and this pool may have seven maps. Then nobody can avoid a
  // repeat, so the rule becomes "as few repeats as possible" - one repeat for
  // six duos over seven maps - and the note says who had to.
  const assigned = new Map<string, { playerIds: string[]; winProbability: number }>();
  const opponentAssigned = new Map<string, string[]>();
  const repeatsNeeded: PoolOutlook['repeatsNeeded'] = [];

  if (options.eachGroupOnce && values) {
    const constrained = board.maps.filter(
      (m) => !(m.isTiebreaker && format.rules.tiebreakerExemptFromDuos) && values.has(m.poolMapId),
    );
    const first = constrained[0] ? values.get(constrained[0].poolMapId)! : null;
    const note = (teamName: string, available: number) => {
      if (available < constrained.length) {
        repeatsNeeded.push({ teamName, available, maps: constrained.length });
      }
    };
    note(team.teamName, first?.groups.length ?? 0);
    if (opponent) note(opponent.teamName, first?.opponentGroups.length ?? 0);

    // Theirs first: the groups that hold us down most.
    const theirIndex = new Map<string, number>();
    const theirs = assignSpread(
      constrained.map((m) =>
        values.get(m.poolMapId)!.opponentGroups.map((g, index) => ({
          playerIds: g.playerIds,
          value: 1 - g.average,
          index,
        })),
      ),
    );
    constrained.forEach((m, i) => {
      const pick = theirs[i];
      if (!pick) return;
      theirIndex.set(m.poolMapId, pick.index);
      opponentAssigned.set(m.poolMapId, pick.playerIds);
    });

    // Then ours, judged against whoever they are now fielding on each map.
    const ours = assignSpread(
      constrained.map((m) => {
        const value = values.get(m.poolMapId)!;
        const b = theirIndex.get(m.poolMapId);
        return value.groups.map((g) => ({
          playerIds: g.playerIds,
          value: b == null ? g.vsTheirBest : g.vs[b]!,
        }));
      }),
    );
    constrained.forEach((m, i) => {
      const pick = ours[i];
      if (pick) assigned.set(m.poolMapId, { playerIds: pick.playerIds, winProbability: pick.value });
    });
  }

  const maps = board.maps.map((map): OutlookMap => {
    const value = values?.get(map.poolMapId);
    const forced = assigned.get(map.poolMapId);
    // Without an opponent there is nothing to simulate against, so the best
    // group is simply the k players expected to score highest.
    const lineupIds =
      forced?.playerIds ??
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
            winProbability: forced?.winProbability ?? value.bestVsBest,
            anyPairing: value.expected,
            opponentLineup: toPlayers(opponentAssigned.get(map.poolMapId) ?? value.opponentBestGroup),
          }
        : null,
    };
  });

  return { playersPerMap: k, formatName: format.name, maps, shortHanded: null, repeatsNeeded };
}

/**
 * One option per map, maximising the total, with as few repeats as the numbers
 * allow: none when there are at least as many options as maps, otherwise
 * exactly the shortfall - six duos over seven maps means one duo plays twice,
 * not three of them.
 *
 * Depth-first with a bound. Only each map's top N options can matter (the other
 * N-1 maps cannot take more than that away), which keeps the search small
 * however large the roster is.
 */
function assignSpread<T extends { playerIds: string[]; value: number }>(perMap: T[][]): Array<T | null> {
  const n = perMap.length;
  const keyOf = (g: T) => [...g.playerIds].sort().join('|');
  const distinct = new Set(perMap.flatMap((groups) => groups.map(keyOf))).size;
  const repeatsAllowed = Math.max(0, n - distinct);

  const options = perMap.map((groups) =>
    [...groups].sort((a, b) => b.value - a.value).slice(0, Math.max(n, 1)),
  );
  // Best still achievable from map i onwards, ignoring the constraint.
  const ceiling = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) ceiling[i] = ceiling[i + 1]! + (options[i]![0]?.value ?? 0);

  let best: Array<T | null> = new Array(n).fill(null);
  let bestTotal = -1;
  const current: Array<T | null> = new Array(n).fill(null);
  const used = new Map<string, number>();

  const visit = (i: number, total: number, repeatsLeft: number) => {
    if (total + ceiling[i]! <= bestTotal) return;
    if (i === n) {
      bestTotal = total;
      best = [...current];
      return;
    }
    for (const group of options[i]!) {
      const key = keyOf(group);
      const count = used.get(key) ?? 0;
      if (count > 0 && repeatsLeft === 0) continue;
      used.set(key, count + 1);
      current[i] = group;
      visit(i + 1, total + group.value, count > 0 ? repeatsLeft - 1 : repeatsLeft);
      used.set(key, count);
    }
    current[i] = null;
  };
  visit(0, 0, repeatsAllowed);
  return best;
}

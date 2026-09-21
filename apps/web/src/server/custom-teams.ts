import { prisma, type Prisma } from '@bscs/db';
import { assertPoolIsBigEnough, parseFormat, PickBanError } from './match-helpers';

/**
 * Match-only ("ad hoc") teams, and the one way a match gets opened.
 *
 * A match-only team is a real Team row in the tournament's division, flagged
 * `adHoc`. That is deliberate: lineups, advice, captaincy and the score feed
 * all hang off team membership, and a side that exists for one scrim should
 * get every one of them without a second code path. The flag only decides
 * where the team is listed, and that it is tidied away with its last match.
 */

/** The two sabers. A match-only side gets these unless told otherwise. */
export const SIDE_COLORS = {
  A: { color: '#ff4d5e', colorSecondary: '#ffb3ba' },
  B: { color: '#3d9bff', colorSecondary: '#b3d7ff' },
} as const;

export const hexColor = (value: FormDataEntryValue | null): string | undefined =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;

type Db = Prisma.TransactionClient;

/** Team names are unique within a division; a second "Team Cat" becomes "Team Cat (2)". */
async function freeTeamName(db: Db, divisionId: string, wanted: string): Promise<string> {
  const base = wanted.trim().slice(0, 60) || 'Team';
  const taken = new Set(
    (
      await db.team.findMany({
        where: { divisionId, name: { startsWith: base, mode: 'insensitive' } },
        select: { name: true },
      })
    ).map((t) => t.name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export async function createAdHocTeam(
  db: Db,
  input: {
    tournamentId: string;
    name: string;
    color: string;
    colorSecondary: string;
    /** In roster order. */
    playerIds: readonly string[];
    captainId?: string | null;
  },
): Promise<{ id: string; name: string }> {
  let division = await db.division.findFirst({
    where: { tournamentId: input.tournamentId },
    orderBy: { order: 'asc' },
  });
  division ??= await db.division.create({
    data: { tournamentId: input.tournamentId, name: 'Teams', order: 0 },
  });

  const playerIds = [...new Set(input.playerIds)];
  return db.team.create({
    data: {
      divisionId: division.id,
      name: await freeTeamName(db, division.id, input.name),
      color: input.color,
      colorSecondary: input.colorSecondary,
      adHoc: true,
      members: {
        create: playerIds.map((playerId, order) => ({
          playerId,
          order,
          role: playerId === input.captainId ? ('CAPTAIN' as const) : ('PLAYER' as const),
        })),
      },
    },
    select: { id: true, name: true },
  });
}

/** Removes match-only teams that no longer have a match or a draft to their name. */
export async function cleanUpAdHocTeams(teamIds: readonly string[]): Promise<void> {
  await prisma.team.deleteMany({
    where: {
      id: { in: [...teamIds] },
      adHoc: true,
      matchesAsA: { none: {} },
      matchesAsB: { none: {} },
      draftsAsA: { none: {} },
      draftsAsB: { none: {} },
    },
  });
}

/**
 * Open a match between two teams of this tournament on one of its pools.
 *
 * Permission is the caller's business. What is checked here is that everything
 * named belongs to the tournament - otherwise a match in your own tournament
 * becomes a window onto someone else's private pool and rosters - and that the
 * pool can carry the format's pick/ban to the end, rather than stranding two
 * captains halfway through with nothing left to pick.
 */
export async function openMatch(input: {
  tournamentId: string;
  poolId: string;
  teamAId: string;
  teamBId: string;
  coinFlip: 'A' | 'B';
  blindLineups: boolean;
  name?: string;
}): Promise<{ matchId: string } | { error: string }> {
  const { tournamentId, poolId, teamAId, teamBId } = input;
  if (teamAId === teamBId) return { error: 'A team cannot play itself - choose two different teams.' };

  const [pool, tournament, teams] = await Promise.all([
    prisma.mapPool.findUnique({
      where: { id: poolId },
      select: { tournamentId: true, maps: { select: { id: true, isTiebreaker: true } } },
    }),
    prisma.tournament.findUnique({ where: { id: tournamentId }, select: { defaultFormat: true } }),
    prisma.team.findMany({
      where: { id: { in: [teamAId, teamBId] }, division: { tournamentId } },
      select: { id: true, name: true },
    }),
  ]);
  if (!pool || !tournament || pool.tournamentId !== tournamentId) {
    throw new Error('Pool or tournament not found.');
  }
  const teamA = teams.find((t) => t.id === teamAId);
  const teamB = teams.find((t) => t.id === teamBId);
  if (!teamA || !teamB) throw new Error('Both teams must belong to this tournament.');

  const format = parseFormat(tournament.defaultFormat);
  try {
    assertPoolIsBigEnough({
      format,
      poolMapIds: pool.maps
        .filter((m) => !(format.tiebreaker === 'DESIGNATED' && m.isTiebreaker))
        .map((m) => m.id),
      coinWinnerTeamId: teamAId,
      coinLoserTeamId: teamBId,
      actions: [],
    });
  } catch (err) {
    if (!(err instanceof PickBanError)) throw err;
    return { error: err.message };
  }

  const match = await prisma.match.create({
    data: {
      tournamentId,
      poolId,
      teamAId,
      teamBId,
      // "A" or "B" rather than a team id, so a form cannot name a third team.
      coinFlipWinnerId: input.coinFlip === 'B' ? teamBId : teamAId,
      name: input.name?.trim() || `${teamA.name} vs ${teamB.name}`,
      state: 'PICKBAN',
      startedAt: new Date(),
      blindLineups: input.blindLineups,
    },
    select: { id: true },
  });
  return { matchId: match.id };
}

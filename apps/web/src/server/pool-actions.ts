'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@bscs/db';
import { assertCan } from '@bscs/core/match';
import { makeDuos as pairUp } from '@bscs/core/bracket';
import { getActor } from './session';
import { failBack } from './form-errors';

/**
 * The player pool: players signed up for a tournament but not yet in a team,
 * kept on a team row flagged `playerPool` so the roster tools, the boards and
 * the player card all work on them unchanged. It is never offered as a side in
 * a match or a bracket.
 */

/** Colours for teams made from the pool, in turn. */
const DUO_COLORS: Array<[string, string]> = [
  ['#ff4d5e', '#ffb3ba'],
  ['#3d9bff', '#b3d7ff'],
  ['#2ecc71', '#a9ebc4'],
  ['#f5a623', '#fbd79a'],
  ['#a26bfa', '#d6c2fd'],
  ['#1abc9c', '#a3e4d7'],
  ['#ff7ac6', '#ffc9e8'],
  ['#e0e04a', '#f3f3b5'],
];

async function staff(tournamentId: string) {
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TEAMS');
}

export async function createPlayerPool(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  await staff(tournamentId);
  const existing = await prisma.team.findFirst({ where: { playerPool: true, division: { tournamentId } } });
  if (!existing) {
    let division = await prisma.division.findFirst({ where: { tournamentId } });
    division ??= await prisma.division.create({ data: { tournamentId, name: 'Teams', order: 0 } });
    await prisma.team.create({
      data: { divisionId: division.id, name: 'Player pool', playerPool: true, color: '#6b7280', colorSecondary: '#d1d5db' },
    });
  }
  revalidatePath('/t', 'layout');
}

/**
 * Pair the pool's players into duos, as teams of the tournament. Seeded, the
 * top seed is paired with the bottom one, the second with the second-last,
 * and so on - which evens the duos out. Random is random. An odd player out
 * stays in the pool.
 */
export async function makeDuosFromPool(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  await staff(tournamentId);
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { slug: true } });
  const back = `/t/${tournament!.slug}/teams`;

  const pool = await prisma.team.findFirst({
    where: { playerPool: true, division: { tournamentId } },
    select: {
      id: true,
      divisionId: true,
      members: { select: { id: true, playerId: true, player: { select: { name: true, pp: true } } } },
    },
  });
  if (!pool || pool.members.length < 2) failBack(back, 'The player pool needs at least two players.');

  const method = formData.get('method') === 'RANDOM' ? 'RANDOM' : 'SEEDED';
  const seedOf = (playerId: string) => {
    const n = Number(formData.get(`seed:${playerId}`));
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  };
  const ordered = [...pool.members].sort(
    (a, b) => seedOf(a.playerId) - seedOf(b.playerId) || b.player.pp - a.player.pp,
  );
  let { duos } = pairUp(ordered, method);
  // The teams page shows the duos before they are made and sends exactly those (pairs of member ids): what the
  // organiser saw, swaps and shuffle included, is what is made.
  const raw = formData.get('pairs');
  if (typeof raw === 'string' && raw) {
    let pairs: unknown = null;
    try {
      pairs = JSON.parse(raw);
    } catch {
      // read as no pairs below
    }
    const byId = new Map(pool.members.map((m) => [m.id, m]));
    const ids = Array.isArray(pairs) ? pairs.flat() : [];
    const ok =
      Array.isArray(pairs) &&
      pairs.length > 0 &&
      pairs.every((pair) => Array.isArray(pair) && pair.length === 2) &&
      ids.every((id) => typeof id === 'string' && byId.has(id)) &&
      new Set(ids).size === ids.length;
    if (!ok) failBack(back, 'The player pool changed since those duos were shown. Look at them again and press Make duos.');
    duos = (pairs as string[][]).map(([a, b]) => [byId.get(a!)!, byId.get(b!)!]);
  }

  const taken = new Set(
    (await prisma.team.findMany({ where: { division: { tournamentId } }, select: { name: true } })).map((t) =>
      t.name.toLowerCase(),
    ),
  );
  const nameFor = (a: string, b: string) => {
    let name = `${a} & ${b}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${a} & ${b} (${n})`;
    taken.add(name.toLowerCase());
    return name;
  };
  const existingTeams = await prisma.team.count({ where: { division: { tournamentId }, playerPool: false, adHoc: false } });

  await prisma.$transaction(
    duos.flatMap(([a, b], i) => {
      const [color, colorSecondary] = DUO_COLORS[(existingTeams + i) % DUO_COLORS.length]!;
      return [
        prisma.team.create({
          data: {
            divisionId: pool.divisionId,
            name: nameFor(a.player.name, b.player.name),
            color,
            colorSecondary,
            // Both of a duo are its captains: either may pick, ban and set lineups.
            members: { create: [a, b].map((m, order) => ({ playerId: m.playerId, order, role: 'CAPTAIN' as const })) },
          },
        }),
        prisma.teamMember.deleteMany({ where: { id: { in: [a.id, b.id] } } }),
      ];
    }),
  );
  revalidatePath('/t', 'layout');
}

/**
 * Rearrange rosters in one go: `rosters` is { teamId: [memberId, ...] }, each
 * team's players in order as the organiser arranged them on the teams page
 * (the player pool included). Only teams and members named are touched.
 *
 * A team's places keep what they are: whoever ends up first in a team that
 * had a captain first is its captain, so a swap hands over the place with it.
 * A duo's two places are both captains. Players who leave a team are taken
 * out of its unfinished lineups, as when they are removed by hand.
 */
export async function arrangeRosters(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  await staff(tournamentId);
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { slug: true } });
  const back = `/t/${tournament!.slug}/teams`;

  let rosters: Record<string, string[]> = {};
  try {
    rosters = JSON.parse(String(formData.get('rosters') ?? '{}'));
  } catch {
    failBack(back, 'Those roster changes could not be read.');
  }
  const teams = await prisma.team.findMany({
    where: { division: { tournamentId }, adHoc: false },
    select: {
      id: true,
      playerPool: true,
      members: { orderBy: { order: 'asc' }, select: { id: true, playerId: true, role: true, order: true } },
    },
  });
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const memberById = new Map(teams.flatMap((t) => t.members.map((m) => [m.id, { ...m, teamId: t.id }] as const)));
  const named = Object.values(rosters).flat();
  const valid =
    Object.entries(rosters).every(([teamId, ids]) => teamById.has(teamId) && Array.isArray(ids) && ids.every((id) => memberById.has(id))) &&
    new Set(named).size === named.length &&
    // everyone in a team that is rearranged is still somewhere
    Object.keys(rosters).every((teamId) => teamById.get(teamId)!.members.every((m) => named.includes(m.id)));
  if (!valid) failBack(back, 'The teams changed since that arrangement was made. Arrange them again.');

  const writes = [];
  const leaving: Array<{ playerId: string; teamId: string }> = [];
  for (const [teamId, ids] of Object.entries(rosters)) {
    const team = teamById.get(teamId)!;
    const places = team.members;
    const nextOrder = (places.at(-1)?.order ?? -1) + 1;
    for (const [i, id] of ids.entries()) {
      const member = memberById.get(id)!;
      const place = places[i];
      const role = team.playerPool ? 'PLAYER' : (place?.role ?? (places.length === 0 && i === 0 ? 'CAPTAIN' : 'PLAYER'));
      const order = place?.order ?? nextOrder + (i - places.length);
      if (member.teamId !== teamId) {
        // Already on that team under another membership (possible only by hand): leave both alone.
        if (team.members.some((m) => m.playerId === member.playerId)) continue;
        leaving.push({ playerId: member.playerId, teamId: member.teamId });
      }
      if (member.teamId === teamId && member.role === role && member.order === order) continue;
      writes.push(prisma.teamMember.update({ where: { id }, data: { teamId, role, order } }));
    }
  }
  if (!writes.length) return;
  await prisma.$transaction([
    ...leaving.map((l) =>
      prisma.lineupSlot.deleteMany({
        where: { playerId: l.playerId, lineup: { teamId: l.teamId, matchMap: { match: { state: { not: 'COMPLETE' } } } } },
      }),
    ),
    ...writes,
  ]);
  revalidatePath('/t', 'layout');
}

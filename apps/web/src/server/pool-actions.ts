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
  const { duos } = pairUp(ordered, method);

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
            members: { create: [a, b].map((m, order) => ({ playerId: m.playerId, order })) },
          },
        }),
        prisma.teamMember.deleteMany({ where: { id: { in: [a.id, b.id] } } }),
      ];
    }),
  );
  revalidatePath('/t', 'layout');
}

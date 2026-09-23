'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { assertCan, can } from '@bscs/core/match';
import { generateBracket, parseBracketFormat, shuffle, BRACKET_FORMAT_NAMES } from '@bscs/core/bracket';
import { getActor } from './session';
import { failBack } from './form-errors';
import { openMatch } from './custom-teams';
import { announceMatchChange } from '@/lib/redis';
import { finishingOrder, loadBracket } from './brackets';
import { nameSlots } from '@/lib/bracket-layout';

/**
 * Brackets: made by the organisers, played through ordinary matches. Every
 * action re-checks permission; the page is not the guard.
 */

async function staffFor(tournamentId: string) {
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');
  return actor;
}

/**
 * Make a bracket. Its entrants are either teams picked here - seeded by hand,
 * at random, or by their players' average BeatLeader pp - or the top of
 * another bracket, in the order it placed them.
 */
export async function createBracket(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  await staffFor(tournamentId);
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { slug: true } });
  if (!tournament) throw new Error('No such tournament.');
  const back = `/t/${tournament.slug}/brackets`;

  const format = parseBracketFormat(formData.get('format'));
  const name = String(formData.get('name') ?? '').trim() || BRACKET_FORMAT_NAMES[format];
  const poolId = String(formData.get('poolId') ?? '') || null;
  if (poolId) {
    const pool = await prisma.mapPool.findFirst({ where: { id: poolId, tournamentId }, select: { id: true } });
    if (!pool) failBack(back, 'That pool is not in this tournament.');
  }

  let seeded: string[];
  if (formData.get('entrants') === 'FROM_BRACKET') {
    const fromId = String(formData.get('fromBracketId') ?? '');
    const from = await prisma.bracket.findFirst({ where: { id: fromId, tournamentId }, select: { id: true } });
    if (!from) failBack(back, 'Choose the bracket to take teams from.');
    const placed = await finishingOrder(fromId);
    if (!placed) failBack(back, 'That bracket has no finishing order yet - it needs a winner first.');
    const top = Math.floor(Number(formData.get('top')));
    if (!(top >= 2)) failBack(back, 'Take at least the top 2.');
    seeded = placed.order.slice(0, top);
  } else {
    const picked = formData.getAll('teamId').map(String);
    const teams = await prisma.team.findMany({
      where: { id: { in: picked }, division: { tournamentId }, adHoc: false, playerPool: false },
      select: { id: true, members: { where: { available: true }, select: { player: { select: { pp: true } } } } },
    });
    const ids = teams.map((t) => t.id);
    switch (formData.get('seeding')) {
      case 'RANDOM':
        seeded = shuffle(ids);
        break;
      case 'PP': {
        const average = (id: string) => {
          const pps = teams.find((t) => t.id === id)!.members.map((m) => m.player.pp);
          return pps.length ? pps.reduce((a, b) => a + b, 0) / pps.length : 0;
        };
        seeded = [...ids].sort((a, b) => average(b) - average(a));
        break;
      }
      default: {
        // By hand: the numbers typed beside each team, blanks after, in list order.
        const number = (id: string) => {
          const n = Number(formData.get(`seed:${id}`));
          return Number.isFinite(n) && n > 0 ? n : Infinity;
        };
        seeded = [...ids].sort((a, b) => number(a) - number(b) || picked.indexOf(a) - picked.indexOf(b));
      }
    }
  }
  if (seeded.length < 2) failBack(back, 'A bracket needs at least two teams.');

  const nodes = generateBracket(format, seeded.length);
  const order = await prisma.bracket.count({ where: { tournamentId } });
  const bracket = await prisma.bracket.create({
    data: {
      tournamentId,
      name,
      format,
      poolId,
      order,
      entries: { create: seeded.map((teamId, i) => ({ teamId, seed: i + 1 })) },
      nodes: {
        create: nodes.map((n) => ({
          key: n.key,
          section: n.section,
          round: n.round,
          position: n.position,
          sources: { a: n.a, b: n.b },
        })),
      },
    },
    select: { id: true },
  });
  revalidatePath('/t', 'layout');
  redirect(`/t/${tournament.slug}/bracket/${bracket.id}`);
}

/** Remove a bracket. The matches played in it are kept, as ordinary matches. */
export async function deleteBracket(formData: FormData): Promise<void> {
  const bracketId = String(formData.get('bracketId'));
  const bracket = await prisma.bracket.findUnique({
    where: { id: bracketId },
    select: { tournamentId: true, tournament: { select: { slug: true } } },
  });
  if (!bracket) throw new Error('No such bracket.');
  await staffFor(bracket.tournamentId);
  await prisma.bracket.delete({ where: { id: bracketId } });
  revalidatePath('/t', 'layout');
  redirect(`/t/${bracket.tournament.slug}/brackets`);
}

/**
 * Set up the match for a bracket slot whose two teams are known. Organisers
 * may; so may either team's captain where the tournament lets captains set up
 * their own matches. Played on the bracket's pool.
 */
export async function startBracketMatch(formData: FormData): Promise<void> {
  const bracketId = String(formData.get('bracketId'));
  const key = String(formData.get('key'));
  const view = await loadBracket(bracketId);
  if (!view) throw new Error('No such bracket.');
  const tournament = await prisma.tournament.findUnique({
    where: { id: view.tournamentId },
    select: { slug: true, captainsCreateMatches: true },
  });
  if (!tournament) throw new Error('No such tournament.');
  const back = `/t/${tournament.slug}/bracket/${bracketId}`;

  const actor = await getActor(view.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  const slot = view.slots.find((s) => s.key === key);
  if (!slot || slot.state !== 'READY' || !slot.teamA || !slot.teamB) failBack(back, 'That match is not ready to be played.');
  if (slot.match) redirect(`/t/${tournament.slug}/match/${slot.match.id}`);
  if (
    ![slot.teamA.id, slot.teamB.id].some((teamId) =>
      can(actor, 'CREATE_MATCH', { teamId, captainsCreateMatches: tournament.captainsCreateMatches }),
    )
  ) {
    failBack(back, 'Only an organiser, or a captain of one of these teams, can start this match.');
  }
  if (!view.pool) failBack(back, 'This bracket has no map pool. An organiser can set one below.');

  const opened = await openMatch({
    tournamentId: view.tournamentId,
    poolId: view.pool.id,
    teamAId: slot.teamA.id,
    teamBId: slot.teamB.id,
    coinFlip: formData.get('coinFlip') === 'B' ? 'B' : 'A',
    blindLineups: formData.get('blindLineups') === 'on',
    name: `${view.name} · ${nameSlots(view.slots).slots.get(slot.key) ?? 'Match'}: ${slot.teamA.name} vs ${slot.teamB.name}`,
    scoring: formData.get('scoring') ? String(formData.get('scoring')) : null,
  });
  if ('error' in opened) failBack(back, opened.error);

  // Only one match per slot, even if two people press at once.
  const claimed = await prisma.bracketNode.updateMany({
    where: { bracketId, key, matchId: null },
    data: { matchId: opened.matchId },
  });
  if (claimed.count === 0) {
    await prisma.match.delete({ where: { id: opened.matchId } });
    const existing = await prisma.bracketNode.findFirst({ where: { bracketId, key }, select: { matchId: true } });
    redirect(existing?.matchId ? `/t/${tournament.slug}/match/${existing.matchId}` : back);
  }
  revalidatePath('/t', 'layout');
  redirect(`/t/${tournament.slug}/match/${opened.matchId}`);
}

/**
 * Record who went through a slot by hand - a walkover, a result settled off
 * the site - or clear it. A match played for the slot reports its own winner
 * when it is completed.
 */
export async function setBracketResult(formData: FormData): Promise<void> {
  const bracketId = String(formData.get('bracketId'));
  const key = String(formData.get('key'));
  const winnerId = String(formData.get('winnerId') ?? '') || null;
  const view = await loadBracket(bracketId);
  if (!view) throw new Error('No such bracket.');
  await staffFor(view.tournamentId);
  const tournament = await prisma.tournament.findUnique({ where: { id: view.tournamentId }, select: { slug: true } });
  const back = `/t/${tournament!.slug}/bracket/${bracketId}`;

  const slot = view.slots.find((s) => s.key === key);
  if (!slot) failBack(back, 'No such match in this bracket.');
  if (winnerId && winnerId !== slot.teamA?.id && winnerId !== slot.teamB?.id) {
    failBack(back, 'The winner has to be one of the two teams in that match.');
  }
  // The slot's match, where one was started, goes with the result: a winner
  // set here finishes it (a walkover still ends the match), and clearing the
  // result reopens it. Otherwise it would sit "live" for ever.
  const node = await prisma.bracketNode.findFirst({
    where: { bracketId, key },
    select: { match: { select: { id: true, state: true } } },
  });
  const match = node?.match;
  await prisma.$transaction([
    prisma.bracketNode.updateMany({ where: { bracketId, key }, data: { winnerId } }),
    ...(match && winnerId
      ? [
          prisma.match.update({
            where: { id: match.id },
            data: { state: 'COMPLETE', winnerId, completedAt: new Date() },
          }),
          prisma.matchMap.updateMany({ where: { matchId: match.id, scoresClosedAt: null }, data: { scoresClosedAt: new Date() } }),
        ]
      : []),
    ...(match && !winnerId && match.state === 'COMPLETE'
      ? [prisma.match.update({ where: { id: match.id }, data: { state: 'PLAYING', winnerId: null, completedAt: null } })]
      : []),
  ]);
  if (match) await announceMatchChange(match.id);
  revalidatePath('/t', 'layout');
  redirect(back);
}

/** Change which pool a bracket's matches are played on. Matches already made keep theirs. */
export async function setBracketPool(formData: FormData): Promise<void> {
  const bracketId = String(formData.get('bracketId'));
  const poolId = String(formData.get('poolId') ?? '') || null;
  const bracket = await prisma.bracket.findUnique({
    where: { id: bracketId },
    select: { tournamentId: true, tournament: { select: { slug: true } } },
  });
  if (!bracket) throw new Error('No such bracket.');
  await staffFor(bracket.tournamentId);
  if (poolId && !(await prisma.mapPool.findFirst({ where: { id: poolId, tournamentId: bracket.tournamentId } }))) {
    throw new Error('That pool is not in this tournament.');
  }
  await prisma.bracket.update({ where: { id: bracketId }, data: { poolId } });
  revalidatePath(`/t/${bracket.tournament.slug}/bracket/${bracketId}`);
}

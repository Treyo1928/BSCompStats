'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { assertCan, type Action } from '@bscs/core/match';
import { getActor } from './session';
import { failBack } from './form-errors';

/**
 * Renaming. Whatever is named when it is made can be renamed later: a pool, a
 * bracket, a match, a draft, the tournament itself. Teams rename on the teams
 * page. A tournament keeps its URL when renamed - links already shared must
 * keep working.
 */

const MAX_NAME = 80;

async function permit(tournamentId: string, action: Action): Promise<void> {
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, action);
}

function newName(formData: FormData, back: string, what: string): string {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) failBack(back, `A ${what} needs a name.`);
  if (name.length > MAX_NAME) failBack(back, `Keep the name to ${MAX_NAME} characters.`);
  return name;
}

/** Back to the page the form was on, without whatever error it was showing. */
function done(back: string): never {
  revalidatePath('/', 'layout');
  redirect(back);
}

export async function renamePool(formData: FormData): Promise<void> {
  const pool = await prisma.mapPool.findUnique({
    where: { id: String(formData.get('poolId')) },
    select: { id: true, tournamentId: true, tournament: { select: { slug: true } } },
  });
  if (!pool) throw new Error('No such pool.');
  await permit(pool.tournamentId, 'IMPORT_POOL');
  const back = `/t/${pool.tournament.slug}/pool/${pool.id}`;
  const name = newName(formData, back, 'pool');
  const taken = await prisma.mapPool.findFirst({
    where: { tournamentId: pool.tournamentId, id: { not: pool.id }, name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (taken) failBack(back, `There is already a pool called "${name}" in this tournament.`);
  await prisma.mapPool.update({ where: { id: pool.id }, data: { name } });
  done(back);
}

export async function renameBracket(formData: FormData): Promise<void> {
  const bracket = await prisma.bracket.findUnique({
    where: { id: String(formData.get('bracketId')) },
    select: { id: true, tournamentId: true, tournament: { select: { slug: true } } },
  });
  if (!bracket) throw new Error('No such bracket.');
  await permit(bracket.tournamentId, 'MANAGE_TOURNAMENT');
  const back = `/t/${bracket.tournament.slug}/bracket/${bracket.id}`;
  await prisma.bracket.update({ where: { id: bracket.id }, data: { name: newName(formData, back, 'bracket') } });
  done(back);
}

export async function renameMatch(formData: FormData): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: String(formData.get('matchId')) },
    select: { id: true, tournamentId: true, tournament: { select: { slug: true } } },
  });
  if (!match) throw new Error('No such match.');
  await permit(match.tournamentId, 'MANAGE_TOURNAMENT');
  const back = `/t/${match.tournament.slug}/match/${match.id}`;
  await prisma.match.update({ where: { id: match.id }, data: { name: newName(formData, back, 'match') } });
  done(back);
}

export async function renameDraft(formData: FormData): Promise<void> {
  const draft = await prisma.draft.findUnique({
    where: { id: String(formData.get('draftId')) },
    select: { id: true, tournamentId: true, tournament: { select: { slug: true } } },
  });
  if (!draft) throw new Error('No such draft.');
  await permit(draft.tournamentId, 'CREATE_MATCH');
  const back = `/t/${draft.tournament.slug}/draft/${draft.id}`;
  await prisma.draft.update({ where: { id: draft.id }, data: { name: newName(formData, back, 'draft') } });
  done(back);
}

/** The tournament's name and description. Its URL stays as it is. */
export async function updateTournamentDetails(formData: FormData): Promise<void> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: String(formData.get('tournamentId')) },
    select: { id: true, slug: true },
  });
  if (!tournament) throw new Error('No such tournament.');
  await permit(tournament.id, 'MANAGE_TOURNAMENT');
  const back = `/t/${tournament.slug}/settings`;
  const name = newName(formData, back, 'tournament');
  const description = String(formData.get('description') ?? '').trim().slice(0, 500) || null;
  await prisma.tournament.update({ where: { id: tournament.id }, data: { name, description } });
  done(`${back}?saved=details`);
}

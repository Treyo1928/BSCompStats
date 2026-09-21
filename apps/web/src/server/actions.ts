'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { assertCan } from '@bscs/core/match';
import { getActor } from './session';
import { importPool } from './pools';
import { requestRefresh } from '@/lib/redis';
import { beatLeader } from './pools';

/** Server actions. Every one re-checks permission - the UI is not the guard. */

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function createTournament(formData: FormData): Promise<void> {
  const actor = await getActor();
  if (!actor) throw new Error('Sign in first.');

  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('A tournament needs a name.');

  let slug = slugify(name) || 'tournament';
  // Slugs are the URL, so collisions have to be resolved rather than rejected.
  for (let suffix = 2; await prisma.tournament.findUnique({ where: { slug } }); suffix++) {
    slug = `${slugify(name)}-${suffix}`;
  }

  const tournament = await prisma.tournament.create({
    data: {
      name,
      slug,
      ownerId: actor.userId,
      isPublic: formData.get('isPublic') !== 'off',
      members: { create: { userId: actor.userId, role: 'OWNER' } },
      divisions: { create: { name: 'Teams', order: 0 } },
    },
  });

  redirect(`/t/${tournament.slug}`);
}

export async function importPoolAction(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'IMPORT_POOL');

  const name = String(formData.get('name') ?? '').trim() || 'Pool 1';
  const source = String(formData.get('source') ?? '').trim();

  let rawPlaylist: unknown;
  const file = formData.get('file');
  if (file instanceof File && file.size > 0) {
    // A .bplist is JSON. Cap the size - BeatLeader's own playlists embed a
    // multi-megabyte cover image and there is no reason to accept more.
    if (file.size > 25 * 1024 * 1024) throw new Error('That playlist file is too large.');
    rawPlaylist = JSON.parse(await file.text());
  } else if (!source) {
    throw new Error('Paste a playlist link or choose a .bplist file.');
  }

  const result = await importPool({ tournamentId, name, source, rawPlaylist });

  // New maps mean new things to track, so ask for a score sync straight away.
  await requestRefresh(result.poolId, actor.userId);

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { slug: true },
  });
  revalidatePath(`/t/${tournament?.slug}`);
  redirect(`/t/${tournament?.slug}/pool/${result.poolId}`);
}

export async function setPoolMapMeta(formData: FormData): Promise<void> {
  const poolMapId = String(formData.get('poolMapId'));
  const poolMap = await prisma.poolMap.findUnique({
    where: { id: poolMapId },
    select: { pool: { select: { tournamentId: true, id: true } } },
  });
  if (!poolMap) throw new Error('No such map.');

  const actor = await getActor(poolMap.pool.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'IMPORT_POOL');

  await prisma.poolMap.update({
    where: { id: poolMapId },
    data: {
      category: String(formData.get('category') ?? '').trim() || null,
      label: String(formData.get('label') ?? '').trim() || null,
      isTiebreaker: formData.get('isTiebreaker') === 'on',
    },
  });

  revalidatePath(`/t`, 'layout');
}

export async function addPlayer(formData: FormData): Promise<void> {
  const teamId = String(formData.get('teamId'));
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { division: { select: { tournamentId: true } } },
  });
  if (!team) throw new Error('No such team.');

  const actor = await getActor(team.division.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TEAMS');

  const query = String(formData.get('player') ?? '').trim();
  if (!query) throw new Error('Enter a BeatLeader ID, profile link, or name.');

  const player = await resolvePlayer(query);

  const count = await prisma.teamMember.count({ where: { teamId } });
  await prisma.teamMember.upsert({
    where: { teamId_playerId: { teamId, playerId: player.id } },
    create: { teamId, playerId: player.id, order: count },
    update: {},
  });

  await requestRefresh(undefined, actor.userId);
  revalidatePath('/t', 'layout');
}

/**
 * Find or create a Player from whatever the organiser pasted: a BeatLeader ID,
 * a profile URL, or a name to search for.
 */
async function resolvePlayer(query: string) {
  const fromUrl = query.match(/beatleader\.(?:com|xyz)\/u\/([^/?#]+)/i)?.[1];
  const candidate = fromUrl ?? query;

  const existing = await prisma.player.findFirst({
    where: {
      OR: [
        { beatLeaderId: candidate },
        { name: { equals: candidate, mode: 'insensitive' } },
      ],
    },
  });
  if (existing) return existing;

  // A long run of digits is a Steam ID; anything else gets searched by name.
  let profile = /^\d{5,}$/.test(candidate)
    ? await beatLeader.getPlayer(candidate)
    : null;

  if (!profile) {
    const results = await beatLeader.searchPlayers(candidate);
    profile = results[0] ?? null;
  }
  if (!profile) throw new Error(`BeatLeader has no player matching "${query}".`);

  return prisma.player.upsert({
    where: { beatLeaderId: profile.id },
    create: {
      beatLeaderId: profile.id,
      name: profile.name ?? `Player ${profile.id}`,
      avatar: profile.avatar ?? null,
      country: profile.country ?? null,
      pp: profile.pp ?? 0,
      rank: profile.rank ?? 0,
    },
    update: { name: profile.name ?? undefined, avatar: profile.avatar ?? undefined },
  });
}

export async function createTeam(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TEAMS');

  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('A team needs a name.');

  let division = await prisma.division.findFirst({ where: { tournamentId } });
  division ??= await prisma.division.create({
    data: { tournamentId, name: 'Teams', order: 0 },
  });

  await prisma.team.create({
    data: {
      divisionId: division.id,
      name,
      color: String(formData.get('color') ?? '#4F46E5'),
      colorSecondary: String(formData.get('colorSecondary') ?? '#A5B4FC'),
    },
  });

  revalidatePath('/t', 'layout');
}

export async function triggerRefresh(formData: FormData): Promise<void> {
  const poolId = String(formData.get('poolId') ?? '') || undefined;
  const tournamentId = String(formData.get('tournamentId') ?? '') || undefined;
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');

  await requestRefresh(poolId, actor.userId);
  revalidatePath('/t', 'layout');
}

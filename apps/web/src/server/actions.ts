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
      // An unchecked checkbox is simply absent from the form data, so only an
      // explicit 'on' may count as public - anything else must fail private.
      isPublic: formData.get('isPublic') === 'on',
      members: { create: { userId: actor.userId, role: 'OWNER' } },
      divisions: { create: { name: 'Teams', order: 0 } },
    },
  });

  redirect(`/t/${tournament.slug}`);
}

export async function setTournamentVisibility(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  await prisma.tournament.update({
    where: { id: tournamentId },
    data: { isPublic: formData.get('isPublic') === 'on' },
  });
  revalidatePath('/', 'layout');
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

/** Loads a team and checks the caller may manage rosters in its tournament. */
async function requireTeamManager(teamId: string) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { division: { select: { tournamentId: true } } },
  });
  if (!team) throw new Error('No such team.');

  const actor = await getActor(team.division.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TEAMS');
  return actor;
}

export interface PlayerCandidate {
  beatLeaderId: string;
  name: string;
  avatar: string | null;
  country: string | null;
  pp: number;
  rank: number;
  /** Name of the app account that has claimed this profile, if any. */
  accountName: string | null;
  /** True when the app account, not the BeatLeader name, is what matched. */
  linked: boolean;
  onTeam: boolean;
}

/**
 * Who might the organiser mean? Whatever they typed - a BeatLeader ID, a
 * profile URL, or a name - is looked up in two places:
 *
 *   - this app, by player name and by the name of the account that linked the
 *     profile (someone known as "Trey" on Discord may play as something else)
 *   - BeatLeader's own player search
 *
 * Results are returned rather than acted on, so the organiser picks from a list
 * instead of silently getting whoever happened to rank first.
 *
 * Errors come back as a value: a thrown message is scrubbed in production
 * builds, and "BeatLeader is down" is worth telling the user.
 */
export async function searchPlayerCandidates(
  teamId: string,
  rawQuery: string,
): Promise<{ candidates: PlayerCandidate[]; error?: string }> {
  const actor = await requireTeamManager(teamId);
  // Anyone can create a tournament and so become a team manager somewhere.
  // Which BeatLeader profile belongs to which account is the site's business,
  // not theirs: only a site admin may browse by account name or see it. Others
  // can still find someone by their exact account name, which they must
  // already know.
  const seesAccounts = actor.globalRole === 'ADMIN';

  const query = rawQuery.trim();
  if (!query) return { candidates: [], error: 'Enter a BeatLeader ID, profile link, or name.' };

  const fromUrl = query.match(/beatleader\.(?:com|xyz)\/u\/([^/?#]+)/i)?.[1];
  const term = fromUrl ?? query;

  const local = await prisma.player.findMany({
    where: {
      OR: [
        { beatLeaderId: term },
        { name: { contains: term, mode: 'insensitive' } },
        {
          user: {
            name: seesAccounts
              ? { contains: term, mode: 'insensitive' }
              : { equals: term, mode: 'insensitive' },
          },
        },
      ],
    },
    orderBy: { pp: 'desc' },
    take: 10,
    select: {
      beatLeaderId: true,
      name: true,
      avatar: true,
      country: true,
      pp: true,
      rank: true,
      user: { select: { name: true } },
    },
  });

  let remote: Awaited<ReturnType<typeof beatLeader.searchPlayers>> = [];
  let error: string | undefined;
  try {
    // A long run of digits is a Steam ID; anything else gets searched by name.
    const exact =
      fromUrl || /^\d{5,}$/.test(term) ? await beatLeader.getPlayer(term) : null;
    remote = exact ? [exact] : await beatLeader.searchPlayers(term);
  } catch {
    error = 'BeatLeader could not be reached - showing players already known here.';
  }

  const candidates = new Map<string, PlayerCandidate>();
  for (const p of local) {
    candidates.set(p.beatLeaderId, {
      beatLeaderId: p.beatLeaderId,
      name: p.name,
      avatar: p.avatar,
      country: p.country,
      pp: p.pp,
      rank: p.rank,
      accountName:
        seesAccounts || p.user?.name?.toLowerCase() === term.toLowerCase()
          ? (p.user?.name ?? null)
          : null,
      linked: Boolean(p.user),
      onTeam: false,
    });
  }
  for (const p of remote) {
    const known = candidates.get(p.id);
    // BeatLeader's figures are fresher than our cache; ours know about accounts.
    candidates.set(p.id, {
      beatLeaderId: p.id,
      name: p.name ?? known?.name ?? `Player ${p.id}`,
      avatar: p.avatar ?? known?.avatar ?? null,
      country: p.country ?? known?.country ?? null,
      pp: p.pp ?? known?.pp ?? 0,
      rank: p.rank ?? known?.rank ?? 0,
      accountName: known?.accountName ?? null,
      linked: known?.linked ?? false,
      onTeam: false,
    });
  }

  const ids = [...candidates.keys()];

  // Remote-only hits may still belong to someone with an account here.
  const unlinked = ids.filter((id) => !candidates.get(id)!.linked);
  if (unlinked.length > 0) {
    const owners = await prisma.player.findMany({
      where: { beatLeaderId: { in: unlinked }, userId: { not: null } },
      select: { beatLeaderId: true, user: { select: { name: true } } },
    });
    for (const owner of owners) {
      const c = candidates.get(owner.beatLeaderId)!;
      c.linked = true;
      c.accountName = seesAccounts ? (owner.user?.name ?? null) : null;
    }
  }

  const members = await prisma.teamMember.findMany({
    where: { teamId, player: { beatLeaderId: { in: ids } } },
    select: { player: { select: { beatLeaderId: true } } },
  });
  for (const m of members) candidates.get(m.player.beatLeaderId)!.onTeam = true;

  // People with an account here are the likeliest intent, so they lead.
  const sorted = [...candidates.values()].sort(
    (a, b) => Number(b.linked) - Number(a.linked) || b.pp - a.pp,
  );

  if (sorted.length === 0 && !error) error = `No player matching "${query}".`;
  return { candidates: sorted.slice(0, 20), error };
}

/** Adds one specific BeatLeader profile - the one picked from the candidates. */
export async function addPlayerToTeam(
  teamId: string,
  beatLeaderId: string,
): Promise<{ error?: string }> {
  const actor = await requireTeamManager(teamId);

  let player = await prisma.player.findUnique({ where: { beatLeaderId } });
  if (!player) {
    let profile;
    try {
      profile = await beatLeader.getPlayer(beatLeaderId);
    } catch {
      return { error: 'BeatLeader could not be reached. Try again in a moment.' };
    }
    if (!profile) return { error: 'BeatLeader has no such player.' };

    player = await prisma.player.upsert({
      where: { beatLeaderId: profile.id },
      create: {
        beatLeaderId: profile.id,
        name: profile.name ?? `Player ${profile.id}`,
        avatar: profile.avatar ?? null,
        country: profile.country ?? null,
        pp: profile.pp ?? 0,
        rank: profile.rank ?? 0,
      },
      update: {},
    });
  }

  // Max + 1 rather than the count: removals leave gaps, and a count would then
  // hand out an order that is already taken.
  const last = await prisma.teamMember.aggregate({ where: { teamId }, _max: { order: true } });
  await prisma.teamMember.upsert({
    where: { teamId_playerId: { teamId, playerId: player.id } },
    create: { teamId, playerId: player.id, order: (last._max.order ?? -1) + 1 },
    update: {},
  });

  await requestRefresh(undefined, actor.userId);
  revalidatePath('/t', 'layout');
  return {};
}

/**
 * Takes a player off a roster. Only the membership goes: the Player, their
 * scores and any lineups they already appeared in are keyed by player, not by
 * membership, so match history survives.
 */
export async function removePlayerFromTeam(memberId: string): Promise<void> {
  const member = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { teamId: true },
  });
  if (!member) return;

  await requireTeamManager(member.teamId);
  await prisma.teamMember.delete({ where: { id: memberId } });
  revalidatePath('/t', 'layout');
}

/**
 * Marks (or unmarks) a roster member as captain.
 *
 * This is the whole of captain assignment: authority over picks, bans and
 * lineups follows from it in getActor, via whoever has linked the player's
 * BeatLeader profile. A captain with no account yet simply gains control the
 * first time they sign in with BeatLeader.
 */
export async function setTeamCaptain(memberId: string, captain: boolean): Promise<void> {
  const member = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { teamId: true },
  });
  if (!member) return;

  await requireTeamManager(member.teamId);
  await prisma.teamMember.update({
    where: { id: memberId },
    data: { role: captain ? 'CAPTAIN' : 'PLAYER' },
  });
  revalidatePath('/t', 'layout');
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

/** Last refresh per user, so the button cannot be held down against BeatLeader. */
const lastRefreshAt = new Map<string, number>();
const REFRESH_COOLDOWN_MS = 10_000;

export async function triggerRefresh(formData: FormData): Promise<void> {
  const poolId = String(formData.get('poolId') ?? '') || undefined;

  // The pool's own tournament is the one that counts - not whichever id the
  // form happened to carry alongside it.
  const pool = poolId
    ? await prisma.mapPool.findUnique({ where: { id: poolId }, select: { tournamentId: true } })
    : null;
  const tournamentId = pool?.tournamentId ?? (String(formData.get('tournamentId') ?? '') || undefined);
  if (!tournamentId || (poolId && !pool)) return;

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { isPublic: true },
  });
  if (!tournament) return;

  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'VIEW', { isPublic: tournament.isPublic });

  const now = Date.now();
  if (now - (lastRefreshAt.get(actor.userId) ?? 0) < REFRESH_COOLDOWN_MS) return;
  lastRefreshAt.set(actor.userId, now);

  await requestRefresh(poolId, actor.userId);
  revalidatePath('/t', 'layout');
}

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { assertCan, can, isCaptainOf, ForbiddenError } from '@bscs/core/match';
import { getActor } from './session';
import { importPool } from './pools';
import { requestRefresh } from '@/lib/redis';
import { beatLeader } from './pools';
import { cookies } from 'next/headers';
import { failBack } from './form-errors';
import { ESTIMATES_COOKIE, failKey, parseEstimateCookie } from './stats';
import { SCOPE_PRESETS } from '@bscs/core/stats';
import { looksLikeSteamId, parseScoreSaberId, ScoreSaberClient } from '@bscs/core/scoresaber';

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

/**
 * People attached to a tournament.
 *
 * ORGANIZER is a tournament admin: everything inside this tournament - teams,
 * pools, matches, scores, acting for either side - and nothing outside it.
 * VIEWER only matters for a private tournament, where it is what lets someone
 * see it at all.
 *
 * Handing out or taking away admin is for the owner and site admins. Other
 * organisers can still let viewers in.
 */
export async function addTournamentMember(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { slug: true },
  });
  if (!tournament) throw new Error('No such tournament.');
  const back = `/t/${tournament.slug}`;

  const role = formData.get('role') === 'ORGANIZER' ? 'ORGANIZER' : 'VIEWER';
  const grantsAdmin = actor.globalRole === 'ADMIN' || actor.tournamentRole === 'OWNER';
  if (role === 'ORGANIZER' && !grantsAdmin) {
    failBack(back, 'Only the tournament owner or a site admin can add tournament admins.');
  }

  const who = String(formData.get('who') ?? '').trim();
  if (!who) failBack(back, 'Enter their account name or BeatLeader ID.');

  // Exact matches only: this must not double as a way to browse who has an
  // account here.
  const matches = await prisma.user.findMany({
    where: {
      OR: [
        { name: { equals: who, mode: 'insensitive' } },
        { players: { some: { beatLeaderId: who } } },
        { players: { some: { name: { equals: who, mode: 'insensitive' } } } },
      ],
    },
    select: { id: true },
    take: 2,
  });
  if (matches.length === 0) {
    failBack(back, `Nobody called "${who}" has signed in here yet. They need to sign in once before they can be added.`);
  }
  if (matches.length > 1) {
    failBack(back, `More than one account matches "${who}". Use their BeatLeader ID instead.`);
  }
  const userId = matches[0]!.id;

  const existing = await prisma.tournamentMember.findUnique({
    where: { tournamentId_userId: { tournamentId, userId } },
    select: { role: true },
  });
  if (existing?.role === 'OWNER') failBack(back, 'They already own this tournament.');
  if (existing?.role === 'ORGANIZER' && !grantsAdmin) {
    failBack(back, 'They are a tournament admin; only the owner or a site admin can change that.');
  }

  await prisma.tournamentMember.upsert({
    where: { tournamentId_userId: { tournamentId, userId } },
    create: { tournamentId, userId, role },
    update: { role },
  });
  revalidatePath('/', 'layout');
}

export async function removeTournamentMember(formData: FormData): Promise<void> {
  const memberId = String(formData.get('memberId'));
  const member = await prisma.tournamentMember.findUnique({
    where: { id: memberId },
    select: { tournamentId: true, role: true },
  });
  if (!member) return;

  const actor = await getActor(member.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  const grantsAdmin = actor.globalRole === 'ADMIN' || actor.tournamentRole === 'OWNER';
  if (member.role === 'OWNER' || (member.role === 'ORGANIZER' && !grantsAdmin)) {
    throw new ForbiddenError('MANAGE_TOURNAMENT');
  }

  await prisma.tournamentMember.delete({ where: { id: memberId } });
  revalidatePath('/', 'layout');
}

/** Gone for good, with its teams, pools and matches. Owner or site admin only. */
export async function deleteTournament(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  if (actor.globalRole !== 'ADMIN' && actor.tournamentRole !== 'OWNER') {
    throw new ForbiddenError('MANAGE_TOURNAMENT');
  }

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { name: true, slug: true },
  });
  if (!tournament) redirect('/');

  // Typing the name is the confirmation: this form works without JavaScript,
  // and a mis-click must not be able to do this.
  if (String(formData.get('confirmName') ?? '').trim() !== tournament.name) {
    failBack(`/t/${tournament.slug}`, `Type the tournament's name exactly ("${tournament.name}") to delete it.`);
  }

  // Matches point at teams and pools without cascading, so they go first.
  await prisma.$transaction([
    prisma.match.deleteMany({ where: { tournamentId } }),
    prisma.tournament.delete({ where: { id: tournamentId } }),
  ]);
  revalidatePath('/', 'layout');
  redirect('/');
}

export async function setCaptainsEnterScores(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  await prisma.tournament.update({
    where: { id: tournamentId },
    data: { captainsEnterScores: formData.get('allow') === 'on' },
  });
  revalidatePath('/t', 'layout');
}

/**
 * What the prediction model learns from: the pool alone, or a player's wider
 * BeatLeader history. Widening it also asks the worker to go and fetch that
 * history, which is why predictions shift over the following minute or two
 * rather than at once.
 */
export async function setStatsScope(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  const preset = SCOPE_PRESETS[String(formData.get('source'))] ?? SCOPE_PRESETS.poolOnly!;
  const months = Number(formData.get('months'));
  const scope =
    preset.source === 'POOL_ONLY'
      ? preset
      : {
          ...preset,
          // 0 means "all time".
          maxAgeDays: Number.isFinite(months) && months > 0 ? Math.round(months * 30.5) : null,
        };

  // Whether history is kept for the stats pages is a separate decision, and
  // choosing what predictions learn from must not quietly undo it.
  const current = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { statsScope: true },
  });
  const keepHistory = (current?.statsScope as { keepHistory?: unknown } | null)?.keepHistory === true;

  await prisma.tournament.update({
    where: { id: tournamentId },
    data: { statsScope: { ...scope, keepHistory } },
  });
  await requestRefresh(undefined, actor.userId);
  revalidatePath('/t', 'layout');
}

/**
 * Keep every player's wider BeatLeader history downloaded, so the player stats
 * pages can be looked at over ranked or all maps. Predictions, boards and match
 * advice keep learning from whatever the tournament's scope says.
 */
export async function setKeepHistory(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  const current = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { statsScope: true },
  });
  const stored = typeof current?.statsScope === 'object' && current.statsScope ? current.statsScope : {};

  await prisma.tournament.update({
    where: { id: tournamentId },
    data: { statsScope: { ...(stored as object), keepHistory: formData.get('keep') === 'on' } },
  });
  // The worker fetches histories on its next pass; this asks for one now.
  await requestRefresh(undefined, actor.userId);
  revalidatePath('/t', 'layout');
}

/**
 * What kind of map this is - the organiser's word, which always wins over the
 * guess made from BeatLeader's ratings. Blank hands it back to the guess.
 */
export async function setPoolMapKind(formData: FormData): Promise<void> {
  const poolMapId = String(formData.get('poolMapId'));
  const poolMap = await prisma.poolMap.findUnique({
    where: { id: poolMapId },
    select: { pool: { select: { tournamentId: true } } },
  });
  if (!poolMap) throw new Error('No such map.');

  const actor = await getActor(poolMap.pool.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'IMPORT_POOL');

  // "Something else" in the list means the text box beside it is the answer.
  const picked = String(formData.get('kind') ?? '');
  const kind = (picked === '__custom' ? String(formData.get('custom') ?? '') : picked).trim().slice(0, 24);

  await prisma.poolMap.update({ where: { id: poolMapId }, data: { category: kind || null } });
  revalidatePath('/t', 'layout');
}

/**
 * Set, or clear, the viewer's own estimate of what a player would score on a
 * map they have not played.
 *
 * Kept in a session cookie, not the database: it changes what this viewer is
 * shown and nobody else, and it is gone when they close the browser. So anyone
 * who can see the pool may use it - there is nothing here to abuse.
 */
export async function setPredictionEstimate(formData: FormData): Promise<void> {
  const poolId = String(formData.get('poolId'));
  const playerId = String(formData.get('playerId'));
  const leaderboardId = String(formData.get('leaderboardId'));

  const pool = await prisma.mapPool.findUnique({
    where: { id: poolId },
    select: {
      tournamentId: true,
      tournament: { select: { slug: true, isPublic: true } },
      maps: { where: { leaderboardId }, select: { id: true } },
    },
  });
  if (!pool || pool.maps.length === 0) throw new Error('That map is not in this pool.');

  const actor = (await getActor(pool.tournamentId)) ?? {
    userId: '',
    globalRole: 'USER' as const,
    tournamentRole: null,
  };
  assertCan(actor, 'VIEW', { isPublic: pool.tournament.isPublic });

  const onRoster = await prisma.teamMember.findFirst({
    where: { playerId, team: { division: { tournamentId: pool.tournamentId } } },
    select: { id: true },
  });
  if (!onRoster) throw new Error('That player is not in this tournament.');

  const back = `/t/${pool.tournament.slug}/pool/${poolId}`;
  const jar = await cookies();
  const all = parseEstimateCookie(jar.get(ESTIMATES_COOKIE)?.value);
  const mine = { ...(all[pool.tournamentId] ?? {}) };
  const key = failKey(playerId, leaderboardId);
  const raw = String(formData.get('accuracy') ?? '').replace('%', '').trim();

  if (raw === '' || formData.get('clear') === 'on') {
    delete mine[key];
  } else {
    const percent = Number(raw);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      failBack(back, `"${raw}" is not an accuracy. Enter a percentage, such as 45.`);
    }
    // A cookie is small; a hundred estimates is already far more than anyone sets.
    if (!(key in mine) && Object.keys(mine).length >= 100) {
      failBack(back, 'That is a lot of estimates. Clear some before adding more.');
    }
    mine[key] = Math.round(percent * 100) / 10000;
  }

  if (Object.keys(mine).length > 0) all[pool.tournamentId] = mine;
  else delete all[pool.tournamentId];

  // No maxAge: a session cookie, gone when the browser closes.
  jar.set(ESTIMATES_COOKIE, JSON.stringify(all), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  revalidatePath(back);
}

export async function importPoolAction(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'IMPORT_POOL');

  const destination = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { slug: true },
  });
  if (!destination) throw new Error('No such tournament.');
  const back = `/t/${destination.slug}`;

  const name = String(formData.get('name') ?? '').trim() || 'Pool 1';
  const source = String(formData.get('source') ?? '').trim();

  let rawPlaylist: unknown;
  const file = formData.get('file');
  if (file instanceof File && file.size > 0) {
    // A .bplist is JSON. Cap the size - BeatLeader's own playlists embed a
    // multi-megabyte cover image and there is no reason to accept more.
    if (file.size > 25 * 1024 * 1024) failBack(back, 'That playlist file is too large (25 MB at most).');
    try {
      rawPlaylist = JSON.parse(await file.text());
    } catch {
      failBack(back, 'That file is not a playlist - a .bplist is JSON.');
    }
  } else if (!source) {
    failBack(back, 'Paste a playlist link or choose a .bplist file.');
  }

  let result: Awaited<ReturnType<typeof importPool>>;
  try {
    result = await importPool({ tournamentId, name, source, rawPlaylist });
  } catch (err) {
    // What importPool throws itself is about the playlist it was given and is
    // written to be read. Anything from the database is not.
    const known = err instanceof Error && !('code' in err) && !err.name.startsWith('Prisma');
    if (!known) console.error('[import] failed:', err);
    failBack(back, known ? err.message : 'The import failed. Check the server log.');
  }

  // New maps mean new things to track, so ask for a score sync straight away.
  await requestRefresh(result.poolId, actor.userId);

  revalidatePath(back);
  redirect(`${back}/pool/${result.poolId}`);
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
  /** Which site this result came from. `beatLeaderId` holds that site's id for them. */
  platform?: 'beatleader' | 'scoresaber';
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
  return findCandidates(rawQuery, actor.globalRole === 'ADMIN', teamId);
}

/**
 * The same search for someone putting a match-only side together, where there
 * is no team yet for the player to be on.
 */
export async function searchGuestCandidates(
  tournamentId: string,
  rawQuery: string,
): Promise<{ candidates: PlayerCandidate[]; error?: string }> {
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'CREATE_MATCH');
  return findCandidates(rawQuery, actor.globalRole === 'ADMIN', null);
}

async function findCandidates(
  rawQuery: string,
  seesAccounts: boolean,
  teamId: string | null,
): Promise<{ candidates: PlayerCandidate[]; error?: string }> {
  // Anyone can create a tournament and so become a team manager somewhere.
  // Which BeatLeader profile belongs to which account is the site's business,
  // not theirs: only a site admin may browse by account name or see it. Others
  // can still find someone by their exact account name, which they must
  // already know. That is what `seesAccounts` carries.

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

  const members = teamId
    ? await prisma.teamMember.findMany({
        where: { teamId, player: { beatLeaderId: { in: ids } } },
        select: { player: { select: { beatLeaderId: true } } },
      })
    : [];
  for (const m of members) candidates.get(m.player.beatLeaderId)!.onTeam = true;

  // People with an account here are the likeliest intent, so they lead.
  const sorted = [...candidates.values()].sort(
    (a, b) => Number(b.linked) - Number(a.linked) || b.pp - a.pp,
  );

  if (sorted.length === 0 && !error) error = `No player matching "${query}".`;
  return { candidates: sorted.slice(0, 20), error };
}

export interface GuestPlayer {
  id: string;
  beatLeaderId: string;
  name: string;
  avatar: string | null;
}

/** The Player row for a BeatLeader profile, fetched and stored the first time it is asked for. */
async function ensurePlayer(
  beatLeaderId: string,
): Promise<{ player: GuestPlayer } | { error: string }> {
  const known = await prisma.player.findUnique({ where: { beatLeaderId } });
  if (known) return { player: known };

  let profile;
  try {
    profile = await beatLeader.getPlayer(beatLeaderId);
  } catch {
    return { error: 'BeatLeader could not be reached. Try again in a moment.' };
  }
  if (!profile) return { error: 'BeatLeader has no such player.' };

  const player = await prisma.player.upsert({
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
  return { player };
}

/**
 * Make someone from outside the tournament available to a match-only side.
 * They join nothing yet - that happens when the side is created.
 */
export async function registerGuest(
  tournamentId: string,
  beatLeaderId: string,
): Promise<{ player?: GuestPlayer; error?: string }> {
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'CREATE_MATCH');

  const found = await ensurePlayer(beatLeaderId);
  if ('error' in found) return found;
  const { id, beatLeaderId: blId, name, avatar } = found.player;
  return { player: { id, beatLeaderId: blId, name, avatar } };
}

/** Adds one specific BeatLeader profile - the one picked from the candidates. */
export async function addPlayerToTeam(
  teamId: string,
  beatLeaderId: string,
): Promise<{ error?: string }> {
  const actor = await requireTeamManager(teamId);

  const found = await ensurePlayer(beatLeaderId);
  if ('error' in found) return found;
  const player = found.player;

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
    select: { teamId: true, playerId: true },
  });
  if (!member) return;

  await requireTeamManager(member.teamId);
  await prisma.$transaction([
    // Finished matches keep their lineups. Unfinished ones must not: a slot
    // held by someone no longer on the team fails roster validation on every
    // later save, and the captain has no way to deselect a player who is no
    // longer listed.
    prisma.lineupSlot.deleteMany({
      where: {
        playerId: member.playerId,
        lineup: {
          teamId: member.teamId,
          matchMap: { match: { state: { not: 'COMPLETE' } } },
        },
      },
    }),
    prisma.teamMember.delete({ where: { id: memberId } }),
  ]);
  revalidatePath('/t', 'layout');
}

export async function updateTeam(formData: FormData): Promise<void> {
  const teamId = String(formData.get('teamId'));
  await requireTeamManager(teamId);

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { divisionId: true, division: { select: { tournament: { select: { id: true, slug: true } } } } },
  });
  if (!team) return;
  const back = `/t/${team.division.tournament.slug}/teams`;

  const name = String(formData.get('name') ?? '').trim();
  if (!name) failBack(back, 'A team needs a name.');

  const taken = await prisma.team.findFirst({
    where: {
      id: { not: teamId },
      name: { equals: name, mode: 'insensitive' },
      division: { tournamentId: team.division.tournament.id },
    },
    select: { id: true },
  });
  if (taken) failBack(back, `There is already a team called "${name}" in this tournament.`);

  const hex = (value: FormDataEntryValue | null) =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;

  await prisma.team.update({
    where: { id: teamId },
    data: { name, color: hex(formData.get('color')), colorSecondary: hex(formData.get('colorSecondary')) },
  });
  revalidatePath('/t', 'layout');
}

export async function deleteTeam(formData: FormData): Promise<void> {
  const teamId = String(formData.get('teamId'));
  await requireTeamManager(teamId);

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      name: true,
      division: { select: { tournament: { select: { slug: true } } } },
      _count: { select: { matchesAsA: true, matchesAsB: true } },
    },
  });
  if (!team) return;

  // A team is half of every match it played; deleting it would take those
  // matches' records with it.
  const matches = team._count.matchesAsA + team._count.matchesAsB;
  if (matches > 0) {
    failBack(
      `/t/${team.division.tournament.slug}/teams`,
      `${team.name} has ${matches} match${matches === 1 ? '' : 'es'} on record, so it cannot be deleted. Rename it instead.`,
    );
  }

  await prisma.team.delete({ where: { id: teamId } });
  revalidatePath('/t', 'layout');
}

/**
 * Substitutes and absences.
 *
 * `available` is the one thing the rest of the app asks: can this player be
 * fielded right now? A sub starts unavailable and is switched in; a regular
 * starts available and can be marked absent. A captain can do this for their
 * own team - who turned up is theirs to know - as can anyone running the event.
 */
export async function setMemberStatus(
  memberId: string,
  change: { isSub?: boolean; available?: boolean },
): Promise<void> {
  const member = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: {
      teamId: true,
      playerId: true,
      isSub: true,
      available: true,
      team: { select: { division: { select: { tournamentId: true } } } },
    },
  });
  if (!member) return;

  const actor = await getActor(member.team.division.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  if (!can(actor, 'MANAGE_TEAMS') && !isCaptainOf(actor, member.teamId)) {
    throw new ForbiddenError('MANAGE_TEAMS');
  }

  const isSub = change.isSub ?? member.isSub;
  // Becoming a sub benches them; stopping being one brings them back.
  const available =
    change.available ?? (change.isSub === undefined ? member.available : !change.isSub);

  await prisma.$transaction([
    prisma.teamMember.update({ where: { id: memberId }, data: { isSub, available } }),
    // Someone who cannot play cannot stay in an unfinished lineup - it would
    // fail roster validation on every later save, with no way to deselect them.
    ...(available
      ? []
      : [
          prisma.lineupSlot.deleteMany({
            where: {
              playerId: member.playerId,
              lineup: {
                teamId: member.teamId,
                matchMap: { match: { state: { not: 'COMPLETE' } } },
              },
            },
          }),
        ]),
  ]);
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

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { slug: true },
  });
  if (!tournament) throw new Error('No such tournament.');
  // The form exists on two pages; go back to whichever sent it.
  const back =
    formData.get('from') === 'teams' ? `/t/${tournament.slug}/teams` : `/t/${tournament.slug}`;

  const taken = await prisma.team.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, division: { tournamentId } },
    select: { id: true },
  });
  if (taken) failBack(back, `There is already a team called "${name}" in this tournament.`);

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

/**
 * Link (or unlink) a player's ScoreSaber profile.
 *
 * ScoreSaber has no sign-in to prove a profile is yours, so this cannot be
 * verified the way a BeatLeader login is. It is open to the player themselves,
 * to the people running a tournament they are rostered in, and to site admins
 * - and the profile is checked to exist. What is at stake is which public
 * scores count toward someone's stats, and it shows on their page for anyone
 * to correct.
 */
export async function linkScoreSaber(formData: FormData): Promise<void> {
  const playerId = String(formData.get('playerId'));
  const slug = String(formData.get('slug'));
  const back = `/t/${slug}/stats/${playerId}`;

  const [player, tournament] = await Promise.all([
    prisma.player.findUnique({ where: { id: playerId }, select: { id: true, userId: true } }),
    prisma.tournament.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  if (!player || !tournament) throw new Error('No such player.');

  const actor = await getActor(tournament.id);
  if (!actor) throw new Error('Sign in first.');
  const rostered = await prisma.teamMember.findFirst({
    where: { playerId, team: { division: { tournamentId: tournament.id } } },
    select: { id: true },
  });
  const allowed = player.userId === actor.userId || (rostered != null && can(actor, 'MANAGE_TEAMS'));
  if (!allowed) throw new ForbiddenError('MANAGE_TEAMS');

  if (formData.get('unlink') === 'on') {
    await prisma.$transaction([
      prisma.scoreSaberScore.deleteMany({ where: { playerId } }),
      prisma.player.update({
        where: { id: playerId },
        data: {
          scoreSaberId: null,
          ssPp: 0,
          ssRank: 0,
          ssCountryRank: 0,
          ssRankedPlayCount: 0,
          ssAvgRankedAcc: 0,
          ssSyncedAt: null,
          ssBackfilledAt: null,
          // Or the automatic lookup would find the same profile again within the week.
          ssOptOut: true,
        },
      }),
    ]);
    revalidatePath('/t', 'layout');
    return;
  }

  const scoreSaberId = parseScoreSaberId(String(formData.get('profile') ?? ''));
  if (!scoreSaberId) failBack(back, 'Paste a ScoreSaber profile link (scoresaber.com/u/...) or the id from one.');

  const taken = await prisma.player.findFirst({
    where: { scoreSaberId, id: { not: playerId } },
    select: { name: true },
  });
  if (taken) failBack(back, `That ScoreSaber profile is already linked to ${taken.name}.`);

  let profile;
  try {
    profile = await new ScoreSaberClient().getPlayer(scoreSaberId);
  } catch {
    failBack(back, 'ScoreSaber could not be reached. Try again in a moment.');
  }
  if (!profile) failBack(back, 'ScoreSaber has no such player.');

  await prisma.player.update({
    where: { id: playerId },
    data: {
      scoreSaberId,
      ssPp: profile.pp ?? 0,
      ssRank: profile.rank ?? 0,
      ssCountryRank: profile.countryRank ?? 0,
      ssRankedPlayCount: profile.scoreStats?.rankedPlayCount ?? 0,
      ssAvgRankedAcc: (profile.scoreStats?.averageRankedAccuracy ?? 0) / 100,
      ssOptOut: false,
      // The scores are the worker's job; this makes it a full walk on its next pass.
      ssSyncedAt: null,
      ssBackfilledAt: null,
    },
  });
  await requestRefresh(undefined, actor.userId);
  revalidatePath('/t', 'layout');
}

/**
 * The add-player search, on ScoreSaber. For someone who is only there - or
 * whose name there is the one the organiser knows.
 */
export async function searchScoreSaberCandidates(
  teamId: string,
  rawQuery: string,
): Promise<{ candidates: PlayerCandidate[]; error?: string }> {
  await requireTeamManager(teamId);
  const query = rawQuery.trim();
  if (!query) return { candidates: [], error: 'Enter a ScoreSaber profile link, id, or name.' };

  const client = new ScoreSaberClient();
  const id = parseScoreSaberId(query);
  let found: Array<{ id: string; name: string; profilePicture?: string; country?: string; pp?: number; rank?: number }> = [];
  try {
    if (id) {
      const exact = await client.getPlayer(id);
      found = exact ? [{ ...exact, profilePicture: (exact as { profilePicture?: string }).profilePicture }] : [];
    } else if (query.length < 4) {
      return { candidates: [], error: 'ScoreSaber needs at least four letters to search by name.' };
    } else {
      found = await client.searchPlayers(query);
    }
  } catch {
    return { candidates: [], error: 'ScoreSaber could not be reached. Try again in a moment.' };
  }

  const ids = found.map((p) => p.id);
  const [onTeam, known] = await Promise.all([
    prisma.teamMember.findMany({
      where: { teamId, player: { OR: [{ scoreSaberId: { in: ids } }, { beatLeaderId: { in: ids } }] } },
      select: { player: { select: { scoreSaberId: true, beatLeaderId: true } } },
    }),
    prisma.player.findMany({ where: { scoreSaberId: { in: ids }, userId: { not: null } }, select: { scoreSaberId: true } }),
  ]);
  const onTeamIds = new Set(onTeam.flatMap((m) => [m.player.scoreSaberId, m.player.beatLeaderId]));
  const linkedIds = new Set(known.map((p) => p.scoreSaberId));

  const candidates = found.slice(0, 20).map((p) => ({
    beatLeaderId: p.id,
    name: p.name,
    avatar: p.profilePicture ?? null,
    country: p.country ?? null,
    pp: p.pp ?? 0,
    rank: p.rank ?? 0,
    accountName: null,
    linked: linkedIds.has(p.id),
    onTeam: onTeamIds.has(p.id),
    platform: 'scoresaber' as const,
  }));
  return { candidates, error: candidates.length === 0 ? `No ScoreSaber player matching "${query}".` : undefined };
}

/**
 * Add someone picked from a ScoreSaber search.
 *
 * A player here is keyed by their BeatLeader id. For a Steam player that is the
 * same id as ScoreSaber's, so the BeatLeader profile is looked up and both are
 * linked at once. Where BeatLeader has never heard of them the id is kept in
 * that field anyway - it is still theirs, and it starts working the day they
 * install BeatLeader - and ScoreSaber carries their stats until then.
 */
export async function addPlayerFromScoreSaber(teamId: string, scoreSaberId: string): Promise<{ error?: string }> {
  const actor = await requireTeamManager(teamId);

  let player = await prisma.player.findFirst({
    where: { OR: [{ scoreSaberId }, { beatLeaderId: scoreSaberId }] },
  });
  if (!player) {
    let ss;
    let bl = null;
    try {
      ss = await new ScoreSaberClient().getPlayer(scoreSaberId);
      bl = looksLikeSteamId(scoreSaberId) ? await beatLeader.getPlayer(scoreSaberId).catch(() => null) : null;
    } catch {
      return { error: 'ScoreSaber could not be reached. Try again in a moment.' };
    }
    if (!ss) return { error: 'ScoreSaber has no such player.' };
    player = await prisma.player.create({
      data: {
        beatLeaderId: bl?.id ?? scoreSaberId,
        scoreSaberId,
        name: bl?.name ?? ss.name,
        avatar: bl?.avatar ?? (ss as { profilePicture?: string }).profilePicture ?? null,
        country: bl?.country ?? ss.country ?? null,
        pp: bl?.pp ?? 0,
        rank: bl?.rank ?? 0,
        ssPp: ss.pp ?? 0,
        ssRank: ss.rank ?? 0,
      },
    });
  } else if (!player.scoreSaberId) {
    await prisma.player.update({ where: { id: player.id }, data: { scoreSaberId, ssOptOut: false, ssBackfilledAt: null, ssSyncedAt: null } });
  }

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

/** Link a rostered player's ScoreSaber from the teams page, to the profile picked from a search. */
export async function linkScoreSaberToMember(memberId: string, scoreSaberId: string): Promise<{ error?: string }> {
  const member = await prisma.teamMember.findUnique({ where: { id: memberId }, select: { teamId: true, playerId: true } });
  if (!member) return { error: 'No such player.' };
  const actor = await requireTeamManager(member.teamId);

  const taken = await prisma.player.findFirst({
    where: { scoreSaberId, id: { not: member.playerId } },
    select: { name: true },
  });
  if (taken) return { error: `That ScoreSaber profile is already linked to ${taken.name}.` };

  let profile;
  try {
    profile = await new ScoreSaberClient().getPlayer(scoreSaberId);
  } catch {
    return { error: 'ScoreSaber could not be reached. Try again in a moment.' };
  }
  if (!profile) return { error: 'ScoreSaber has no such player.' };

  await prisma.player.update({
    where: { id: member.playerId },
    data: {
      scoreSaberId,
      ssPp: profile.pp ?? 0,
      ssRank: profile.rank ?? 0,
      ssCountryRank: profile.countryRank ?? 0,
      ssOptOut: false,
      ssSyncedAt: null,
      ssBackfilledAt: null,
    },
  });
  await requestRefresh(undefined, actor.userId);
  revalidatePath('/t', 'layout');
  return {};
}

/** The ScoreSaber search, for linking someone who is already on a roster. */
export async function searchScoreSaberForMember(
  memberId: string,
  rawQuery: string,
): Promise<{ candidates: PlayerCandidate[]; error?: string }> {
  const member = await prisma.teamMember.findUnique({ where: { id: memberId }, select: { teamId: true } });
  if (!member) return { candidates: [], error: 'No such player.' };
  const result = await searchScoreSaberCandidates(member.teamId, rawQuery);
  // "On team" means something else here: a profile that is already somebody's cannot be linked again.
  const ids = result.candidates.map((c) => c.beatLeaderId);
  const inUse = new Set(
    (await prisma.player.findMany({ where: { scoreSaberId: { in: ids } }, select: { scoreSaberId: true } })).map(
      (p) => p.scoreSaberId,
    ),
  );
  return { ...result, candidates: result.candidates.map((c) => ({ ...c, onTeam: inUse.has(c.beatLeaderId) })) };
}

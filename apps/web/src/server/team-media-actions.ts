'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma, Prisma } from '@bscs/db';
import { can, isCaptainOf } from '@bscs/core/match';
import {
  parseReplayRef,
  parseShowcaseReplays,
  SHOWCASE_REPLAYS_MAX,
  SHOWCASE_REPLAYS_PER_PLAYER,
  type ShowcaseReplay,
} from '@bscs/core';
import { getActor } from './session';
import { failBack } from './form-errors';
import { hexColour, pastedLines, readReplayList } from './showcase';
import { tournamentAliases } from './aliases';
import { chosenFile, dropUpload, saveUpload, UploadError } from './uploads';

/**
 * How teams and players look, on the site and on stream: a team's logo, a
 * player's nickname and picture for this tournament, and the replays a player
 * wants shown while their team is up next. From the teams page.
 */

async function memberOf(formData: FormData) {
  const memberId = String(formData.get('memberId'));
  const member = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: {
      teamId: true,
      playerId: true,
      player: { select: { name: true, userId: true, beatLeaderId: true } },
      team: { select: { division: { select: { tournament: { select: { id: true, slug: true } } } } } },
    },
  });
  if (!member) throw new Error('No such player.');
  const tournament = member.team.division.tournament;
  const actor = await getActor(tournament.id);
  if (!actor) throw new Error('Sign in first.');
  return { member, tournament, actor, back: `/t/${tournament.slug}/teams` };
}

function done(back: string): never {
  revalidatePath('/t', 'layout');
  redirect(back);
}

/** A team's logo: the default star, the MSU Esports shield, or an uploaded picture. Organisers only. */
export async function setTeamLogo(formData: FormData): Promise<void> {
  const teamId = String(formData.get('teamId'));
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { logo: true, division: { select: { tournament: { select: { id: true, slug: true } } } } },
  });
  if (!team) throw new Error('No such team.');
  const tournament = team.division.tournament;
  const actor = await getActor(tournament.id);
  if (!actor) throw new Error('Sign in first.');
  if (!can(actor, 'MANAGE_TEAMS')) throw new Error('You cannot change this team.');
  const back = `/t/${tournament.slug}/teams`;

  const choice = String(formData.get('logo') ?? '');
  const file = chosenFile(formData.get('file'));
  let logo: string | null;
  if (file) {
    // A file chosen wins over the buttons: nobody picks a file meaning not to use it.
    try {
      logo = await saveUpload(tournament.id, file);
    } catch (err) {
      if (err instanceof UploadError) failBack(back, err.message);
      throw err;
    }
  } else if (choice === 'msu') logo = 'msu';
  else if (choice === 'star') logo = null;
  else if (choice === 'upload') {
    if (!team.logo || team.logo === 'msu') failBack(back, 'Choose a picture to upload.');
    logo = team.logo;
  } else failBack(back, 'Choose a logo.');

  if (logo !== team.logo) {
    await prisma.team.update({ where: { id: teamId }, data: { logo } });
    await dropUpload(team.logo);
  }
  done(back);
}

/** A player's nickname and picture in this tournament. Blank goes back to BeatLeader's. Organisers only. */
export async function setPlayerShown(formData: FormData): Promise<void> {
  const { member, tournament, actor, back } = await memberOf(formData);
  if (!can(actor, 'MANAGE_TEAMS')) throw new Error('You cannot change this player.');

  const nickname = String(formData.get('nickname') ?? '').trim().replace(/\s+/g, ' ');
  if (nickname.length > 40) failBack(back, 'A nickname can be 40 characters at most.');
  const existing = await prisma.tournamentPlayer.findUnique({
    where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: member.playerId } },
    select: { avatar: true },
  });
  const file = chosenFile(formData.get('file'));
  let avatar = existing?.avatar ?? null;
  if (file) {
    try {
      avatar = await saveUpload(tournament.id, file);
    } catch (err) {
      if (err instanceof UploadError) failBack(back, err.message);
      throw err;
    }
  } else if (formData.get('removeAvatar') === 'on') avatar = null;

  const data = { nickname: nickname && nickname !== member.player.name ? nickname : null, avatar };
  await prisma.tournamentPlayer.upsert({
    where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: member.playerId } },
    create: { tournamentId: tournament.id, playerId: member.playerId, ...data },
    update: data,
  });
  if (existing?.avatar && existing.avatar !== avatar) await dropUpload(existing.avatar);
  done(back);
}

/**
 * A player's saber colours in this tournament: what replay viewers and the
 * stream draw their sabers (and notes) in. The player themself, their team's
 * captain and organisers may set them. "clear" goes back to the game's own.
 */
export async function setPlayerSabers(formData: FormData): Promise<void> {
  const { member, tournament, actor, back } = await memberOf(formData);
  const own = !!actor.userId && member.player.userId === actor.userId;
  if (!can(actor, 'MANAGE_TEAMS') && !own && !isCaptainOf(actor, member.teamId)) throw new Error("You cannot set this player's colours.");

  const clear = formData.get('clear') != null;
  let left = clear ? null : hexColour(formData.get('left'));
  let right = clear ? null : hexColour(formData.get('right'));
  if (!clear && (!left || !right)) failBack(back, 'Choose a colour for each saber.');
  // The colours on their own profile, saved here: the tournament has none of its own, and goes on following the
  // profile if the player changes them later.
  const profile = await prisma.player.findUnique({ where: { id: member.playerId }, select: { saberLeft: true, saberRight: true } });
  if (left && left === profile?.saberLeft && right === profile?.saberRight) left = right = null;
  const data = { saberLeft: left, saberRight: right };
  await prisma.tournamentPlayer.upsert({
    where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: member.playerId } },
    create: { tournamentId: tournament.id, playerId: member.playerId, ...data },
    update: data,
  });
  done(back);
}

/**
 * The replays a player wants shown on stream, one link per line. The player
 * themself (signed in with their BeatLeader profile) and their team's captain
 * may set up to SHOWCASE_REPLAYS_PER_PLAYER, and only replays that player
 * played; organisers may add more, of anything.
 *
 * This is the list for this tournament. Left empty (or saved as exactly what their profile has) the tournament has
 * none of its own for them and shows their profile's, whatever those become.
 */
export async function setPlayerReplays(formData: FormData): Promise<void> {
  const { member, tournament, actor, back } = await memberOf(formData);
  const staff = can(actor, 'MANAGE_TEAMS');
  const own = !!actor.userId && member.player.userId === actor.userId;
  if (!staff && !own && !isCaptainOf(actor, member.teamId)) throw new Error('You cannot set this player\'s replays.');

  const lock = await prisma.tournament.findUnique({ where: { id: tournament.id }, select: { replaysLockedAt: true } });
  const locked = !!lock?.replaysLockedAt;
  if (locked && !staff) failBack(back, 'The replays for this tournament are locked for the stream. Ask an organiser if one has to change.');

  const lines = pastedLines(formData.get('replays'));
  const limit = staff ? SHOWCASE_REPLAYS_MAX : SHOWCASE_REPLAYS_PER_PLAYER;
  if (lines.length > limit) failBack(back, `That is ${lines.length} replays; ${limit} at most${staff ? '' : ' per player'}.`);

  const [existing, profile] = await Promise.all([
    prisma.tournamentPlayer.findUnique({
      where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: member.playerId } },
      select: { replays: true },
    }),
    prisma.player.findUnique({ where: { id: member.playerId }, select: { replays: true } }),
  ]);
  const theirs = parseShowcaseReplays(profile?.replays);
  const read = await readReplayList(lines, { anyones: staff, player: member.player, known: [...theirs, ...parseShowcaseReplays(existing?.replays)] });
  if ('error' in read) failBack(back, read.error);
  // exactly what their profile has: nothing of the tournament's own to keep
  const same = read.replays.length === theirs.length && read.replays.every((r, i) => r.ref === theirs[i]!.ref);
  const stored = (same ? [] : read.replays) as unknown as Prisma.InputJsonValue;
  // While locked, what an organiser saves is what is shown from now on (an empty list: what the profile has now).
  const kept = locked ? { lockedReplays: (read.replays.length ? read.replays : theirs) as unknown as Prisma.InputJsonValue } : {};
  await prisma.tournamentPlayer.upsert({
    where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: member.playerId } },
    create: { tournamentId: tournament.id, playerId: member.playerId, replays: stored, ...kept },
    update: { replays: stored, ...kept },
  });
  done(back);
}

/**
 * Lock, or unlock, the replays this tournament shows on stream. For stream day: once on, players and captains can no
 * longer change theirs here, and what every player has at this moment (set for the tournament, or taken from their
 * profile) is kept, so changing a profile does not change the stream either. Organisers can still change a player's.
 * Unlocking drops what was kept: everyone follows their profile again.
 */
export async function setReplayLock(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  if (!can(actor, 'MANAGE_TOURNAMENT')) throw new Error('Only the tournament\'s organisers can lock its replays.');
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { slug: true, replaysLockedAt: true } });
  if (!tournament) throw new Error('No such tournament.');
  const on = formData.get('on') === '1';
  const back = `/t/${tournament.slug}/teams`;

  if (!on) {
    await prisma.$transaction([
      prisma.tournamentPlayer.updateMany({ where: { tournamentId }, data: { lockedReplays: Prisma.DbNull } }),
      prisma.tournament.update({ where: { id: tournamentId }, data: { replaysLockedAt: null } }),
    ]);
    done(back);
  }
  if (tournament.replaysLockedAt) done(back);       // already locked: what was kept then stays

  // everyone on a team of it (the player pool too), with what they show right now
  const [members, aliases] = await Promise.all([
    prisma.teamMember.findMany({ where: { team: { division: { tournamentId } } }, select: { playerId: true }, distinct: ['playerId'] }),
    tournamentAliases(tournamentId),
  ]);
  await prisma.$transaction([
    ...members.map((m) => {
      const lockedReplays = (aliases.get(m.playerId)?.replays ?? []) as unknown as Prisma.InputJsonValue;
      return prisma.tournamentPlayer.upsert({
        where: { tournamentId_playerId: { tournamentId, playerId: m.playerId } },
        create: { tournamentId, playerId: m.playerId, lockedReplays },
        update: { lockedReplays },
      });
    }),
    prisma.tournament.update({ where: { id: tournamentId }, data: { replaysLockedAt: new Date() } }),
  ]);
  done(back);
}

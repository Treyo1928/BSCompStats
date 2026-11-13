'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma, type Prisma } from '@bscs/db';
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
import { beatLeader } from './pools';
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

  const hex = (name: string) => {
    const value = String(formData.get(name) ?? '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(value) ? value : null;
  };
  const clear = formData.get('clear') != null;
  const left = clear ? null : hex('left');
  const right = clear ? null : hex('right');
  if (!clear && (!left || !right)) failBack(back, 'Choose a colour for each saber.');
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
 */
export async function setPlayerReplays(formData: FormData): Promise<void> {
  const { member, tournament, actor, back } = await memberOf(formData);
  const staff = can(actor, 'MANAGE_TEAMS');
  const own = !!actor.userId && member.player.userId === actor.userId;
  if (!staff && !own && !isCaptainOf(actor, member.teamId)) throw new Error('You cannot set this player\'s replays.');

  const lines = String(formData.get('replays') ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const limit = staff ? SHOWCASE_REPLAYS_MAX : SHOWCASE_REPLAYS_PER_PLAYER;
  if (lines.length > limit) failBack(back, `That is ${lines.length} replays; ${limit} at most${staff ? '' : ' per player'}.`);

  const existing = await prisma.tournamentPlayer.findUnique({
    where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: member.playerId } },
    select: { replays: true },
  });
  const known = new Map(parseShowcaseReplays(existing?.replays).map((r) => [r.ref, r]));

  const replays: ShowcaseReplay[] = [];
  for (const line of lines) {
    const parsed = parseReplayRef(line);
    if (!parsed) {
      failBack(back, `"${line.slice(0, 80)}" is not a replay link. Paste a BeatLeader replay link (replay.beatleader.com/?scoreId=...), a BeatLeader score id, or the address of a .bsor file.`);
    }
    if (replays.some((r) => r.ref === parsed.ref)) continue;
    const kept = known.get(parsed.ref);
    if (kept) {
      replays.push(kept);
      continue;
    }
    if (parsed.kind === 'file') {
      if (!staff) failBack(back, 'Paste a BeatLeader replay link, so the site can tell whose replay it is.');
      replays.push({ ref: parsed.ref });
      continue;
    }
    // What BeatLeader says the replay is: for the list here, and so that a player's replays are their own.
    const score = await beatLeader.getScore(parsed.scoreId).catch(() => undefined);
    if (score === null) failBack(back, `BeatLeader has no score ${parsed.scoreId}.`);
    if (score === undefined && !staff) failBack(back, 'BeatLeader could not be reached to check that replay. Try again in a moment.');
    if (score && !score.replay) failBack(back, `BeatLeader no longer has the replay file for score ${parsed.scoreId} (${score.song?.name ?? 'unknown song'}).`);
    if (score && !staff && String(score.playerId) !== member.player.beatLeaderId) {
      failBack(back, `Score ${parsed.scoreId} was played by ${score.player?.name ?? 'someone else'}, not ${member.player.name}.`);
    }
    replays.push({
      ref: parsed.ref,
      scoreId: parsed.scoreId,
      ...(score
        ? {
            song: score.song?.name ?? undefined,
            mapper: score.song?.mapper ?? undefined,
            difficulty: score.difficulty?.difficultyName ?? undefined,
            accuracy: typeof score.accuracy === 'number' ? score.accuracy : undefined,
            player: score.player?.name ?? undefined,
          }
        : {}),
    });
  }

  const stored = replays as unknown as Prisma.InputJsonValue;
  await prisma.tournamentPlayer.upsert({
    where: { tournamentId_playerId: { tournamentId: tournament.id, playerId: member.playerId } },
    create: { tournamentId: tournament.id, playerId: member.playerId, replays: stored },
    update: { replays: stored },
  });
  done(back);
}

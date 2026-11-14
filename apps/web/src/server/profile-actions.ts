'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma, type Prisma } from '@bscs/db';
import { parseShowcaseReplays, SHOWCASE_REPLAYS_MAX, SHOWCASE_REPLAYS_PER_PLAYER } from '@bscs/core';
import { realUser } from './session';
import { hexColour, pastedLines, readReplayList } from './showcase';

/**
 * A player's own saber colours and replays, set on their profile page. Every tournament they play in shows these
 * unless its organisers set others for them there. The player themself (whoever is signed in to the account their
 * BeatLeader profile is linked to) sets them; a site admin may, for anyone.
 */
async function ownPlayer(formData: FormData) {
  const user = await realUser();
  if (!user) throw new Error('Sign in first.');
  const player = await prisma.player.findUnique({
    where: { id: String(formData.get('playerId')) },
    select: { id: true, name: true, beatLeaderId: true, userId: true, replays: true },
  });
  if (!player || (player.userId !== user.id && user.role !== 'ADMIN')) throw new Error('That is not your profile.');
  const admin = user.role === 'ADMIN' && player.userId !== user.id;
  return { player, admin, back: admin ? `/account?player=${player.id}` : '/account' };
}

function done(back: string, error?: string): never {
  revalidatePath('/', 'layout');
  redirect(error ? `${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(error)}` : back);
}

export async function setProfileSabers(formData: FormData): Promise<void> {
  const { player, back } = await ownPlayer(formData);
  const clear = formData.get('clear') != null;
  const left = clear ? null : hexColour(formData.get('left'));
  const right = clear ? null : hexColour(formData.get('right'));
  if (!clear && (!left || !right)) done(back, 'Choose a colour for each saber.');
  await prisma.player.update({ where: { id: player.id }, data: { saberLeft: left, saberRight: right } });
  done(back);
}

export async function setProfileReplays(formData: FormData): Promise<void> {
  const { player, admin, back } = await ownPlayer(formData);
  const lines = pastedLines(formData.get('replays'));
  const limit = admin ? SHOWCASE_REPLAYS_MAX : SHOWCASE_REPLAYS_PER_PLAYER;
  if (lines.length > limit) done(back, `That is ${lines.length} replays; ${limit} at most.`);
  const read = await readReplayList(lines, { anyones: admin, player, known: parseShowcaseReplays(player.replays) });
  if ('error' in read) done(back, read.error);
  await prisma.player.update({ where: { id: player.id }, data: { replays: read.replays as unknown as Prisma.InputJsonValue } });
  done(back);
}

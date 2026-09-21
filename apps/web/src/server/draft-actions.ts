'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { nextDraftSlot, parseDraftSettings } from '@bscs/core/match';
import { assertCan, can } from './match-helpers';
import { getActor } from './session';
import { failBack } from './form-errors';
import { announceMatchChange, requestRefresh } from '@/lib/redis';
import { cleanUpAdHocTeams, createAdHocTeam, hexColor, openMatch, SIDE_COLORS } from './custom-teams';

/**
 * Custom matches: sides that exist for the match rather than the tournament,
 * either named outright or chosen by two captains in a draft.
 */

/** A draft's pages listen on the match channel under this key. */
const draftChannel = (draftId: string) => `draft:${draftId}`;

async function draftChanged(slug: string, draftId: string): Promise<void> {
  revalidatePath(`/t/${slug}/draft/${draftId}`);
  await announceMatchChange(draftChannel(draftId));
}

const ids = (formData: FormData, name: string): string[] => [
  ...new Set(formData.getAll(name).map(String).filter(Boolean)),
];

async function requireMatchMaker(tournamentId: string) {
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'CREATE_MATCH');
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { slug: true },
  });
  if (!tournament) throw new Error('No such tournament.');
  return { actor, slug: tournament.slug };
}

/** Every id must be a player we know; returns how many were not. */
async function unknownPlayers(playerIds: string[]): Promise<number> {
  const known = await prisma.player.count({ where: { id: { in: playerIds } } });
  return playerIds.length - known;
}

/**
 * Two hand-picked sides and a match between them, in one step.
 *
 * The same player may be named on both sides: a match already counts a shared
 * player's run once for each team.
 */
export async function createCustomMatch(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const { actor, slug } = await requireMatchMaker(tournamentId);
  const back = `/t/${slug}/custom`;

  const playersA = ids(formData, 'playerA');
  const playersB = ids(formData, 'playerB');
  if (playersA.length === 0 || playersB.length === 0) {
    failBack(back, 'Each side needs at least one player.');
  }
  if (await unknownPlayers([...new Set([...playersA, ...playersB])])) {
    failBack(back, 'One of those players is not known here. Add them as a guest first.');
  }

  const captainA = String(formData.get('captainA') ?? '');
  const captainB = String(formData.get('captainB') ?? '');

  const [teamA, teamB] = await prisma.$transaction(async (tx) => {
    const a = await createAdHocTeam(tx, {
      tournamentId,
      name: String(formData.get('nameA') ?? '') || 'Team A',
      color: hexColor(formData.get('colorA')) ?? SIDE_COLORS.A.color,
      colorSecondary: SIDE_COLORS.A.colorSecondary,
      playerIds: playersA,
      captainId: playersA.includes(captainA) ? captainA : null,
    });
    const b = await createAdHocTeam(tx, {
      tournamentId,
      name: String(formData.get('nameB') ?? '') || 'Team B',
      color: hexColor(formData.get('colorB')) ?? SIDE_COLORS.B.color,
      colorSecondary: SIDE_COLORS.B.colorSecondary,
      playerIds: playersB,
      captainId: playersB.includes(captainB) ? captainB : null,
    });
    return [a, b];
  });

  const opened = await openMatch({
    tournamentId,
    poolId: String(formData.get('poolId')),
    teamAId: teamA.id,
    teamBId: teamB.id,
    coinFlip: formData.get('coinFlip') === 'B' ? 'B' : 'A',
    blindLineups: formData.get('blindLineups') === 'on',
    name: String(formData.get('name') ?? ''),
  });
  if ('error' in opened) {
    await cleanUpAdHocTeams([teamA.id, teamB.id]);
    failBack(back, opened.error);
  }

  // Guests are only followed by the score feed once they are on a team.
  await requestRefresh(undefined, actor.userId);
  revalidatePath('/t', 'layout');
  redirect(`/t/${slug}/match/${opened.matchId}`);
}

/** Set up a captains' draft: two captains, a pool to choose from, and the order of picking. */
export async function createDraft(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const { actor, slug } = await requireMatchMaker(tournamentId);
  const back = `/t/${slug}/custom`;

  const captainA = String(formData.get('captainA') ?? '');
  const captainB = String(formData.get('captainB') ?? '');
  if (!captainA || !captainB) failBack(back, 'A draft needs two captains.');
  if (captainA === captainB) failBack(back, 'The two captains have to be different people.');

  const pool = ids(formData, 'poolPlayer').filter((id) => id !== captainA && id !== captainB);
  if (pool.length === 0) failBack(back, 'Choose at least one player for the captains to pick from.');
  if (await unknownPlayers([captainA, captainB, ...pool])) {
    failBack(back, 'One of those players is not known here. Add them as a guest first.');
  }

  const captains = await prisma.player.findMany({
    where: { id: { in: [captainA, captainB] } },
    select: { id: true, name: true },
  });
  const nameOf = (id: string) => captains.find((c) => c.id === id)?.name ?? 'Captain';

  const wantsFirst = String(formData.get('firstPick') ?? 'A');
  const settings = parseDraftSettings({
    order: String(formData.get('order') ?? ''),
    // The coin is tossed here, once, so everyone watching sees the same result.
    firstPick: wantsFirst === 'RANDOM' ? (Math.random() < 0.5 ? 'A' : 'B') : wantsFirst,
    shareOdd: formData.get('shareOdd') === 'on',
  });

  const draft = await prisma.$transaction(async (tx) => {
    const teamA = await createAdHocTeam(tx, {
      tournamentId,
      name: String(formData.get('nameA') ?? '') || `Team ${nameOf(captainA)}`,
      color: hexColor(formData.get('colorA')) ?? SIDE_COLORS.A.color,
      colorSecondary: SIDE_COLORS.A.colorSecondary,
      playerIds: [captainA],
      captainId: captainA,
    });
    const teamB = await createAdHocTeam(tx, {
      tournamentId,
      name: String(formData.get('nameB') ?? '') || `Team ${nameOf(captainB)}`,
      color: hexColor(formData.get('colorB')) ?? SIDE_COLORS.B.color,
      colorSecondary: SIDE_COLORS.B.colorSecondary,
      playerIds: [captainB],
      captainId: captainB,
    });
    return tx.draft.create({
      data: {
        tournamentId,
        name: `${teamA.name} vs ${teamB.name}`,
        teamAId: teamA.id,
        teamBId: teamB.id,
        ...settings,
        players: { create: pool.map((playerId) => ({ playerId })) },
      },
      select: { id: true },
    });
  });

  // A pool of one, shared, has nobody to take a turn.
  await settleSharedPlayer(draft.id);
  await requestRefresh(undefined, actor.userId);
  revalidatePath('/t', 'layout');
  redirect(`/t/${slug}/draft/${draft.id}`);
}

async function loadDraft(draftId: string) {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: {
      tournament: { select: { slug: true } },
      players: { select: { id: true, playerId: true, pickNumber: true, side: true } },
    },
  });
  if (!draft) throw new Error('Draft not found.');
  return draft;
}

async function addToTeam(tx: Parameters<typeof createAdHocTeam>[0], teamId: string, playerId: string) {
  const last = await tx.teamMember.aggregate({ where: { teamId }, _max: { order: true } });
  await tx.teamMember.upsert({
    where: { teamId_playerId: { teamId, playerId } },
    create: { teamId, playerId, order: (last._max.order ?? -1) + 1 },
    update: {},
  });
}

/** When the only slot left is the shared one, the last player joins both sides. No one picks. */
async function settleSharedPlayer(draftId: string): Promise<void> {
  const draft = await loadDraft(draftId);
  const made = draft.players.filter((p) => p.pickNumber != null).length;
  if (nextDraftSlot(parseDraftSettings(draft), draft.players.length, made) !== 'BOTH') return;

  const last = draft.players.find((p) => p.pickNumber == null);
  if (!last) return;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.draftPlayer.updateMany({
      where: { id: last.id, pickNumber: null },
      data: { pickNumber: made, side: 'BOTH' },
    });
    if (claimed.count === 0) return;
    await addToTeam(tx, draft.teamAId, last.playerId);
    await addToTeam(tx, draft.teamBId, last.playerId);
  });
}

/**
 * One pick. Whose turn it is comes from the picks already made, never from the
 * form - and (draftId, pickNumber) is unique, so two people taking the same
 * turn at the same moment cannot both succeed.
 */
export async function draftPick(formData: FormData): Promise<void> {
  const draftId = String(formData.get('draftId'));
  const playerId = String(formData.get('playerId'));

  const draft = await loadDraft(draftId);
  const actor = await getActor(draft.tournamentId);
  if (!actor) throw new Error('Sign in first.');

  const made = draft.players.filter((p) => p.pickNumber != null).length;
  const slot = nextDraftSlot(parseDraftSettings(draft), draft.players.length, made);
  const target = draft.players.find((p) => p.playerId === playerId);

  // Finished, already started, or a player who has just gone: a tab that is a
  // step behind. Show the draft as it now stands rather than an error.
  if (draft.matchId || !slot || slot === 'BOTH' || !target || target.pickNumber != null) {
    await draftChanged(draft.tournament.slug, draftId);
    return;
  }

  const teamId = slot === 'A' ? draft.teamAId : draft.teamBId;
  if (!can(actor, 'MAKE_PICK_BAN', { teamId })) throw new Error('It is not your pick.');

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.draftPlayer.updateMany({
        where: { id: target.id, pickNumber: null },
        data: { pickNumber: made, side: slot },
      });
      if (claimed.count === 0) return;
      await addToTeam(tx, teamId, playerId);
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
  }

  await settleSharedPlayer(draftId);
  revalidatePath('/t', 'layout');
  await draftChanged(draft.tournament.slug, draftId);
}

/** Take back the last pick. Staff only, and not once the match is under way. */
export async function undoDraftPick(formData: FormData): Promise<void> {
  const draftId = String(formData.get('draftId'));
  const draft = await loadDraft(draftId);
  const actor = await getActor(draft.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'UNDO_ACTION');
  if (draft.matchId) return;

  const picked = draft.players
    .filter((p) => p.pickNumber != null)
    .sort((a, b) => b.pickNumber! - a.pickNumber!);
  // The shared player was nobody's choice, so taking it back alone would leave
  // the draft waiting on a turn that does not exist. It goes with the pick before it.
  const undone = picked[0]?.side === 'BOTH' ? picked.slice(0, 2) : picked.slice(0, 1);
  if (undone.length === 0) return;

  await prisma.$transaction([
    prisma.draftPlayer.updateMany({
      where: { id: { in: undone.map((p) => p.id) } },
      data: { pickNumber: null, side: null },
    }),
    prisma.teamMember.deleteMany({
      where: {
        teamId: { in: [draft.teamAId, draft.teamBId] },
        playerId: { in: undone.map((p) => p.playerId) },
      },
    }),
  ]);

  revalidatePath('/t', 'layout');
  await draftChanged(draft.tournament.slug, draftId);
}

/** The draft is done: open the match between the two sides it produced. */
export async function startDraftMatch(formData: FormData): Promise<void> {
  const draftId = String(formData.get('draftId'));
  const draft = await loadDraft(draftId);
  const actor = await getActor(draft.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'CREATE_MATCH');

  const back = `/t/${draft.tournament.slug}/draft/${draftId}`;
  if (draft.matchId) redirect(`/t/${draft.tournament.slug}/match/${draft.matchId}`);
  if (draft.players.some((p) => p.pickNumber == null)) {
    failBack(back, 'There are still players to be picked.');
  }

  const opened = await openMatch({
    tournamentId: draft.tournamentId,
    poolId: String(formData.get('poolId')),
    teamAId: draft.teamAId,
    teamBId: draft.teamBId,
    coinFlip: formData.get('coinFlip') === 'B' ? 'B' : 'A',
    blindLineups: formData.get('blindLineups') === 'on',
  });
  if ('error' in opened) failBack(back, opened.error);

  await prisma.draft.update({ where: { id: draftId }, data: { matchId: opened.matchId } });
  await draftChanged(draft.tournament.slug, draftId);
  redirect(`/t/${draft.tournament.slug}/match/${opened.matchId}`);
}

/** Abandon a draft. Its sides go with it unless they have already played. */
export async function deleteDraft(formData: FormData): Promise<void> {
  const draftId = String(formData.get('draftId'));
  const draft = await loadDraft(draftId);
  const actor = await getActor(draft.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'CREATE_MATCH');

  await prisma.draft.delete({ where: { id: draftId } });
  await cleanUpAdHocTeams([draft.teamAId, draft.teamBId]);
  await announceMatchChange(draftChannel(draftId));
  revalidatePath('/t', 'layout');
  redirect(`/t/${draft.tournament.slug}`);
}

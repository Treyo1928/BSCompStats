'use server';

import { prisma } from '@bscs/db';
import { can } from './match-helpers';
import { getActorOrAnonymous } from './session';

/** What the player card shows: who they are, where they play, and their profiles. */
export interface PlayerOverview {
  playerId: string;
  name: string;
  avatar: string | null;
  country: string | null;
  beatLeaderId: string;
  /** Null until their ScoreSaber is linked. */
  scoreSaberId: string | null;
  pp: number;
  ssPp: number;
  globalRank: number;
  ssRank: number;
  /** Whether BeatLeader shows their runs - what pulling match scores for them depends on. Null: not asked yet. */
  runsPublic: boolean | null;
  teams: Array<{ teamId: string; name: string; color: string; colorSecondary: string | null; isCaptain: boolean }>;
}

/**
 * Fetched when the card is opened rather than sent with every page: a board
 * has dozens of players on it and nearly all of them are never tapped.
 */
export async function getPlayerOverview(
  slug: string,
  playerId: string,
): Promise<{ overview?: PlayerOverview; error?: string }> {
  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, isPublic: true },
  });
  const actor = await getActorOrAnonymous(tournament?.id);
  if (!tournament || !can(actor, 'VIEW', { isPublic: tournament.isPublic })) {
    return { error: 'Not found.' };
  }

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: {
      id: true,
      name: true,
      avatar: true,
      country: true,
      beatLeaderId: true,
      scoreSaberId: true,
      pp: true,
      rank: true,
      ssPp: true,
      ssRank: true,
      attemptsPublic: true,
      teamMembers: {
        where: { team: { division: { tournamentId: tournament.id } } },
        orderBy: { team: { adHoc: 'asc' } },
        select: { role: true, team: { select: { id: true, name: true, color: true, colorSecondary: true } } },
      },
    },
  });
  if (!player) return { error: 'No such player.' };

  return {
    overview: {
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      country: player.country,
      beatLeaderId: player.beatLeaderId,
      scoreSaberId: player.scoreSaberId,
      pp: player.pp,
      ssPp: player.ssPp,
      globalRank: player.rank,
      ssRank: player.ssRank,
      runsPublic: player.attemptsPublic,
      teams: player.teamMembers.map((m) => ({
        teamId: m.team.id,
        name: m.team.name,
        color: m.team.color,
        colorSecondary: m.team.colorSecondary,
        isCaptain: m.role === 'CAPTAIN',
      })),
    },
  };
}

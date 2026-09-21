'use server';

import { prisma } from '@bscs/db';
import type { Specialty } from '@bscs/core/stats';
import { can } from './match-helpers';
import { getActorOrAnonymous } from './session';
import { buildTournamentStats } from './player-stats';

/** What the player card shows: enough to place someone, and where to go for more. */
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
  teams: Array<{
    teamId: string;
    name: string;
    color: string;
    colorSecondary: string | null;
    isCaptain: boolean;
    teamRank: number | null;
    teamSize: number;
  }>;
  fieldRank: number | null;
  fieldSize: number;
  meanAcc: number | null;
  played: number;
  mapCount: number;
  style: Pick<Specialty, 'badges' | 'summary'> | null;
}

/**
 * Fetched when the card is opened rather than sent with every page: a board
 * has dozens of players on it and nearly all of them are never tapped.
 *
 * Goes through the same check as the stats pages, so the card cannot show
 * anything about a private tournament that its pages would not.
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
    },
  });
  if (!player) return { error: 'No such player.' };

  const stats = await buildTournamentStats(tournament.id);
  const spots = stats.teams.flatMap((team) =>
    team.players.filter((p) => p.playerId === playerId).map((me) => ({ team, me })),
  );
  // Entered teams come first, so that is whose figures lead.
  const me = spots[0]?.me;

  return {
    overview: {
      playerId: player.id,
      name: player.name,
      avatar: player.avatar,
      country: player.country,
      beatLeaderId: player.beatLeaderId,
      scoreSaberId: player.scoreSaberId,
      ssPp: player.ssPp,
      pp: player.pp,
      globalRank: player.rank,
      teams: spots.map(({ team, me: spot }) => ({
        teamId: team.teamId,
        name: team.name,
        color: team.color,
        colorSecondary: team.colorSecondary,
        isCaptain: spot.isCaptain,
        teamRank: spot.standings.overall.teamRank,
        teamSize: spot.standings.overall.teamRanked,
      })),
      fieldRank: me?.standings.overall.fieldRank ?? null,
      fieldSize: me?.standings.overall.fieldRanked ?? stats.fieldSize,
      meanAcc: me?.profile && me.profile.meanAcc > 0 ? me.profile.meanAcc : null,
      played: me?.played ?? 0,
      mapCount: stats.mapCount,
      style: me?.profile ? { badges: me.specialty.badges, summary: me.specialty.summary } : null,
    },
  };
}

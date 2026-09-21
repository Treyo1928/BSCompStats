import { prisma } from '@bscs/db';
import { auth } from '@/lib/auth';
import type { Actor, TournamentRole } from '@bscs/core/match';

/**
 * Resolve the signed-in user into the Actor the permission rules understand.
 *
 * The tournament role is looked up per request rather than cached in the
 * session, so promoting someone to organiser takes effect immediately instead
 * of after they next sign in.
 */
export async function getActor(tournamentId?: string): Promise<Actor | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const actor: Actor = {
    userId: session.user.id,
    globalRole: session.user.role ?? 'USER',
  };

  if (tournamentId) {
    const [membership, rosterSpots] = await Promise.all([
      prisma.tournamentMember.findUnique({
        where: { tournamentId_userId: { tournamentId, userId: session.user.id } },
        select: { role: true, teamId: true },
      }),
      // Captaincy hangs off the roster, not off a user: an organiser marks a
      // *player* as captain, and whoever has linked that BeatLeader profile
      // inherits the authority - including someone who only signs in later.
      prisma.teamMember.findMany({
        where: {
          player: { userId: session.user.id },
          team: { division: { tournamentId } },
        },
        select: { teamId: true, role: true },
      }),
    ]);

    const teamIds = new Set(
      rosterSpots.filter((spot) => spot.role === 'CAPTAIN').map((spot) => spot.teamId),
    );
    if (membership?.role === 'CAPTAIN' && membership.teamId) teamIds.add(membership.teamId);

    actor.captainOfTeamIds = [...teamIds];
    actor.tournamentRole =
      (membership?.role as TournamentRole | undefined) ??
      // Being on a roster is membership enough to see a private tournament.
      (teamIds.size > 0 ? 'CAPTAIN' : rosterSpots.length > 0 ? 'PLAYER' : null);
  }

  return actor;
}

/** The Actor a signed-out visitor gets: can view public things, nothing more. */
export const ANONYMOUS: Actor = {
  userId: '',
  globalRole: 'USER',
  tournamentRole: null,
};

export async function getActorOrAnonymous(tournamentId?: string): Promise<Actor> {
  return (await getActor(tournamentId)) ?? ANONYMOUS;
}

export async function currentUser() {
  const session = await auth();
  return session?.user ?? null;
}

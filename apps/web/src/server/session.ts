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
    const membership = await prisma.tournamentMember.findUnique({
      where: { tournamentId_userId: { tournamentId, userId: session.user.id } },
      select: { role: true, teamId: true },
    });
    actor.tournamentRole = (membership?.role as TournamentRole) ?? null;
    actor.captainOfTeamId = membership?.teamId ?? null;
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

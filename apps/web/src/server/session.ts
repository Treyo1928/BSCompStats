import { cache } from 'react';
import { cookies } from 'next/headers';
import { prisma } from '@bscs/db';
import { auth } from '@/lib/auth';
import type { Actor, GlobalRole, TournamentRole } from '@bscs/core/match';

/**
 * "View as": a site admin can see and use the site as another user, to
 * reproduce what that person reports or to test a captain's controls.
 *
 * The cookie only names who to view as. It carries no authority of its own -
 * it is honoured solely when the real, signed-in session belongs to an admin,
 * and that is re-checked on every request. Forging it gets a non-admin nothing.
 */
export const VIEW_AS_COOKIE = 'bscs-view-as';

export interface SiteUser {
  id: string;
  name: string | null;
  image: string | null;
  role: GlobalRole;
}

interface Identity {
  /** Who is actually signed in. */
  real: SiteUser;
  /** Who the site should treat them as - differs from `real` while viewing as. */
  effective: SiteUser;
}

const resolveIdentity = cache(async (): Promise<Identity | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;

  const real: SiteUser = {
    id: session.user.id,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    role: session.user.role ?? 'USER',
  };
  if (real.role !== 'ADMIN') return { real, effective: real };

  const targetId = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  if (!targetId || targetId === real.id) return { real, effective: real };

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, name: true, image: true, role: true },
  });
  return { real, effective: target ?? real };
});

/**
 * Resolve the signed-in user into the Actor the permission rules understand.
 *
 * The tournament role is looked up per request rather than cached in the
 * session, so promoting someone to organiser takes effect immediately instead
 * of after they next sign in.
 */
export async function getActor(tournamentId?: string): Promise<Actor | null> {
  const identity = await resolveIdentity();
  if (!identity) return null;
  const user = identity.effective;

  const actor: Actor = {
    userId: user.id,
    globalRole: user.role,
  };

  if (tournamentId) {
    const [membership, rosterSpots] = await Promise.all([
      prisma.tournamentMember.findUnique({
        where: { tournamentId_userId: { tournamentId, userId: user.id } },
        select: { role: true, teamId: true },
      }),
      // Captaincy hangs off the roster, not off a user: an organiser marks a
      // *player* as captain, and whoever has linked that BeatLeader profile
      // inherits the authority - including someone who only signs in later.
      prisma.teamMember.findMany({
        where: {
          player: { userId: user.id },
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

/** The user the site is being used as - the viewed-as user while viewing as. */
export async function currentUser(): Promise<SiteUser | null> {
  return (await resolveIdentity())?.effective ?? null;
}

/** Who is really signed in, regardless of view-as. Admin tooling keys off this. */
export async function realUser(): Promise<SiteUser | null> {
  return (await resolveIdentity())?.real ?? null;
}

/** Set while an admin is viewing the site as someone else. */
export async function viewingAs(): Promise<{ admin: SiteUser; target: SiteUser } | null> {
  const identity = await resolveIdentity();
  if (!identity || identity.real.id === identity.effective.id) return null;
  return { admin: identity.real, target: identity.effective };
}

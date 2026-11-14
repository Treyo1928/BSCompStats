import { prisma } from '@bscs/db';
import { apiRoute, json } from '@/server/api';

export const dynamic = 'force-dynamic';

/**
 * The tournaments this key works in, for an app that lets its user choose one. A key limited to some tournaments
 * lists those (the ones its user can see); a key that is not lists the ones its user owns or has a part in. (Any public tournament can still be
 * read by its address: this is the list worth offering, not the limit of what may be read.)
 */
export async function GET(request: Request) {
  return apiRoute(request, {}, async ({ holder }) => {
    // Only what the key's user can see: a key limited to a tournament they have no part in names nothing.
    const visible = holder.user.role === 'ADMIN' ? {} : { OR: [{ isPublic: true }, { ownerId: holder.user.id }, { members: { some: { userId: holder.user.id } } }] };
    const tournaments = await prisma.tournament.findMany({
      where: holder.key.tournamentIds.length
        ? { id: { in: holder.key.tournamentIds }, ...visible }
        : { OR: [{ ownerId: holder.user.id }, { members: { some: { userId: holder.user.id } } }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, slug: true, name: true, isPublic: true },
    });
    return json({ tournaments });
  });
}

import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { ApiError, apiRoute, json } from '@/server/api';
import { loadBracket } from '@/server/brackets';
import { getActorOrAnonymous } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * A bracket as the bracket page shows it, for an overlay's bracket scene: every slot with its round, teams,
 * state, winner and (once started) its match and maps won, plus standings for round robins.
 */
export async function GET(request: Request, { params }: { params: Promise<{ bracketId: string }> }) {
  const { bracketId } = await params;
  return apiRoute(request, {}, async ({ inTournament }) => {
    const b = await prisma.bracket.findUnique({
      where: { id: bracketId },
      select: { tournamentId: true, tournament: { select: { isPublic: true } } },
    });
    if (!b) throw new ApiError(404, 'Not found.');
    inTournament(b.tournamentId);
    const actor = await getActorOrAnonymous(b.tournamentId);
    if (!can(actor, 'VIEW', { isPublic: b.tournament.isPublic })) throw new ApiError(404, 'Not found.');
    const view = await loadBracket(bracketId);
    if (!view) throw new ApiError(404, 'Not found.');
    const { tournamentId: _t, ...bracket } = view;
    return json({ bracket });
  });
}

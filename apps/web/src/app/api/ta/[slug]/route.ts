import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { getActorOrAnonymous } from '@/server/session';
import { taStamp, taState } from '@/server/ta';

export const dynamic = 'force-dynamic';

/**
 * The TournamentAssistant link as the worker last saw it, for tournament staff:
 * the TA page and match pages poll this to stay current. `stamp` changes when
 * anything worth redrawing does. Never carries the sign-in token.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
  if (!tournament) return Response.json({ error: 'Not found.' }, { status: 404 });
  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'START_MAP')) return Response.json({ error: 'Not found.' }, { status: 404 });

  const state = await taState(tournament.id);
  return Response.json({ stamp: taStamp(state), state }, { headers: { 'cache-control': 'no-store' } });
}

import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { getActorOrAnonymous } from '@/server/session';
import { taCommand } from '@/server/ta';

export const dynamic = 'force-dynamic';

/**
 * Where TournamentAssistant's Discord sign-in sends the organiser back to,
 * with their TA token on the address (that is how TA hands it over). The
 * worker trades it for a lasting bot token of the site's own; the person's
 * token is not stored. Then on to the TA page, which no longer has it in view.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
  const back = `/t/${slug}/ta`;
  if (!tournament) redirect('/');
  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'MANAGE_TOURNAMENT')) redirect(`/t/${slug}`);

  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token) redirect(`${back}?error=${encodeURIComponent('TournamentAssistant sent no sign-in back. Try again.')}`);
  const reply = await taCommand(tournament.id, { type: 'adoptToken', token }, 40_000);
  redirect(reply.ok ? `${back}?saved=signedIn` : `${back}?error=${encodeURIComponent(reply.error)}`);
}

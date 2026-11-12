import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { getActorOrAnonymous } from '@/server/session';
import { taState } from '@/server/ta';
import { sniffImage } from '@/server/uploads';

export const dynamic = 'force-dynamic';

/**
 * The TA tournament's picture as TournamentAssistant holds it, for the TA page. Fetched by the site and passed on:
 * TA serves it without saying what kind of picture it is, and a self-hosted TA server's certificate is often one
 * a browser will not take.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
  if (!tournament || !can(await getActorOrAnonymous(tournament.id), 'MANAGE_TOURNAMENT')) return new Response('Not found', { status: 404 });
  const url = (await taState(tournament.id))?.tournament?.image;
  if (!url) return new Response('Not found', { status: 404 });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return new Response('Not found', { status: 404 });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime || mime === 'image/svg+xml') return new Response('Not a picture', { status: 415 });
    return new Response(Buffer.from(bytes), { headers: { 'content-type': mime, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' } });
  } catch {
    return new Response('TournamentAssistant did not answer', { status: 502 });
  }
}

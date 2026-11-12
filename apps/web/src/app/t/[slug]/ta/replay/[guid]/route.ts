import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { getActorOrAnonymous } from '@/server/session';
import { taCommand } from '@/server/ta';

export const dynamic = 'force-dynamic';

/**
 * Download one replay TournamentAssistant recorded (a .tarf file). The worker says where TA serves it; the site
 * fetches it with the tournament's TA sign-in and passes it on, so the sign-in never reaches the browser.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; guid: string }> }) {
  const { slug, guid } = await params;
  const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true, taLink: { select: { token: true } } } });
  if (!tournament || !can(await getActorOrAnonymous(tournament.id), 'MANAGE_TOURNAMENT')) return new Response('Not found', { status: 404 });
  if (!/^[0-9a-f-]{36}$/i.test(guid)) return new Response('Not found', { status: 404 });
  const reply = await taCommand(tournament.id, { type: 'replayFile', guid });
  if (!reply.ok) return new Response(reply.error, { status: 404 });
  const file = reply.data as { url: string; fileName: string };
  try {
    const res = await fetch(file.url, { headers: { Authorization: `Bearer ${tournament.taLink?.token ?? ''}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok || !res.body) return new Response(`TournamentAssistant would not hand the replay over (${res.status}).`, { status: 502 });
    const name = file.fileName.replace(/[^\w.\- ]+/g, '_') || `${guid}.tarf`;
    return new Response(res.body, {
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'private, no-store' },
    });
  } catch {
    return new Response('TournamentAssistant did not answer.', { status: 502 });
  }
}

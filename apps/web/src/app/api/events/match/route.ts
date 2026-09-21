import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { onMatchChange } from '@/lib/redis';
import { getActorOrAnonymous } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-sent events for one match: a `change` whenever someone picks, bans,
 * undoes, saves a lineup or enters a score.
 *
 * The event carries no match data. It only says "what you are showing is out
 * of date", and the page re-renders through its ordinary, permission-checked
 * path - so nothing can leak through here that the page itself would hide.
 */
export async function GET(request: Request) {
  const matchId = new URL(request.url).searchParams.get('match');
  if (!matchId) return new Response('Missing match.', { status: 400 });

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { tournamentId: true, tournament: { select: { isPublic: true } } },
  });
  if (!match) return new Response('Not found.', { status: 404 });

  const actor = await getActorOrAnonymous(match.tournamentId);
  if (!can(actor, 'VIEW', { isPublic: match.tournament.isPublic })) {
    return new Response('Not found.', { status: 404 });
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Client went away mid-write.
        }
      };

      write(`event: ready\ndata: {}\n\n`);
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), 20_000);
      const unsubscribe = onMatchChange((change) => {
        if (change.matchId === matchId) write(`event: change\ndata: ${JSON.stringify({ at: change.at })}\n\n`);
      });

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      request.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

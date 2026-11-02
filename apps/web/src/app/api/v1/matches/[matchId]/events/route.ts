import { apiRoute } from '@/server/api';
import { matchForApi, tournamentOfMatch } from '@/server/api-match';
import { getActorOrAnonymous, withApiUser } from '@/server/session';
import { onMatchChange } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-sent events for one match, for overlays: `match` with the full match
 * (as GET /api/v1/matches/:id returns it) on connect and after every change.
 * Send the key in a header, so this is for servers (an overlay's backend), not
 * a browser EventSource, which cannot send headers - and must not hold a key.
 */
export async function GET(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return apiRoute(request, {}, async ({ holder, inTournament }) => {
    const t = await tournamentOfMatch(matchId);
    inTournament(t.id);
    const actor = await getActorOrAnonymous(t.id);
    // Fail now, as a normal error, if this key may not see the match at all.
    const first = await matchForApi(matchId, actor);

    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            /* client went away */
          }
        };
        const sendMatch = async () => {
          try {
            // Each re-read runs as the key's user again: the stream outlives the request scope.
            const match = await withApiUser(holder.user, async () => matchForApi(matchId, await getActorOrAnonymous(t.id)));
            write(`event: match\ndata: ${JSON.stringify(match)}\n\n`);
          } catch {
            write(`event: gone\ndata: {}\n\n`);
          }
        };
        write(`event: match\ndata: ${JSON.stringify(first)}\n\n`);
        const heartbeat = setInterval(() => write(': keep-alive\n\n'), 20_000);
        // Changes come in bursts (a pull writes several runs); one re-read per burst.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = onMatchChange((change) => {
          if (change.matchId !== matchId || timer) return;
          timer = setTimeout(() => {
            timer = null;
            void sendMatch();
          }, 150);
        });
        cleanup = () => {
          clearInterval(heartbeat);
          if (timer) clearTimeout(timer);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        request.signal.addEventListener('abort', () => cleanup());
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' },
    });
  });
}

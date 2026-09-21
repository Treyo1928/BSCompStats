import { createSubscriber, CHANNELS } from '@/lib/redis';

export const dynamic = 'force-dynamic';
// Node runtime: the edge runtime has no TCP sockets, so no Redis.
export const runtime = 'nodejs';

/**
 * Server-sent events carrying live score updates.
 *
 * SSE rather than WebSockets because the traffic is strictly one-way, it
 * survives proxies and reconnects on its own, and there is no handshake to get
 * wrong. A leaderboard filter can be passed so a pool board only wakes for maps
 * it is actually showing.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const filter = url.searchParams.get('leaderboards');
  const wanted = filter ? new Set(filter.split(',').filter(Boolean)) : null;

  const subscriber = createSubscriber();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Client went away mid-write.
        }
      };

      send('ready', { at: Date.now() });

      // Proxies and browsers both drop an idle stream; a comment line every
      // twenty seconds is enough to keep it alive and costs nothing.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, 20_000);

      await subscriber.subscribe(CHANNELS.scoreUpdate, CHANNELS.importProgress);

      subscriber.on('message', (channel, raw) => {
        try {
          const payload = JSON.parse(raw) as { leaderboardId?: string };
          if (
            channel === CHANNELS.scoreUpdate &&
            wanted &&
            payload.leaderboardId &&
            !wanted.has(payload.leaderboardId)
          ) {
            return;
          }
          send(channel === CHANNELS.scoreUpdate ? 'score' : 'import', payload);
        } catch {
          // Malformed payload - nothing useful to forward.
        }
      });

      const close = () => {
        clearInterval(heartbeat);
        void subscriber.quit();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      request.signal.addEventListener('abort', close);
    },
    cancel() {
      void subscriber.quit();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx not to buffer, which would batch live updates into bursts.
      'x-accel-buffering': 'no',
    },
  });
}

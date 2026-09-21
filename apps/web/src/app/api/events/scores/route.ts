import { prisma } from '@bscs/db';
import { can } from '@bscs/core/match';
import { onScoreUpdate } from '@/lib/redis';
import { getActorOrAnonymous } from '@/server/session';

export const dynamic = 'force-dynamic';
// Node runtime: the edge runtime has no TCP sockets, so no Redis.
export const runtime = 'nodejs';

/** How long a stream trusts its idea of who is rostered before re-reading it. */
const SCOPE_TTL_MS = 30_000;

/**
 * Server-sent events carrying live score updates for one map pool.
 *
 * SSE rather than WebSockets because the traffic is strictly one-way, it
 * survives proxies and reconnects on its own, and there is no handshake to get
 * wrong.
 *
 * The worker publishes every tracked score on one channel, private tournaments
 * included, so this route is the gate: a stream is tied to a pool the caller is
 * allowed to view, and carries only that pool's maps played by that
 * tournament's rostered players. What to send is decided here, never by the
 * query string.
 */
export async function GET(request: Request) {
  const poolId = new URL(request.url).searchParams.get('pool');
  if (!poolId) return new Response('Missing pool.', { status: 400 });

  const pool = await prisma.mapPool.findUnique({
    where: { id: poolId },
    select: { tournamentId: true, tournament: { select: { isPublic: true } } },
  });
  // Same answer for "no such pool" and "not yours to see".
  if (!pool) return new Response('Not found.', { status: 404 });

  const actor = await getActorOrAnonymous(pool.tournamentId);
  if (!can(actor, 'VIEW', { isPublic: pool.tournament.isPublic })) {
    return new Response('Not found.', { status: 404 });
  }

  let scope = await loadScope(poolId, pool.tournamentId);
  let scopeLoadedAt = Date.now();
  let refreshing = false;

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
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

      const unsubscribe = onScoreUpdate((update) => {
        // Rosters and pools change while a stream is open. Re-read lazily, off
        // the back of traffic, rather than on a timer per connection.
        if (!refreshing && Date.now() - scopeLoadedAt > SCOPE_TTL_MS) {
          refreshing = true;
          void loadScope(poolId, pool.tournamentId)
            .then((fresh) => {
              scope = fresh;
              scopeLoadedAt = Date.now();
            })
            .catch(() => {})
            .finally(() => {
              refreshing = false;
            });
        }

        if (!scope.leaderboardIds.has(update.leaderboardId)) return;
        if (!scope.playerIds.has(update.playerId)) return;
        send('score', update);
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
      // Tells nginx not to buffer, which would batch live updates into bursts.
      'x-accel-buffering': 'no',
    },
  });
}

async function loadScope(poolId: string, tournamentId: string) {
  const [maps, members] = await Promise.all([
    prisma.poolMap.findMany({ where: { poolId }, select: { leaderboardId: true } }),
    prisma.teamMember.findMany({
      where: { team: { division: { tournamentId } } },
      select: { playerId: true },
    }),
  ]);
  return {
    leaderboardIds: new Set(maps.map((m) => m.leaderboardId)),
    playerIds: new Set(members.map((m) => m.playerId)),
  };
}

import { Redis } from 'ioredis';
import { env } from './env';

/**
 * Redis is used for one thing: carrying score updates from the ingestion
 * worker to every open browser. The worker publishes, the SSE route
 * subscribes.
 */
export const CHANNELS = {
  scoreUpdate: 'bscs:score',
  refreshRequest: 'bscs:refresh',
  importProgress: 'bscs:import',
  matchChange: 'bscs:match',
} as const;

export interface ScoreUpdate {
  playerId: string;
  playerName: string;
  leaderboardId: string;
  baseScore: number;
  accuracy: number;
  improved: boolean;
  source: 'socket' | 'poll';
  at: number;
}

const globalForRedis = globalThis as unknown as { redisPublisher?: Redis };

export function getPublisher(): Redis {
  if (!globalForRedis.redisPublisher) {
    globalForRedis.redisPublisher = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    globalForRedis.redisPublisher.on('error', () => {
      // Logged by ioredis; a dead Redis degrades live updates but must not
      // take the site down, so this is swallowed deliberately.
    });
  }
  return globalForRedis.redisPublisher;
}

/** Something about a match changed: a pick, a ban, a lineup, a score. */
export interface MatchChange {
  matchId: string;
  at: number;
}

type Listener = (payload: unknown) => void;

const globalForFanout = globalThis as unknown as {
  fanoutSubscriber?: Redis;
  fanoutListeners?: Map<string, Set<Listener>>;
};

/**
 * One Redis subscription for the whole process, fanned out in memory.
 *
 * A subscribed client cannot publish, so this is separate from the publisher -
 * but it is shared between viewers. A client per SSE connection would let
 * anyone who can open a stream exhaust Redis's connection limit.
 */
function listen(channel: string, listener: Listener): () => void {
  const byChannel = (globalForFanout.fanoutListeners ??= new Map());

  if (!globalForFanout.fanoutSubscriber) {
    const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    client.on('error', () => {});
    client.on('message', (from, raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return; // Malformed payload - nothing useful to forward.
      }
      for (const each of byChannel.get(from) ?? []) each(payload);
    });
    // ioredis resubscribes by itself after a reconnect.
    void client.subscribe(CHANNELS.scoreUpdate, CHANNELS.matchChange).catch(() => {});
    globalForFanout.fanoutSubscriber = client;
  }

  let listeners = byChannel.get(channel);
  if (!listeners) byChannel.set(channel, (listeners = new Set()));
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const onScoreUpdate = (listener: (update: ScoreUpdate) => void) =>
  listen(CHANNELS.scoreUpdate, listener as Listener);

export const onMatchChange = (listener: (change: MatchChange) => void) =>
  listen(CHANNELS.matchChange, listener as Listener);

/** Tell every open copy of a match page that it is out of date. */
export async function announceMatchChange(matchId: string): Promise<void> {
  try {
    const change: MatchChange = { matchId, at: Date.now() };
    await getPublisher().publish(CHANNELS.matchChange, JSON.stringify(change));
  } catch {
    // Live updates degrade to "refresh the page"; the action itself succeeded.
  }
}

export async function requestRefresh(poolId?: string, requestedBy?: string): Promise<void> {
  try {
    await getPublisher().publish(
      CHANNELS.refreshRequest,
      JSON.stringify({ poolId, requestedBy }),
    );
  } catch {
    // The scheduled poll will pick it up regardless.
  }
}

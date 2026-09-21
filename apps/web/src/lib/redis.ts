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

type ScoreListener = (update: ScoreUpdate) => void;

const globalForFanout = globalThis as unknown as {
  scoreSubscriber?: Redis;
  scoreListeners?: Set<ScoreListener>;
};

/**
 * One Redis subscription for the whole process, fanned out in memory.
 *
 * A subscribed client cannot publish, so this is separate from the publisher -
 * but it is shared between viewers. A client per SSE connection would let
 * anyone who can open a stream exhaust Redis's connection limit.
 */
export function onScoreUpdate(listener: ScoreListener): () => void {
  const listeners = (globalForFanout.scoreListeners ??= new Set());

  if (!globalForFanout.scoreSubscriber) {
    const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    client.on('error', () => {});
    client.on('message', (_channel, raw) => {
      let update: ScoreUpdate;
      try {
        update = JSON.parse(raw) as ScoreUpdate;
      } catch {
        return; // Malformed payload - nothing useful to forward.
      }
      for (const each of listeners) each(update);
    });
    // ioredis resubscribes by itself after a reconnect.
    void client.subscribe(CHANNELS.scoreUpdate).catch(() => {});
    globalForFanout.scoreSubscriber = client;
  }

  listeners.add(listener);
  return () => listeners.delete(listener);
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

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

/** Each SSE connection needs its own client - a subscribed one cannot publish. */
export function createSubscriber(): Redis {
  const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  client.on('error', () => {});
  return client;
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

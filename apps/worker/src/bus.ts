import { Redis } from 'ioredis';
import { config } from './config.js';
import { log } from './log.js';

/**
 * Redis pub/sub between the worker and the web app.
 *
 * Deliberately not a job queue. The work here is a periodic poll plus a live
 * socket, neither of which needs durable queueing, retries or scheduling - and
 * a self-hosted app is easier to run and to reason about with one less moving
 * part. Redis earns its place as the fan-out channel: the worker sees a score,
 * publishes it, and every open browser hears about it through SSE.
 */

export const CHANNELS = {
  /** A score was written. Payload: ScoreUpdate. */
  scoreUpdate: 'bscs:score',
  /** The web app asking for an immediate refresh. Payload: RefreshRequest. */
  refreshRequest: 'bscs:refresh',
  /** Progress on a long-running import. */
  importProgress: 'bscs:import',
} as const;

export interface ScoreUpdate {
  playerId: string;
  playerName: string;
  leaderboardId: string;
  baseScore: number;
  accuracy: number;
  /** True when this beat the player's previous score on the map. */
  improved: boolean;
  source: 'socket' | 'poll';
  at: number;
}

export interface RefreshRequest {
  /** Restrict to one pool, or omit for everything tracked. */
  poolId?: string;
  playerIds?: string[];
  requestedBy?: string;
  /** Pull these players' recorded runs from BeatLeader now, rather than their scores. */
  attempts?: boolean;
}

let publisher: Redis | null = null;

export function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    publisher.on('error', (err) => log.warn('redis publisher error', err));
  }
  return publisher;
}

export function createSubscriber(): Redis {
  const client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  client.on('error', (err) => log.warn('redis subscriber error', err));
  return client;
}

export async function publish(channel: string, payload: unknown): Promise<void> {
  try {
    await getPublisher().publish(channel, JSON.stringify(payload));
  } catch (err) {
    // A failed fan-out must never take down ingestion - the score is already
    // in the database, and the next page load will show it.
    log.warn('failed to publish', err);
  }
}

export async function closeBus(): Promise<void> {
  await publisher?.quit();
  publisher = null;
}

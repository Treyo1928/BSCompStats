import { prisma } from '@bscs/db';
import { config } from './config.js';
import { log } from './log.js';
import { CHANNELS, closeBus, createSubscriber, type RefreshRequest } from './bus.js';
import { syncAll } from './sync.js';
import { ScoreSocket } from './socket.js';
import { syncHistories } from './history.js';
import { syncProfiles } from './profiles.js';

/**
 * The ingestion worker.
 *
 * Three jobs, in order of how often they do something useful:
 *   1. the live BeatLeader score feed, which reacts within a second
 *   2. an on-demand refresh, when somebody presses the button in the app
 *   3. a periodic poll, which is the safety net behind both
 */

const socket = new ScoreSocket();
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

async function poll(poolId?: string, reason = 'scheduled'): Promise<void> {
  // Overlapping polls would multiply outbound API calls for no benefit.
  if (polling) {
    log.info('skipping poll - one is already running');
    return;
  }
  polling = true;
  const started = Date.now();

  try {
    const { checked, written } = await syncAll(poolId);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (checked) {
      log.info(`${reason} poll: checked ${checked} pairs, wrote ${written} in ${seconds}s`);
    }

    const profiles = await syncProfiles();
    if (profiles) log.info(`profiles: refreshed ${profiles} players`);

    // After the pool, so match-night scores are never waiting behind a backfill.
    const history = await syncHistories();
    if (history.written) {
      log.info(`history: ${history.written} new scores across ${history.players} players`);
    }
  } catch (err) {
    log.error('poll failed', err);
  } finally {
    polling = false;
  }
}

async function main(): Promise<void> {
  log.info('BSCompStats worker starting');

  // Fail fast and loudly if the database is not reachable - a worker that
  // silently does nothing is the hardest kind of problem to notice.
  await prisma.$queryRaw`SELECT 1`;
  log.info('database reachable');

  const subscriber = createSubscriber();
  await subscriber.subscribe(CHANNELS.refreshRequest);
  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== CHANNELS.refreshRequest) return;
    try {
      const request = JSON.parse(raw) as RefreshRequest;
      log.info(`refresh requested${request.poolId ? ` for pool ${request.poolId}` : ''}`);
      void poll(request.poolId, 'requested');
    } catch {
      void poll(undefined, 'requested');
    }
  });
  log.info('listening for refresh requests');

  if (config.ENABLE_LIVE_SOCKET) {
    await socket.start();
  } else {
    log.info('live socket disabled - polling only');
  }

  // One poll at boot so a fresh instance is populated without waiting.
  void poll(undefined, 'startup');
  pollTimer = setInterval(
    () => void poll(),
    config.SCORE_POLL_INTERVAL_SECONDS * 1000,
  );
  log.info(`polling every ${config.SCORE_POLL_INTERVAL_SECONDS}s`);

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received, shutting down`);
    if (pollTimer) clearInterval(pollTimer);
    await socket.stop();
    await subscriber.quit();
    await closeBus();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('worker failed to start', err);
  process.exit(1);
});

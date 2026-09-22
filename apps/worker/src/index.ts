import { prisma } from '@bscs/db';
import { config } from './config.js';
import { log } from './log.js';
import { CHANNELS, closeBus, createSubscriber, type RefreshRequest } from './bus.js';
import { syncAll } from './sync.js';
import { ScoreSocket } from './socket.js';
import { syncHistories } from './history.js';
import { syncProfiles } from './profiles.js';
import { syncScoreSaber } from './scoresaber.js';
import { syncAttempts } from './attempts.js';

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

/**
 * The pool sync in flight, and the one request waiting behind it. A refresh
 * pressed while a sync runs used to be dropped with "skipping poll"; now it
 * runs next. Two requests waiting collapse into one wide enough for both.
 */
let pooling: Promise<void> | null = null;
let queued: { poolId?: string; reason: string } | null = null;

async function pollPool(poolId?: string, reason = 'scheduled'): Promise<void> {
  if (pooling) {
    const covers = queued && (queued.poolId === undefined || queued.poolId === poolId);
    if (!covers) queued = { poolId: queued ? undefined : poolId, reason };
    log.info(`${reason} poll queued behind the one running`);
    return pooling;
  }

  pooling = (async () => {
    const started = Date.now();
    try {
      const { checked, written } = await syncAll(poolId);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (checked) {
        log.info(`${reason} poll: checked ${checked} pairs, wrote ${written} in ${seconds}s`);
      }
    } catch (err) {
      log.error('poll failed', err);
    } finally {
      pooling = null;
    }
  })();
  await pooling;

  if (queued) {
    const next = queued;
    queued = null;
    await pollPool(next.poolId, next.reason);
  }
}

/**
 * The slow syncs: profiles, ScoreSaber and history walks. Run after a
 * scheduled poll, never a requested one, and never two at once - a first
 * boot with history on can hold this for many minutes, and a refresh from
 * the app must not wait behind it.
 */
let backgroundRunning = false;

async function pollBackground(): Promise<void> {
  if (backgroundRunning) return;
  backgroundRunning = true;
  try {
    const profiles = await syncProfiles();
    if (profiles) log.info(`profiles: refreshed ${profiles} players`);

    const scoreSaber = await syncScoreSaber();
    if (scoreSaber.linked || scoreSaber.written) {
      log.info(
        `scoresaber: ${scoreSaber.linked} newly linked, ${scoreSaber.written} new scores across ${scoreSaber.synced} players`,
      );
    }

    const attempts = await syncAttempts();
    if (attempts.written || attempts.hidden) {
      log.info(
        `attempts: ${attempts.written} new runs across ${attempts.players} players, ${attempts.hidden} keep theirs private`,
      );
    }

    const history = await syncHistories();
    if (history.written) {
      log.info(`history: ${history.written} new scores across ${history.players} players`);
    }
  } catch (err) {
    log.error('background sync failed', err);
  } finally {
    backgroundRunning = false;
  }
}

async function poll(reason: string): Promise<void> {
  await pollPool(undefined, reason);
  await pollBackground();
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
      if (request.attempts && request.playerIds?.length) {
        log.info(`attempts requested for ${request.playerIds.length} player(s)`);
        void syncAttempts({ playerIds: request.playerIds, force: true })
          .then((r) => log.info(`attempts: ${r.written} new runs, ${r.hidden} private`))
          .catch((err) => log.error('requested attempts sync failed', err));
        return;
      }
      log.info(`refresh requested${request.poolId ? ` for pool ${request.poolId}` : ''}`);
      void pollPool(request.poolId, 'requested');
    } catch {
      void pollPool(undefined, 'requested');
    }
  });
  log.info('listening for refresh requests');

  if (config.ENABLE_LIVE_SOCKET) {
    await socket.start();
  } else {
    log.info('live socket disabled - polling only');
  }

  // One poll at boot so a fresh instance is populated without waiting.
  void poll('startup');
  pollTimer = setInterval(
    () => void poll('scheduled'),
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

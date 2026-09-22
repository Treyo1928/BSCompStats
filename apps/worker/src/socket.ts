import { prisma } from '@bscs/db';
import type { BLScore } from '@bscs/core/beatleader';
import { config } from './config.js';
import { log } from './log.js';
import { CHANNELS, publish, type ScoreUpdate } from './bus.js';
import { loadTrackedPairs, upsertScore } from './sync.js';

/**
 * The live score feed.
 *
 * BeatLeader broadcasts every score set anywhere, in real time. That is a much
 * better answer to "tell me when a tracked player finishes a pool map" than a
 * webhook would be: there is nothing to register, nothing to expose to the
 * internet, and it covers every player at once. We hold one connection, ignore
 * the overwhelming majority of traffic, and write the handful of scores that
 * belong to somebody we are watching.
 *
 * The poller stays in place behind it. Sockets drop, and a refresh that only
 * works when a long-lived connection has been healthy is not a refresh.
 */

/** How long the global feed may go quiet before the connection is presumed dead. */
const IDLE_MS = 120_000;
const IDLE_CHECK_MS = 30_000;

export class ScoreSocket {
  private socket: WebSocket | null = null;
  private tracked = new Map<string, { playerId: string; playerName: string }>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private stopped = false;

  /** Scores seen, matched, and written - reported on the health endpoint. */
  readonly stats = { seen: 0, matched: 0, written: 0, connectedAt: 0 };

  async start(): Promise<void> {
    await this.refreshTracked();
    // The tracked set changes when a pool is imported or a roster edited.
    this.refreshTimer = setInterval(() => {
      void this.refreshTracked();
    }, 60_000);
    // A half-open connection - NAT timeout, upstream restart without a FIN -
    // never fires onclose. The feed carries every score set anywhere, so a
    // long silence means the connection is dead, not that nobody is playing.
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.socket?.close();
    this.socket = null;
  }

  private checkIdle(): void {
    const socket = this.socket;
    if (!socket || !this.stats.connectedAt || this.stopped) return;
    const silentFor = Date.now() - this.lastMessageAt;
    if (silentFor < IDLE_MS) return;

    log.warn(`live score feed silent for ${Math.round(silentFor / 1000)}s, reconnecting`);
    // Its close may never arrive, so do not wait for it to drive the reconnect.
    socket.onclose = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      // Already gone; that is the point.
    }
    this.socket = null;
    this.stats.connectedAt = 0;
    this.scheduleReconnect();
  }

  /** Rebuild the (playerId, leaderboardId) set we care about. */
  async refreshTracked(): Promise<void> {
    try {
      const pairs = await loadTrackedPairs();
      const next = new Map<string, { playerId: string; playerName: string }>();
      for (const pair of pairs) {
        next.set(`${pair.beatLeaderId}::${pair.leaderboardId}`, {
          playerId: pair.playerId,
          playerName: pair.playerName,
        });
      }
      const changed = next.size !== this.tracked.size;
      this.tracked = next;
      if (changed) log.info(`watching ${next.size} player/map pairs`);
    } catch (err) {
      log.warn('could not refresh the tracked set', err);
    }
  }

  private connect(): void {
    if (this.stopped) return;

    log.info(`connecting to the live score feed`);
    let socket: WebSocket;
    try {
      socket = new WebSocket(config.BEATLEADER_WS_URL);
    } catch (err) {
      log.warn('could not open the score feed', err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.stats.connectedAt = Date.now();
      this.lastMessageAt = Date.now();
      log.info('live score feed connected');
    };

    socket.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      void this.handleMessage(event.data);
    };

    socket.onerror = () => {
      // The close handler does the reconnecting; an error without a close is
      // not actionable on its own.
    };

    socket.onclose = (event) => {
      this.stats.connectedAt = 0;
      if (this.stopped) return;
      log.warn(`live score feed closed (${event.code}), reconnecting`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // Exponential backoff with jitter, capped at a minute. BeatLeader is a
    // volunteer-run service and does not need us hammering it after an outage.
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 60_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay + Math.random() * 1000);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'string') return;
    this.stats.seen++;

    let score: BLScore & { leaderboardId?: string };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Some deployments wrap the payload; accept both shapes.
      score = (parsed.message ?? parsed) as BLScore & { leaderboardId?: string };
    } catch {
      return;
    }

    const leaderboardId = score.leaderboardId ?? score.leaderboard?.id;
    const beatLeaderId = score.playerId;
    if (!leaderboardId || !beatLeaderId) return;

    const match = this.tracked.get(`${beatLeaderId}::${leaderboardId}`);
    if (!match) return;

    this.stats.matched++;

    try {
      const { written, improved } = await upsertScore(
        match.playerId,
        leaderboardId,
        score,
      );
      if (!written) return;
      this.stats.written++;

      log.info(
        `live score: ${match.playerName} on ${leaderboardId} - ` +
          `${score.baseScore} (${((score.accuracy ?? 0) * 100).toFixed(2)}%)`,
      );

      const update: ScoreUpdate = {
        playerId: match.playerId,
        playerName: match.playerName,
        leaderboardId,
        baseScore: score.baseScore,
        accuracy: score.accuracy ?? 0,
        improved,
        source: 'socket',
        at: Date.now(),
      };
      await publish(CHANNELS.scoreUpdate, update);
      await notifyDiscord(update);
    } catch (err) {
      log.warn('failed to store a live score', err);
    }
  }
}

/** Optional outbound notification when a tracked player improves. */
async function notifyDiscord(update: ScoreUpdate): Promise<void> {
  if (!config.DISCORD_WEBHOOK_URL || !update.improved) return;

  const leaderboard = await prisma.leaderboard.findUnique({
    where: { id: update.leaderboardId },
    select: { difficultyName: true, map: { select: { name: true } } },
  });

  const mapLabel = leaderboard
    ? `${leaderboard.map.name} [${leaderboard.difficultyName}]`
    : update.leaderboardId;

  try {
    await fetch(config.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content:
          `**${update.playerName}** improved on *${mapLabel}* - ` +
          `${update.baseScore.toLocaleString()} (${(update.accuracy * 100).toFixed(2)}%)`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.warn('discord webhook failed', err);
  }
}

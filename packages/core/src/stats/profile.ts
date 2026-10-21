import { mean, median, stdev } from './normalize.js';

/**
 * Descriptive player statistics: what a player's recorded scores add up to,
 * and nothing more. No skill estimate, no prediction - every figure here is
 * arithmetic on scores they actually set.
 *
 * Every score counts, however low: there is no "abandoned run" set aside.
 * The user's rule - a bad run is still a run.
 */

export interface ScoreDetail {
  playerId: string;
  leaderboardId: string;
  acc: number;
  missedNotes?: number;
  badCuts?: number;
  fullCombo?: boolean;
  pauses?: number;
  accLeft?: number;
  accRight?: number;
  timeset?: number;
}

export interface PlayerProfile {
  playerId: string;
  scoreCount: number;

  meanAcc: number;
  medianAcc: number;
  accStdev: number;
  bestAcc: number;
  worstAcc: number;

  fcRate: number;
  missRate: number;
  pauseRate: number;
  /** Mean (accLeft - accRight); positive means the left hand is stronger. */
  handBalance: number;

  lastPlayedAt: number | null;
}

export function buildPlayerProfiles(scores: readonly ScoreDetail[]): Record<string, PlayerProfile> {
  const byPlayer = new Map<string, ScoreDetail[]>();
  for (const s of scores) {
    const list = byPlayer.get(s.playerId) ?? [];
    list.push(s);
    byPlayer.set(s.playerId, list);
  }

  const out: Record<string, PlayerProfile> = {};
  for (const [playerId, mine] of byPlayer) {
    const accs = mine.map((s) => s.acc);
    const handDiffs = mine
      .filter((s) => s.accLeft != null && s.accRight != null)
      .map((s) => s.accLeft! - s.accRight!);

    out[playerId] = {
      playerId,
      scoreCount: mine.length,

      meanAcc: mean(accs),
      medianAcc: median(accs),
      accStdev: stdev(accs),
      bestAcc: accs.length ? Math.max(...accs) : 0,
      worstAcc: accs.length ? Math.min(...accs) : 0,

      fcRate: rate(mine, (s) => s.fullCombo === true),
      missRate: rate(mine, (s) => (s.missedNotes ?? 0) + (s.badCuts ?? 0) > 0),
      pauseRate: rate(mine, (s) => (s.pauses ?? 0) > 0),
      handBalance: handDiffs.length ? mean(handDiffs) : 0,

      lastPlayedAt: mine.reduce<number | null>(
        (latest, s) => (s.timeset && (!latest || s.timeset > latest) ? s.timeset : latest),
        null,
      ),
    };
  }
  return out;
}

const rate = <T>(items: readonly T[], predicate: (item: T) => boolean): number =>
  items.length ? items.filter(predicate).length / items.length : 0;

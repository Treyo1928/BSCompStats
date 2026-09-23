import { mean, median, stdev } from './normalize.js';

/**
 * Descriptive player statistics: what a player's recorded scores add up to,
 * and nothing more. No skill estimate, no prediction - every figure here is
 * arithmetic on scores they actually set.
 *
 * An abandoned run (an anomaly as classified in normalize.ts: Alex's 20.36% on
 * a map where everyone else is above 96%) is counted as one, and kept out of
 * the averages. A low score on a map that is beyond the player is not an
 * abandoned run: Kadence's 50.45% on Spin Eternally is her score there and
 * counts like any other.
 */

export interface ScoreDetail {
  playerId: string;
  leaderboardId: string;
  acc: number;
  isDnf: boolean;
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
  /** Scores that are not abandoned runs - what the averages are over. */
  cleanCount: number;

  meanAcc: number;
  medianAcc: number;
  accStdev: number;
  bestAcc: number;
  worstCleanAcc: number;

  fcRate: number;
  missRate: number;
  pauseRate: number;
  /** Mean (accLeft - accRight); positive means the left hand is stronger. */
  handBalance: number;

  /** Abandoned runs, left out of everything above. */
  failCount: number;

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
    const clean = mine.filter((s) => !s.isDnf);
    const accs = clean.map((s) => s.acc);
    const handDiffs = clean
      .filter((s) => s.accLeft != null && s.accRight != null)
      .map((s) => s.accLeft! - s.accRight!);

    out[playerId] = {
      playerId,
      scoreCount: mine.length,
      cleanCount: clean.length,

      meanAcc: mean(accs),
      medianAcc: median(accs),
      accStdev: stdev(accs),
      bestAcc: accs.length ? Math.max(...accs) : 0,
      worstCleanAcc: accs.length ? Math.min(...accs) : 0,

      fcRate: rate(clean, (s) => s.fullCombo === true),
      missRate: rate(clean, (s) => (s.missedNotes ?? 0) + (s.badCuts ?? 0) > 0),
      pauseRate: rate(clean, (s) => (s.pauses ?? 0) > 0),
      handBalance: handDiffs.length ? mean(handDiffs) : 0,

      failCount: mine.length - clean.length,
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

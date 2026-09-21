'use client';

import { useEffect, useRef, useState } from 'react';

export interface LiveScore {
  playerId: string;
  playerName: string;
  leaderboardId: string;
  baseScore: number;
  accuracy: number;
  improved: boolean;
  source: 'socket' | 'poll';
  at: number;
}

export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to live score updates over server-sent events.
 *
 * The worker holds one connection to BeatLeader's global score feed and
 * republishes the scores we care about, so a player finishing a pool map shows
 * up here within a second without anyone pressing refresh.
 *
 * EventSource reconnects on its own, so there is no retry logic here - only a
 * status so the page can say whether it is actually live rather than quietly
 * showing stale numbers.
 */
export function useLiveScores(leaderboardIds: readonly string[]) {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [updates, setUpdates] = useState<LiveScore[]>([]);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const key = leaderboardIds.join(',');
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const url = key
      ? `/api/events/scores?leaderboards=${encodeURIComponent(key)}`
      : '/api/events/scores';
    const source = new EventSource(url);

    source.addEventListener('ready', () => setStatus('live'));
    source.addEventListener('score', (event) => {
      try {
        const score = JSON.parse((event as MessageEvent).data) as LiveScore;
        const id = `${score.playerId}:${score.leaderboardId}:${score.baseScore}`;
        if (seen.current.has(id)) return;
        seen.current.add(id);

        setUpdates((prev) => [score, ...prev].slice(0, 50));
        setLastAt(Date.now());
      } catch {
        // Ignore anything unparseable rather than breaking the stream.
      }
    });
    source.onerror = () => setStatus('offline');
    source.onopen = () => setStatus('live');

    return () => source.close();
  }, [key]);

  return { status, updates, lastAt };
}

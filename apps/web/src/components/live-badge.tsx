'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useLiveScores, type LiveStatus } from './use-live-scores';

const LABELS: Record<LiveStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  offline: 'Reconnecting',
};

const EXPLANATIONS: Record<LiveStatus, string> = {
  connecting: 'Connecting to the live score feed.',
  live: 'Connected to the live score feed. This page updates by itself when a rostered player sets a score on one of these maps.',
  offline: 'Lost the live score feed - retrying. Numbers may be stale until it reconnects.',
};

/**
 * Shows connection state and refreshes the page data when a tracked score
 * lands. Server components own the numbers, so a router refresh is the whole
 * update path - no duplicated formatting or ranking logic on the client.
 */
export function LiveBadge({
  poolId,
  onUpdate,
}: {
  poolId: string;
  onUpdate?: () => void;
}) {
  const router = useRouter();
  const { status, updates, lastAt } = useLiveScores(poolId);
  const lastHandled = useRef<number | null>(null);

  useEffect(() => {
    if (!lastAt || lastHandled.current === lastAt) return;
    lastHandled.current = lastAt;
    router.refresh();
    onUpdate?.();
  }, [lastAt, router, onUpdate]);

  const latest = updates[0];
  const tone =
    status === 'live'
      ? 'bg-green-500/15 text-green-300'
      : status === 'offline'
        ? 'bg-amber-500/15 text-amber-300'
        : 'bg-[var(--color-edge)] text-[var(--color-muted)]';

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={`inline-flex items-center gap-1.5 rounded px-2 py-1 ${tone}`}
        title={EXPLANATIONS[status]}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status === 'live' ? 'animate-pulse bg-green-400' : 'bg-current'}`}
        />
        {LABELS[status]}
      </span>
      {latest && (
        // Unlabelled, a bare player name next to "Live" reads as "this person
        // is live", which is not what it means.
        <span
          className="text-[var(--color-muted)]"
          title="The most recent score to arrive on one of these maps while this page has been open."
        >
          Latest score: {latest.playerName} · {(latest.accuracy * 100).toFixed(2)}%
        </span>
      )}
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { BusyOverlay } from './busy-overlay';

/**
 * Keeps a match page current: when anyone picks, bans, saves a lineup or
 * enters a score, every open copy of the page re-renders.
 *
 * Renders nothing unless a refresh is slow. The stream only says that something changed; the data still
 * comes from the server, through the same checks as a normal page load.
 */
export function MatchLive({ matchId }: { matchId: string }) {
  const router = useRouter();
  // The refresh is a transition so that a slow one - the lineup calculation
  // after the final pick - can be seen to be happening.
  const [refreshing, startRefresh] = useTransition();

  useEffect(() => {
    const source = new EventSource(`/api/events/match?match=${encodeURIComponent(matchId)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      // A save can announce itself more than once in quick succession.
      clearTimeout(timer);
      timer = setTimeout(() => startRefresh(() => router.refresh()), 250);
    };

    source.addEventListener('change', refresh);
    // A dropped stream reconnects by itself, but whatever happened while it was
    // down was missed - so catch up on every reconnect after the first.
    let opened = false;
    source.onopen = () => {
      if (opened) refresh();
      opened = true;
    };

    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [matchId, router]);

  return <BusyOverlay active={refreshing} />;
}

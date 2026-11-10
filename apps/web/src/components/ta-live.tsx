'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Keeps a page that shows the TournamentAssistant link current: who is
 * connected, whether it is signed in. Asks every couple of seconds while the
 * tab is in view and redraws the page (from the server) when anything changed.
 * Renders nothing.
 */
export function TaLive({ slug, stamp, everyMs = 2500 }: { slug: string; stamp: string; everyMs?: number }) {
  const router = useRouter();
  const seen = useRef(stamp);
  seen.current = stamp;

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/ta/${encodeURIComponent(slug)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const { stamp: now } = (await res.json()) as { stamp: string };
        if (!stopped && now !== seen.current) {
          seen.current = now;
          router.refresh();
        }
      } catch {
        // Offline for a moment: the next tick tries again.
      }
    };
    const timer = setInterval(tick, everyMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [slug, everyMs, router]);

  return null;
}

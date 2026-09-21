'use client';

import { useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';

const WORKING =
  'If the last map was just picked, the best lineups for both teams are being worked out. That takes a few seconds. This closes by itself when it is done.';

/**
 * A modal that takes over the page while the match is being recalculated.
 *
 * Working out lineups after the final pick takes a few seconds, and without
 * this the page simply sits there looking broken - for the captain who clicked
 * and for everyone watching. It only appears if the wait is long enough to
 * notice, so ordinary picks do not flash it.
 */
export function BusyOverlay({ active, title = 'Updating the match…' }: { active: boolean; title?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 450);
    return () => clearTimeout(timer);
  }, [active]);

  if (!visible) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm rounded-xl border border-edge-strong bg-panel p-5 text-center shadow-2xl">
        <span
          aria-hidden
          className="mx-auto mb-3 block h-8 w-8 animate-spin rounded-full border-2 border-edge-strong border-t-accent"
        />
        <p className="text-base font-semibold">{title}</p>
        <p className="mt-2 text-sm text-muted">{WORKING}</p>
      </div>
    </div>
  );
}

/** Drop inside a <form action>: shows the overlay while that form is submitting. */
export function FormBusy({ title }: { title?: string }) {
  const { pending } = useFormStatus();
  return <BusyOverlay active={pending} title={title} />;
}

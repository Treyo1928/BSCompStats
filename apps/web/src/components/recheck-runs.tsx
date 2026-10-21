'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { recheckRunsVisibility } from '@/server/actions';

/**
 * Ask BeatLeader again, now, whether players show their runs - for everyone,
 * or one player - instead of waiting for the daily re-check.
 */
export function RecheckRuns({
  tournamentId,
  playerId,
  label,
  compact = false,
}: {
  tournamentId: string;
  playerId?: string;
  label: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const check = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await recheckRunsVisibility(tournamentId, playerId);
      if (result.error) setMessage({ tone: 'bad', text: result.error });
      else {
        const pub = result.nowPublic ?? [];
        const priv = result.stillPrivate ?? [];
        setMessage({
          tone: 'ok',
          text: playerId
            ? pub.length
              ? 'Public now - their runs are being fetched.'
              : 'Still private.'
            : `${pub.length} public, ${priv.length} private.${pub.length ? ' Runs for the public ones are being fetched.' : ''}`,
        });
        router.refresh();
      }
    } catch {
      setMessage({ tone: 'bad', text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${compact ? 'text-xs' : 'text-sm'}`}>
      <button
        type="button"
        onClick={check}
        disabled={busy}
        className={
          compact
            ? 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent disabled:opacity-50'
            : 'inline-flex h-8 items-center rounded-lg border border-edge bg-raised/60 px-3 font-medium text-ink transition hover:border-faint disabled:opacity-50'
        }
      >
        {busy ? 'Asking BeatLeader…' : label}
      </button>
      {message && <span className={message.tone === 'ok' ? 'text-muted' : 'text-lose'}>{message.text}</span>}
    </span>
  );
}

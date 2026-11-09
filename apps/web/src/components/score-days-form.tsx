'use client';

import { useFormStatus } from 'react-dom';
import { setPoolScoreDays } from '@/server/actions';
import { inputClass } from './ui';

/**
 * The organisers' "count scores from ... to ..." days for a pool. Plain days,
 * read on the server as US Central (12:00 AM on the first, 11:59 PM on the
 * last), so the window is the same for everyone. Either may be left blank.
 */
export function ScoreDaysForm({ poolId, from, to }: { poolId: string; from: string | null; to: string | null }) {
  const dateClass = `${inputClass} h-9 w-auto min-w-0 flex-1 px-2 text-sm tabular`;
  return (
    <form action={setPoolScoreDays} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="poolId" value={poolId} />
      <input type="date" name="from" aria-label="Count scores set on or after" defaultValue={from ?? ''} className={dateClass} />
      <span className="text-xs text-muted">to</span>
      <input type="date" name="to" aria-label="Count scores set on or before" defaultValue={to ?? ''} className={dateClass} />
      <Submit label="Save" />
      {(from || to) && <Submit label="Count all" name="clear" />}
    </form>
  );
}

function Submit({ label, name }: { label: string; name?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={name ? '1' : undefined}
      disabled={pending}
      className="h-9 shrink-0 rounded-lg border border-edge bg-raised/60 px-3 text-sm font-medium hover:border-faint disabled:opacity-50"
    >
      {label}
    </button>
  );
}

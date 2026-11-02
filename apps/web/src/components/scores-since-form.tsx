'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { setPoolScoresSince } from '@/server/actions';
import { inputClass } from './ui';

/**
 * The organisers' "count scores from" date for a pool. The date is picked in
 * the organiser's own time zone and sent as that day's midnight there, so the
 * cutoff is the same moment for everyone who looks.
 */
export function ScoresSinceForm({ poolId, since }: { poolId: string; since: string | null }) {
  const date = useRef<HTMLInputElement>(null);
  const iso = useRef<HTMLInputElement>(null);
  // The day it falls on is only known in the browser's time zone.
  const [day, setDay] = useState('');
  useEffect(() => setDay(since ? localDay(new Date(since)) : ''), [since]);

  return (
    <form
      action={setPoolScoresSince}
      onSubmit={() => {
        const value = date.current?.value;
        if (iso.current) iso.current.value = value ? new Date(`${value}T00:00`).toISOString() : '';
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="poolId" value={poolId} />
      <input type="hidden" name="since" ref={iso} />
      <input
        ref={date}
        type="date"
        name="day"
        aria-label="Count scores set on or after"
        value={day}
        max={localDay(new Date())}
        onChange={(e) => setDay(e.target.value)}
        className={`${inputClass} h-9 w-auto min-w-0 flex-1 px-2 text-sm tabular`}
      />
      <Submit label="Save" />
      {since && <Submit label="Count all" name="clear" />}
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

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

'use client';

import { useRef, useState } from 'react';
import { MAP_KINDS } from '@bscs/core/stats';
import { setPoolMapKind } from '@/server/actions';
import { inputClass } from './ui';

/**
 * An organiser's say on what kind of map this is.
 *
 * The guess comes from BeatLeader's ratings and is often wrong - a map rated
 * hard to pass reads as "speed" however slow and awkward it actually is - and
 * everything downstream (styles, the Acc / Tech / Speed rankings) is only as
 * good as this label. Picking from the list saves at once.
 */
export function MapKindForm({
  poolMapId,
  kind,
  guess,
}: {
  poolMapId: string;
  /** What an organiser has set, if anything. */
  kind: string | null;
  /** What the ratings suggest, shown as the fallback. */
  guess: string | null;
}) {
  const listed = kind != null && (MAP_KINDS as readonly string[]).includes(kind);
  const [custom, setCustom] = useState(kind != null && !listed);
  const form = useRef<HTMLFormElement>(null);

  return (
    <form ref={form} action={setPoolMapKind} className="mt-1.5 flex items-center gap-1.5">
      <input type="hidden" name="poolMapId" value={poolMapId} />
      <label
        htmlFor={`kind-${poolMapId}`}
        className="shrink-0 pl-1 text-[10px] font-medium uppercase tracking-wider text-faint"
        title="What kind of map this is. Yours to set - it overrides the guess made from BeatLeader's ratings."
      >
        Kind
      </label>
      <select
        id={`kind-${poolMapId}`}
        name="kind"
        defaultValue={kind == null ? '' : listed ? kind : '__custom'}
        onChange={(e) => {
          const isCustom = e.target.value === '__custom';
          setCustom(isCustom);
          if (!isCustom) form.current?.requestSubmit();
        }}
        className={`${inputClass} h-8 min-w-0 flex-1 px-2 text-xs`}
      >
        <option value="">{guess ? `Guess: ${guess}` : 'No kind set'}</option>
        {MAP_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
        <option value="__custom">Something else…</option>
      </select>
      {custom && (
        <>
          <input
            name="custom"
            defaultValue={listed ? '' : (kind ?? '')}
            maxLength={24}
            placeholder="e.g. Midspeed"
            aria-label="Your own name for this kind of map"
            className={`${inputClass} h-8 min-w-0 flex-1 px-2 text-xs`}
          />
          <button
            type="submit"
            className="h-8 shrink-0 rounded-lg border border-edge bg-raised/60 px-2.5 text-xs font-medium hover:border-faint"
          >
            Set
          </button>
        </>
      )}
    </form>
  );
}

import { setPoolMapType } from '@/server/actions';
import { inputClass } from './ui';

/** The types MSU's pools use. Only suggestions: an organiser may type anything. */
export const MAP_TYPES = [
  'True Acc',
  'Standard Acc',
  'Tech Acc',
  'Low Tech',
  'Tech',
  'Midspeed',
  'Speed',
  'Speed Tech',
  'Burst',
  'Stamina',
  'Extreme',
];

/**
 * A pool map's type, typed in by an organiser (with the usual ones offered).
 * It shows beside the map on the site and on stream.
 */
export function MapTypeForm({ poolMapId, type }: { poolMapId: string; type: string | null }) {
  return (
    <form action={setPoolMapType} className="mt-1.5 flex items-center gap-1.5">
      <input type="hidden" name="poolMapId" value={poolMapId} />
      <label
        htmlFor={`type-${poolMapId}`}
        className="w-[4.25rem] shrink-0 pl-1 text-[10px] font-medium uppercase tracking-wider text-faint"
        title="What kind of map this is. Shown beside the map on the site and on the stream overlay."
      >
        Type
      </label>
      <input
        id={`type-${poolMapId}`}
        name="type"
        list="map-types"
        autoComplete="off"
        maxLength={24}
        defaultValue={type ?? ''}
        placeholder="Not set"
        className={`${inputClass} h-8 min-w-0 flex-1 px-2 text-xs`}
      />
      <button
        type="submit"
        className="h-8 shrink-0 rounded-lg border border-edge bg-raised/60 px-2.5 text-xs font-medium hover:border-faint"
      >
        Set
      </button>
    </form>
  );
}

/** The suggestions every MapTypeForm on a page shares. Render once. */
export function MapTypeList() {
  return (
    <datalist id="map-types">
      {MAP_TYPES.map((t) => (
        <option key={t} value={t} />
      ))}
    </datalist>
  );
}

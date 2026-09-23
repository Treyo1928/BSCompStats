import { setPoolMapPerfect } from '@/server/actions';
import { inputClass } from './ui';

/**
 * What counts as a perfect score on a pool map, for match points: a score at
 * this accuracy is worth the curve's full points. Organisers set it once per
 * pool. It scales the points players see for the map and never decides who
 * wins one.
 */
export function PerfectAccForm({
  poolMapId,
  perfectAcc,
  fallback,
}: {
  poolMapId: string;
  /** What an organiser has set, if anything. */
  perfectAcc: number | null;
  /** What is used when nothing is set - BeatLeader's predicted accuracy, where the tournament allows it. */
  fallback: number | null;
}) {
  return (
    <form action={setPoolMapPerfect} className="mt-1.5 flex items-center gap-1.5">
      <input type="hidden" name="poolMapId" value={poolMapId} />
      <label
        htmlFor={`perfect-${poolMapId}`}
        className="shrink-0 pl-1 text-[10px] font-medium uppercase tracking-wider text-faint"
        title="The accuracy that counts as a perfect score here, for match points. A score at it is worth the curve's full points. It sets how big the points are, never who wins the map."
      >
        Perfect %
      </label>
      <input
        id={`perfect-${poolMapId}`}
        name="perfect"
        inputMode="decimal"
        autoComplete="off"
        defaultValue={perfectAcc != null ? String(Math.round(perfectAcc * 100_000) / 1000) : ''}
        placeholder={fallback != null ? `BeatLeader: ${(fallback * 100).toFixed(2)}` : 'Not set'}
        className={`${inputClass} h-8 min-w-0 flex-1 px-2 text-xs tabular`}
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

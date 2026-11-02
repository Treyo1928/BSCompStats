import { PLAY_ORDER_NAMES } from '@/lib/play-order';

/**
 * Picks-first or play-each-pick, for one match. The first option leaves it to
 * the tournament's default, which the server resolves.
 */
export function PlayOrderSelect({ className, compact = false }: { className: string; compact?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className={compact ? 'text-[11px] font-medium text-muted' : 'text-sm font-medium'}>Play order</span>
      <select name="playOrder" defaultValue="" className={className}>
        <option value="">Tournament default</option>
        {Object.entries(PLAY_ORDER_NAMES).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {!compact && (
        <span className="block text-xs text-faint">
          Play each map as it is picked runs pick, play, pick, play, ban, ban, … and the tiebreaker last.
        </span>
      )}
    </label>
  );
}

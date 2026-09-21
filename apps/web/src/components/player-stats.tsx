import type { Specialty } from '@bscs/core/stats';
import { Badge } from './ui';

/** A difference between two accuracies, in points: "+1.24". */
export function signedPoints(diff: number, digits = 2): string {
  const points = diff * 100;
  return `${points >= 0 ? '+' : '−'}${Math.abs(points).toFixed(digits)}`;
}

// Amber, not red, for the worst kind: everyone has one, and it is a place to look, not a verdict.
const BADGE_TONE = { good: 'win', warn: 'warn', neutral: 'accent' } as const;

/** "Tech specialist" and "Worst on Acc" - one of each for everyone, and about the player rather than their team. */
export function StyleBadges({ style }: { style: Pick<Specialty, 'badges' | 'summary'> | null }) {
  if (!style) return <Badge>No scores</Badge>;
  return (
    <>
      {style.badges.map((badge) => (
        <Badge key={badge.label} tone={BADGE_TONE[badge.tone]} title={style.summary}>
          {badge.label}
        </Badge>
      ))}
    </>
  );
}

/**
 * A lean, drawn from a centre line: right and green for better than their
 * level predicts, left and red for worse. `scale` is the value that fills a side.
 */
export function DivergingBar({ value, scale }: { value: number; scale: number }) {
  const share = Math.min(1, Math.abs(value) / (scale || 1)) * 50;
  return (
    <span className="relative block h-2 overflow-hidden rounded-full bg-edge-strong/60">
      <span className="absolute inset-y-0 left-1/2 w-px bg-faint" />
      <span
        className="absolute inset-y-0 rounded-full"
        style={{
          width: `${share}%`,
          left: value >= 0 ? '50%' : `${50 - share}%`,
          background: value >= 0 ? 'var(--color-win)' : 'var(--color-lose)',
        }}
      />
    </span>
  );
}

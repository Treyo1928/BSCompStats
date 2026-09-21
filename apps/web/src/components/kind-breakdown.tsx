'use client';

import { useState } from 'react';
import { DivergingBar } from './player-stats';

export interface KindRow {
  kind: string;
  /** Their own scores of this kind. */
  maps: number;
  /** Gaps are in accuracy points. Null where there is nothing to compare. */
  team: { gap: number | null; rank: number | null; ranked: number; comparisons: number };
  field: { gap: number | null; rank: number | null; ranked: number; comparisons: number };
  predicted: { gap: number; rank: number; ranked: number } | null;
  /** Set in the wider views: pp earned on this kind, which is what the ranks there are ranks of. */
  pp?: number;
}

type Against = 'team' | 'field' | 'predicted';

/**
 * How a player does on each kind of map - against whom is the viewer's choice.
 *
 * Against teammates is the default, because it is the question a captain is
 * asking: not "is this below what the model expected" but "is there anyone on
 * the team I would rather field here".
 */
export function KindBreakdown({
  rows,
  teamName,
}: {
  rows: KindRow[];
  teamName: string;
}) {
  const [against, setAgainst] = useState<Against>('team');

  const options: Array<{ key: Against; label: string; blurb: string }> = [
    {
      key: 'team',
      label: 'Teammates',
      blurb: `Average gap to ${teamName} teammates, on the maps of each kind both have played. Where a pp figure is shown the rank is by that - what they have earned on that kind of map over their whole ranked history - and the gap is only for comparison.`,
    },
    {
      key: 'field',
      label: 'The field',
      blurb: 'Average gap to everyone in the tournament, on the maps of each kind both have played. The rank is their place in the whole field.',
    },
    {
      key: 'predicted',
      label: 'Their own level',
      blurb: 'Against what the model predicts from their general level: negative means this kind of map costs them more than it costs most. It says nothing about whether they still beat a teammate on it.',
    },
  ];

  const shown = rows.map((row) => {
    const pick = against === 'predicted' ? row.predicted : row[against];
    return {
      row,
      value: pick?.gap ?? null,
      rank: pick?.rank ?? null,
      ranked: pick?.ranked ?? 0,
    };
  });
  const scale = Math.max(0.5, ...shown.map((s) => Math.abs(s.value ?? 0)));

  return (
    <div>
      <div role="tablist" aria-label="Compare against" className="flex gap-1 rounded-lg border border-edge bg-surface/60 p-1 text-xs">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={against === option.key}
            onClick={() => setAgainst(option.key)}
            className={`flex-1 rounded-md px-2 font-medium transition ${
              against === option.key ? 'bg-accent/20 text-ink ring-1 ring-inset ring-accent/40' : 'text-muted hover:bg-raised'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">{options.find((o) => o.key === against)!.blurb}</p>

      <ul className="mt-4 space-y-3">
        {shown.map(({ row, value, rank, ranked }) => (
          <li
            key={row.kind}
            className={`grid grid-cols-[6.5rem_1fr_3.25rem] items-center gap-x-3 text-sm ${
              row.kind === 'Overall' ? 'border-b border-edge pb-3' : ''
            }`}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{row.kind}</span>
              <span className="block text-[10px] tabular text-faint">
                {against === 'predicted' && row.kind === 'Overall'
                  ? 'their own level'
                  : row.maps === 0 && !(row.pp && row.pp > 0)
                  ? 'not played'
                  : rank
                    ? `#${rank} of ${ranked}${against === 'team' ? ' on team' : ''}`
                    : 'nobody to compare'}
              </span>
            </span>
            {value != null ? (
              <DivergingBar value={value} scale={scale} />
            ) : (
              <span className="h-2 rounded-full border border-dashed border-edge-strong" />
            )}
            <span
              className={`text-right tabular ${value == null ? 'text-faint' : value >= 0 ? 'text-win' : 'text-lose'}`}
              title={`${row.maps} map${row.maps === 1 ? '' : 's'} of this kind in common with others`}
            >
              {value == null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`}
              {row.pp != null && against !== 'predicted' && (
                <span className="block text-[10px] font-normal text-faint">{Math.round(row.pp).toLocaleString('en-US')}pp</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

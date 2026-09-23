'use client';

import { useState } from 'react';
import { accuracyForPoints, matchPoints, type PointsCurve } from '@bscs/core/match';
import { Field, inputClass } from './ui';

/**
 * Score, accuracy and match points on one map, each from any other: type one
 * and the rest follow. For "what do I need on this map" as much as "what was
 * that worth".
 */
export function PointsCalculator({
  maps,
  curve,
  showPoints,
}: {
  maps: Array<{ id: string; name: string; difficulty: string; maxScore: number; perfectAcc: number | null }>;
  curve: PointsCurve;
  /** Whether this match is scored in match points; accuracy alone otherwise. */
  showPoints: boolean;
}) {
  const [mapId, setMapId] = useState(maps[0]?.id ?? '');
  // What was typed, and in which box: the other two are worked out from it.
  const [entry, setEntry] = useState<{ field: 'score' | 'acc' | 'points'; text: string }>({ field: 'acc', text: '' });
  const map = maps.find((m) => m.id === mapId) ?? maps[0];
  if (!map) return null;

  const hasPoints = showPoints && map.perfectAcc != null;
  const typed = Number(entry.text.replace(/[,\s%]/g, ''));
  const valid = entry.text.trim() !== '' && Number.isFinite(typed) && typed >= 0;

  let acc: number | null = null;
  let problem: string | null = null;
  if (valid) {
    if (entry.field === 'acc') acc = typed / 100;
    else if (entry.field === 'score') acc = map.maxScore > 0 ? typed / map.maxScore : null;
    else if (hasPoints) acc = accuracyForPoints(typed, map.perfectAcc!, curve);
    if (acc == null && entry.field === 'points') problem = 'More points than a perfect 100% earns on this map.';
    else if (acc != null && acc > 1) problem = 'More than this map allows.';
  }
  const shown = acc != null && acc <= 1 ? acc : null;

  const value = (field: 'score' | 'acc' | 'points'): string => {
    if (entry.field === field) return entry.text;
    if (shown == null) return '';
    if (field === 'acc') return (shown * 100).toFixed(2);
    if (field === 'score') return String(Math.round(shown * map.maxScore));
    return hasPoints ? matchPoints(shown, map.perfectAcc!, curve).toFixed(2) : '';
  };
  const set = (field: 'score' | 'acc' | 'points') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEntry({ field, text: e.target.value });

  return (
    <div className="space-y-3">
      <Field label="Map">
        <select value={map.id} onChange={(e) => setMapId(e.target.value)} className={inputClass}>
          {maps.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.difficulty})
            </option>
          ))}
        </select>
      </Field>
      <div className={`grid gap-2 ${hasPoints ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <Field label="Score">
          <input inputMode="numeric" value={value('score')} onChange={set('score')} placeholder="0" className={`${inputClass} tabular`} />
        </Field>
        <Field label="Accuracy %">
          <input inputMode="decimal" value={value('acc')} onChange={set('acc')} placeholder="0.00" className={`${inputClass} tabular`} />
        </Field>
        {hasPoints && (
          <Field label="Points">
            <input inputMode="decimal" value={value('points')} onChange={set('points')} placeholder="0.00" className={`${inputClass} tabular`} />
          </Field>
        )}
      </div>
      {problem && <p className="text-xs text-lose">{problem}</p>}
      <p className="text-xs text-faint">
        Max score {map.maxScore.toLocaleString('en-US')}.
        {showPoints &&
          (map.perfectAcc != null
            ? ` A perfect score here is ${(map.perfectAcc * 100).toFixed(2)}%, worth ${curve.perfectPoints} points.`
            : ' No perfect % is set for this map, so it has no points to show - it is still decided on the curve.')}
      </p>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { matchPoints, pointsCurveSchema, type PointsCurve } from '@bscs/core/match';
import { Button, Field, inputClass } from './ui';

export type CurveMap = {
  /** PoolMap id. */
  id: string;
  name: string;
  difficulty: string;
  perfectAcc: number | null;
  /** Where the perfect % came from: set on the pool page, or BeatLeader's prediction. */
  source: 'ORGANISERS' | 'BEATLEADER' | null;
};

export type CurvePool = { id: string; name: string; maps: CurveMap[] };

// The categorical slots for a dark surface, in fixed order. A map keeps the
// slot it was given when ticked, so ticking another never repaints it.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const FROM_CHOICES = [0.5, 0.7, 0.8, 0.9, 0.95];
const TABLE_ACCS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.96, 0.97, 0.98, 0.99, 1];

/**
 * The match points curve's three numbers, with the curve drawn for the maps
 * picked below it as they are typed. The inputs are the form's own fields, so
 * saving sends exactly what is drawn. Where the typed curve differs from the
 * saved one, the saved one is drawn dashed behind it.
 */
export function CurveEditor({
  pools,
  saved,
  defaults,
}: {
  pools: CurvePool[];
  saved: PointsCurve;
  defaults: PointsCurve;
}) {
  const [text, setText] = useState({
    padding: String(saved.padding),
    slope: String(saved.slope),
    perfectPoints: String(saved.perfectPoints),
  });
  const parsed = pointsCurveSchema.safeParse({
    padding: Number(text.padding),
    slope: Number(text.slope),
    perfectPoints: Number(text.perfectPoints),
  });
  const typedOk = parsed.success && Object.values(text).every((t) => t.trim() !== '');
  const curve: PointsCurve = typedOk ? parsed.data : saved;
  const changed =
    typedOk && (curve.padding !== saved.padding || curve.slope !== saved.slope || curve.perfectPoints !== saved.perfectPoints);

  const [poolId, setPoolId] = useState(pools[0]?.id ?? '');
  const pool = pools.find((p) => p.id === poolId) ?? pools[0];
  // Map id -> colour slot. Starts on the pool's easiest, middle and hardest
  // perfect %, which shows the most of what the scaling does.
  const [slots, setSlots] = useState<Map<string, number>>(() => initialPick(pools[0]));
  const [from, setFrom] = useState(0.8);

  const allMaps = useMemo(() => new Map(pools.flatMap((p) => p.maps).map((m) => [m.id, m])), [pools]);
  const series = [...slots.entries()]
    .map(([id, slot]) => ({ map: allMaps.get(id), slot }))
    .filter((s): s is { map: CurveMap & { perfectAcc: number }; slot: number } => s.map?.perfectAcc != null)
    .sort((a, b) => a.slot - b.slot);

  const toggle = (id: string) =>
    setSlots((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else {
        const used = new Set(next.values());
        const free = SERIES.findIndex((_, i) => !used.has(i));
        if (free < 0) return prev;
        next.set(id, free);
      }
      return next;
    });

  const set = (field: keyof typeof text) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setText((t) => ({ ...t, [field]: e.target.value }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Padding" hint={`Smaller is steeper near 100%. Default ${defaults.padding}.`}>
          <input name="padding" inputMode="decimal" value={text.padding} onChange={set('padding')} className={`${inputClass} tabular`} />
        </Field>
        <Field label="Slope" hint={`How much lower accuracies still climb. Default ${defaults.slope}.`}>
          <input name="slope" inputMode="decimal" value={text.slope} onChange={set('slope')} className={`${inputClass} tabular`} />
        </Field>
        <Field label="Perfect points" hint={`A score at the map's perfect % is worth this. Default ${defaults.perfectPoints}.`}>
          <input
            name="perfectPoints"
            inputMode="decimal"
            value={text.perfectPoints}
            onChange={set('perfectPoints')}
            className={`${inputClass} tabular`}
          />
        </Field>
      </div>
      {!typedOk && (
        <p className="text-xs text-lose">
          Padding must be above 0 and at most 1, slope 0 or more, and perfect points above 0. Drawing the saved curve.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit">Save curve</Button>
        <button
          type="button"
          onClick={() =>
            setText({
              padding: String(defaults.padding),
              slope: String(defaults.slope),
              perfectPoints: String(defaults.perfectPoints),
            })
          }
          className="text-xs text-muted underline decoration-faint underline-offset-2 hover:text-ink"
        >
          Fill in the defaults
        </button>
        {changed && (
          <button
            type="button"
            onClick={() =>
              setText({
                padding: String(saved.padding),
                slope: String(saved.slope),
                perfectPoints: String(saved.perfectPoints),
              })
            }
            className="text-xs text-muted underline decoration-faint underline-offset-2 hover:text-ink"
          >
            Back to the saved curve
          </button>
        )}
        {changed && <span className="text-xs text-warn">Not saved yet - the dashed lines are the saved curve.</span>}
      </div>

      <div className="space-y-2 border-t border-edge pt-4">
        <div className="flex flex-wrap items-end gap-3">
          {pools.length > 1 && (
            <Field label="Maps from">
              <select value={pool?.id} onChange={(e) => setPoolId(e.target.value)} className={`${inputClass} w-auto`}>
                {pools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Accuracy from">
            <select value={from} onChange={(e) => setFrom(Number(e.target.value))} className={`${inputClass} w-auto tabular`}>
              {FROM_CHOICES.map((f) => (
                <option key={f} value={f}>
                  {Math.round(f * 100)}%
                </option>
              ))}
            </select>
          </Field>
        </div>
        {pool ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Maps to draw">
            {pool.maps.map((m) => {
              const slot = slots.get(m.id);
              const on = slot != null;
              const full = !on && slots.size >= SERIES.length;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    disabled={m.perfectAcc == null || full}
                    onClick={() => toggle(m.id)}
                    title={
                      m.perfectAcc == null
                        ? 'No perfect % for this map - set one on the pool page'
                        : full
                          ? `At most ${SERIES.length} maps at once`
                          : undefined
                    }
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      on ? 'border-edge-strong bg-raised text-ink' : 'border-edge text-muted hover:text-ink'
                    }`}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full border border-edge-strong"
                      style={on ? { background: SERIES[slot], borderColor: SERIES[slot] } : undefined}
                    />
                    <span className="max-w-[14rem] truncate">{m.name}</span>
                    <span className="text-faint">{m.difficulty}</span>
                    <span className="tabular text-faint">
                      {m.perfectAcc != null ? `${(m.perfectAcc * 100).toFixed(2)}%${m.source === 'BEATLEADER' ? '*' : ''}` : 'no perfect %'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-faint">No map pools yet - the curve is drawn for maps in a pool.</p>
        )}
        {pool?.maps.some((m) => m.source === 'BEATLEADER') && (
          <p className="text-xs text-faint">* BeatLeader&apos;s predicted accuracy, used until a perfect % is set on the pool page.</p>
        )}
      </div>

      {series.length > 0 ? (
        <>
          <CurveChart series={series} curve={curve} saved={changed ? saved : null} from={from} />
          <PointsTable series={series} curve={curve} saved={changed ? saved : null} from={from} />
        </>
      ) : (
        pool && <p className="text-xs text-faint">Tick a map above to draw its curve.</p>
      )}
    </div>
  );
}

function initialPick(pool: CurvePool | undefined): Map<string, number> {
  const withPerfect = (pool?.maps ?? []).filter((m) => m.perfectAcc != null).sort((a, b) => a.perfectAcc! - b.perfectAcc!);
  const picks =
    withPerfect.length <= 3
      ? withPerfect
      : [withPerfect[0], withPerfect[Math.floor(withPerfect.length / 2)], withPerfect[withPerfect.length - 1]];
  return new Map(picks.map((m, i) => [m.id, i]));
}

type Series = { map: CurveMap & { perfectAcc: number }; slot: number };

const PAD = { top: 12, right: 16, bottom: 30, left: 44 };

function CurveChart({
  series,
  curve,
  saved,
  from,
}: {
  series: Series[];
  curve: PointsCurve;
  saved: PointsCurve | null;
  from: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at its real width, so the axis text stays text-sized on a wide
  // screen and readable on a phone rather than scaling with the picture.
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const H = Math.round(Math.min(340, Math.max(240, W * 0.45)));

  const curves = saved ? [curve, saved] : [curve];
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const c of curves) {
      lo = Math.min(lo, matchPoints(from, s.map.perfectAcc, c));
      hi = Math.max(hi, matchPoints(1, s.map.perfectAcc, c));
    }
  }
  const { min: yMin, max: yMax, ticks: yTicks } = niceScale(lo, hi);
  const x = (acc: number) => PAD.left + ((acc - from) / (1 - from)) * (W - PAD.left - PAD.right);
  const y = (pts: number) => PAD.top + (1 - (pts - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const steps = 160;
  const path = (perfect: number, c: PointsCurve) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const acc = from + ((1 - from) * i) / steps;
      return `${i === 0 ? 'M' : 'L'}${x(acc).toFixed(1)},${y(matchPoints(acc, perfect, c)).toFixed(1)}`;
    }).join('');

  // Fewer labels when there is less room for them.
  const span = 1 - from;
  const maxLabels = Math.max(3, Math.floor((W - PAD.left - PAD.right) / 48));
  const xStep = [0.01, 0.02, 0.05, 0.1, 0.25].find((s) => span / s <= maxLabels) ?? 0.25;
  const xTicks: number[] = [];
  for (let t = 1; t >= from - 1e-9; t -= xStep) xTicks.unshift(Math.round(t * 100) / 100);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const acc = from + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (1 - from);
    setHover(acc < from || acc > 1 ? null : Math.round(acc * 1000) / 1000);
  };

  return (
    <figure className="space-y-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
        {series.map((s) => (
          <li key={s.map.id} className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: SERIES[s.slot] }} />
            {s.map.name} <span className="text-faint">{s.map.difficulty}</span>
          </li>
        ))}
        {saved && (
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="w-4 border-t-2 border-dashed border-muted" />
            saved curve
          </li>
        )}
      </ul>
      <div className="relative" ref={boxRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          className="block max-w-full touch-none select-none"
          role="img"
          aria-label="Match points against accuracy for the ticked maps"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-edge)" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-faint)">
                {fmt(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize={11} fill="var(--color-faint)">
              {Math.round(t * 100)}%
            </text>
          ))}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={H - PAD.bottom}
            y2={H - PAD.bottom}
            stroke="var(--color-edge-strong)"
            strokeWidth={1}
          />
          {saved &&
            series.map((s) => (
              <path
                key={`saved-${s.map.id}`}
                d={path(s.map.perfectAcc, saved)}
                fill="none"
                stroke={SERIES[s.slot]}
                strokeOpacity={0.55}
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
            ))}
          {series.map((s) => (
            <path key={s.map.id} d={path(s.map.perfectAcc, curve)} fill="none" stroke={SERIES[s.slot]} strokeWidth={2} />
          ))}
          {/* Where each map's perfect % sits: worth exactly the perfect points. */}
          {series
            .filter((s) => s.map.perfectAcc >= from)
            .map((s) => (
              <circle
                key={`p-${s.map.id}`}
                cx={x(s.map.perfectAcc)}
                cy={y(curve.perfectPoints)}
                r={4}
                fill={SERIES[s.slot]}
                stroke="var(--color-panel)"
                strokeWidth={2}
              />
            ))}
          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--color-muted)" strokeWidth={1} />
              {series.map((s) => (
                <circle
                  key={s.map.id}
                  cx={x(hover)}
                  cy={y(matchPoints(hover, s.map.perfectAcc, curve))}
                  r={4}
                  fill={SERIES[s.slot]}
                  stroke="var(--color-panel)"
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>
        {hover != null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[11rem] rounded-lg border border-edge-strong bg-raised/95 px-3 py-2 text-xs shadow-lg"
            style={
              x(hover) / W > 0.55
                ? { right: `${(1 - x(hover) / W) * 100 + 2}%` }
                : { left: `${(x(hover) / W) * 100 + 2}%` }
            }
          >
            <div className="mb-1 font-medium text-ink">{(hover * 100).toFixed(1)}% accuracy</div>
            <table className="tabular">
              <tbody>
                {series.map((s) => (
                  <tr key={s.map.id}>
                    <td className="pr-2">
                      <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: SERIES[s.slot] }} />
                    </td>
                    <td className="max-w-[9rem] truncate pr-3 text-muted">{s.map.name}</td>
                    <td className="text-right text-ink">{matchPoints(hover, s.map.perfectAcc, curve).toFixed(2)}</td>
                    {saved && (
                      <td className="pl-2 text-right text-faint">was {matchPoints(hover, s.map.perfectAcc, saved).toFixed(2)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <figcaption className="text-xs text-faint">
        Points for each accuracy. A dot marks each map&apos;s perfect %, worth {fmt(curve.perfectPoints)} points. Hover or
        drag across it for exact values.
      </figcaption>
    </figure>
  );
}

function PointsTable({
  series,
  curve,
  saved,
  from,
}: {
  series: Series[];
  curve: PointsCurve;
  saved: PointsCurve | null;
  from: number;
}) {
  const accs = TABLE_ACCS.filter((a) => a >= from - 1e-9);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted hover:text-ink">As a table</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full tabular">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-faint">
              <th className="py-1 pr-3 font-medium">Accuracy</th>
              {series.map((s) => (
                <th key={s.map.id} className="py-1 pl-3 text-right font-medium normal-case tracking-normal">
                  <span className="inline-flex items-center gap-1">
                    <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: SERIES[s.slot] }} />
                    <span className="max-w-[8rem] truncate">{s.map.name}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accs.map((acc) => (
              <tr key={acc} className="border-t border-edge/60">
                <td className="py-1 pr-3">{(acc * 100).toFixed(0)}%</td>
                {series.map((s) => {
                  const now = matchPoints(acc, s.map.perfectAcc, curve);
                  const before = saved ? matchPoints(acc, s.map.perfectAcc, saved) : null;
                  return (
                    <td key={s.map.id} className="py-1 pl-3 text-right">
                      {now.toFixed(2)}
                      {before != null && Math.abs(now - before) >= 0.005 && (
                        <span className="ml-1 text-xs text-faint">
                          ({now > before ? '+' : '−'}
                          {Math.abs(now - before).toFixed(2)})
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function niceScale(lo: number, hi: number): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    const base = Number.isFinite(hi) ? hi : 1;
    return { min: base - 1, max: base + 1, ticks: [base - 1, base, base + 1] };
  }
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { min, max, ticks };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1);
}

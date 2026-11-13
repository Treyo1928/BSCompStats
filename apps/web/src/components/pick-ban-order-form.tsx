'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { PickBanStep } from '@bscs/core/match';
import { setPoolPickBan } from '@/server/actions';

const same = (a: PickBanStep[], b: PickBanStep[]) =>
  a.length === b.length && a.every((s, i) => s.actor === b[i]!.actor && s.action === b[i]!.action);

/** One step of the order, as everyone sees it: who (coin flip winner or loser) and what. */
export function StepChip({ step, n }: { step: PickBanStep; n: number }) {
  const ban = step.action === 'BAN';
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium ${
        ban ? 'border-red-400/30 bg-red-500/10 text-red-200' : 'border-green-400/30 bg-green-500/10 text-green-200'
      }`}
    >
      <span className="tabular text-[10px] text-faint">{n}</span>
      {step.actor === 'COIN_WINNER' ? 'Winner' : 'Loser'} {ban ? 'bans' : 'picks'}
    </span>
  );
}

/**
 * The pool's pick/ban order, edited step by step. What it adds up to (maps
 * played, bans, maps the pool must have) is shown as it changes, so the
 * result is known before it is saved.
 */
export function PickBanOrderForm({
  poolId,
  own,
  tournament,
  presets,
  mapCount,
  hasTiebreaker,
}: {
  poolId: string;
  /** The pool's own order, or null while it plays the tournament's. */
  own: PickBanStep[] | null;
  tournament: PickBanStep[];
  presets: Array<{ label: string; steps: PickBanStep[] }>;
  /** Maps in the pool that can be picked or banned. */
  mapCount: number;
  /** The format leaves the last map as the tiebreaker. */
  hasTiebreaker: boolean;
}) {
  const [steps, setSteps] = useState<PickBanStep[]>(own ?? tournament);
  const usesTournament = same(steps, tournament);
  const changed = !same(steps, own ?? tournament);
  const picks = steps.filter((s) => s.action === 'PICK').length;
  const bans = steps.length - picks;
  const needs = steps.length + (hasTiebreaker ? 1 : 0);
  const played = picks + (hasTiebreaker ? 1 : 0);
  const set = (i: number, patch: Partial<PickBanStep>) =>
    setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const small = 'h-7 rounded-md border border-edge bg-raised/60 px-2 text-xs font-medium hover:border-faint';

  return (
    <form action={setPoolPickBan} className="space-y-3">
      <input type="hidden" name="poolId" value={poolId} />
      <input type="hidden" name="steps" value={usesTournament ? '' : JSON.stringify(steps)} />

      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={`${small} ${usesTournament ? 'border-accent text-accent' : ''}`} onClick={() => setSteps(tournament)}>
          Tournament&apos;s order
        </button>
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`${small} ${same(steps, p.steps) && !usesTournament ? 'border-accent text-accent' : ''}`}
            onClick={() => setSteps(p.steps)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <ol className="flex flex-wrap gap-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex h-8 items-center overflow-hidden rounded-md border border-edge bg-raised/40 text-xs">
            <span className="w-6 text-center tabular text-[10px] text-faint">{i + 1}</span>
            <button
              type="button"
              title="Switch between the coin flip's winner and loser"
              className="h-full px-1.5 font-medium hover:bg-raised"
              onClick={() => set(i, { actor: s.actor === 'COIN_WINNER' ? 'COIN_LOSER' : 'COIN_WINNER' })}
            >
              {s.actor === 'COIN_WINNER' ? 'Winner' : 'Loser'}
            </button>
            <button
              type="button"
              title="Switch between pick and ban"
              className={`h-full px-1.5 font-medium hover:bg-raised ${s.action === 'BAN' ? 'text-red-300' : 'text-green-300'}`}
              onClick={() => set(i, { action: s.action === 'PICK' ? 'BAN' : 'PICK' })}
            >
              {s.action === 'BAN' ? 'bans' : 'picks'}
            </button>
            <button
              type="button"
              aria-label={`Remove step ${i + 1}`}
              className="h-full border-l border-edge px-1.5 text-faint hover:bg-raised hover:text-lose"
              onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </li>
        ))}
        <li className="flex gap-1.5">
          <button type="button" className={`${small} h-8`} onClick={() => setSteps((all) => [...all, { actor: nextActor(all), action: 'PICK' }])}>
            + pick
          </button>
          <button type="button" className={`${small} h-8`} onClick={() => setSteps((all) => [...all, { actor: nextActor(all), action: 'BAN' }])}>
            + ban
          </button>
        </li>
      </ol>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm">
          <span className="font-semibold tabular">Best of {played}</span>
          <span className="text-muted">
            {' '}
            · {picks} picked{hasTiebreaker ? ' + tiebreaker' : ''} · {bans} banned ·{' '}
          </span>
          <span className={needs > mapCount ? 'font-medium text-lose' : needs < mapCount ? 'text-warn' : 'text-win'}>
            uses {needs} of this pool&apos;s {mapCount} maps
          </span>
        </p>
        <Save disabled={!changed || picks === 0 || needs > mapCount} />
      </div>
    </form>
  );
}

/** Whoever did not take the last step goes next, by default. */
function nextActor(steps: PickBanStep[]): PickBanStep['actor'] {
  return steps.at(-1)?.actor === 'COIN_WINNER' ? 'COIN_LOSER' : 'COIN_WINNER';
}

function Save({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="h-8 rounded-lg border border-edge bg-raised/60 px-3 text-sm font-medium hover:border-faint disabled:opacity-40"
    >
      {pending ? 'Saving…' : 'Save order'}
    </button>
  );
}

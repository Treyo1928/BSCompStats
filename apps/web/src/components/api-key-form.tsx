'use client';

import { useActionState } from 'react';
import { createApiKey, type CreatedKey } from '@/server/api-key-actions';
import { Button, Field, inputClass } from './ui';

/** Create a key and show it once. */
export function ApiKeyForm({ tournaments }: { tournaments: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState<CreatedKey, FormData>(createApiKey, {});
  return (
    <div className="space-y-4">
      {state.key && (
        <div className="space-y-2 rounded-lg border border-accent/60 bg-raised p-3 text-sm">
          <p>
            <span className="font-semibold">{state.name}</span>: copy this key now. It will not be shown again.
          </p>
          <code className="block select-all break-all rounded bg-surface px-2 py-1.5 font-mono text-xs">{state.key}</code>
          <p className="text-xs text-faint">Keep it on the computer that runs the overlay. Anyone with it can act as you.</p>
        </div>
      )}
      {state.error && <p className="text-sm text-lose">{state.error}</p>}
      <form action={action} className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="What it is for, e.g. “Stream overlay”.">
          <input name="name" className={inputClass} placeholder="Stream overlay" maxLength={60} />
        </Field>
        <Field label="Works in" hint="Limit it to one tournament unless it really needs all of yours.">
          <select name="tournamentId" className={inputClass} defaultValue={tournaments[0]?.id ?? ''}>
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="">Every tournament I can act in</option>
          </select>
        </Field>
        <Field label="Expires">
          <select name="expiresInDays" className={inputClass} defaultValue="90">
            <option value="7">In a week</option>
            <option value="30">In a month</option>
            <option value="90">In 3 months</option>
            <option value="365">In a year</option>
            <option value="0">Never</option>
          </select>
        </Field>
        <label className="flex items-start gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="readOnly" className="mt-1" />
          <span>
            Read-only
            <span className="block text-xs text-faint">For an overlay that only shows matches. Leave off to let it run them.</span>
          </span>
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create key'}
          </Button>
        </div>
      </form>
    </div>
  );
}

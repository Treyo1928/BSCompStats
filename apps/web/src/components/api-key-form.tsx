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
        <div className="sm:col-span-2">
          <KeyScopeFields tournaments={tournaments} chosen={tournaments.slice(0, 1).map((t) => t.id)} everywhere={false} signInUrl="" />
        </div>
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

/**
 * Where a key works (some tournaments, or all of its user's) and where it signs people in. Shared by the new-key
 * form and each key's own settings. Plain fields: ticking "every tournament" is read by the server as "all",
 * whatever is ticked beside it.
 */
export function KeyScopeFields({
  tournaments,
  chosen,
  everywhere,
  signInUrl,
}: {
  tournaments: Array<{ id: string; name: string }>;
  chosen: string[];
  everywhere: boolean;
  signInUrl: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className="text-sm">
        <legend className="mb-1 text-xs font-medium text-muted">Works in</legend>
        <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-edge p-2">
          {tournaments.map((t) => (
            <label key={t.id} className="flex items-center gap-2">
              <input type="checkbox" name="tournamentIds" value={t.id} defaultChecked={chosen.includes(t.id)} />
              {t.name}
            </label>
          ))}
          {tournaments.length === 0 && <p className="text-xs text-faint">You have no tournaments yet.</p>}
          <label className="flex items-center gap-2 border-t border-edge pt-1 text-muted">
            <input type="checkbox" name="everywhere" defaultChecked={everywhere} />
            Every tournament I can act in, now and later
          </label>
        </div>
        <p className="mt-1 text-xs text-faint">Tick only the tournaments the app needs.</p>
      </fieldset>
      <Field
        label="Sign-in address (optional)"
        hint="The app's own address, e.g. https://overlay.example. With it, you and the people you approve below can sign in to that app with a BSCompStats account. Empty: the key signs nobody in."
      >
        <input name="signInUrl" className={inputClass} defaultValue={signInUrl} placeholder="https://overlay.example" inputMode="url" maxLength={200} />
      </Field>
    </div>
  );
}

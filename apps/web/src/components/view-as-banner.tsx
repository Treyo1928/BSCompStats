import { viewingAs } from '@/server/session';
import { stopViewAs } from '@/server/admin-actions';

/** Impossible to miss, on every page: acting as someone else must never be a surprise. */
export async function ViewAsBanner() {
  const state = await viewingAs();
  if (!state) return null;

  return (
    <div className="border-b border-amber-400/30 bg-amber-500/15 text-amber-100">
      <form
        action={stopViewAs}
        className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-xs"
      >
        <p>
          Viewing the site as <strong className="font-semibold">{state.target.name ?? 'another user'}</strong>
          {state.target.role === 'ADMIN' ? ' (site admin)' : ''}. You see what they see, and anything you
          change is done as them.
        </p>
        <button
          type="submit"
          className="rounded-lg border border-amber-300/50 px-2.5 py-1 font-medium hover:bg-amber-400/20"
        >
          Stop, back to {state.admin.name ?? 'my account'}
        </button>
      </form>
    </div>
  );
}

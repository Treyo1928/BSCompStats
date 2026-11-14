import { apiRoute, json } from '@/server/api';
import { peopleOf } from '@/server/connect';

export const dynamic = 'force-dynamic';

/**
 * Who may sign in to the app this key is for, right now: the key's user and the people they approved. An app asks
 * again from time to time, so that someone taken off the list is signed out of it without waiting for anything.
 */
export async function GET(request: Request) {
  return apiRoute(request, {}, async ({ holder }) =>
    json({ signInUrl: holder.key.signInUrl, people: holder.key.signInUrl ? await peopleOf(holder.key.id) : [] }),
  );
}

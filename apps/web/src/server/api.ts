import { keyHolder, type KeyHolder } from './api-keys';
import { withApiUser } from './session';

/**
 * The public API (/api/v1) for overlays and control apps. Every request carries
 * an API key; the key's user is who acts, so the site's own permission rules
 * decide what it may do. Nothing here grants anything the website would not.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * Run an API handler as the key's user. `write` handlers refuse read-only keys.
 * A key limited to one tournament is checked with `inTournament` by the handler.
 */
export async function apiRoute(
  request: Request,
  opts: { write?: boolean },
  handler: (ctx: { holder: KeyHolder; inTournament: (tournamentId: string) => void }) => Promise<Response>,
): Promise<Response> {
  const holder = await keyHolder(request);
  if (!holder) return json({ error: 'Send a valid API key: Authorization: Bearer bscs_…' }, 401);
  if (opts.write && !holder.key.canWrite) return json({ error: 'This key is read-only.' }, 403);
  const inTournament = (tournamentId: string) => {
    if (holder.key.tournamentId && holder.key.tournamentId !== tournamentId) {
      // Same answer as for something that does not exist: a scoped key learns nothing about other tournaments.
      throw new ApiError(404, 'Not found.');
    }
  };
  try {
    return await withApiUser(holder.user, () => handler({ holder, inTournament }));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * The site's actions report ordinary mistakes by redirecting back with ?error=
 * (see failBack) and success by redirecting onwards. Over the API both become JSON.
 */
export function redirectOutcome(err: unknown): { redirected: true; error: string | null; path: string } | null {
  const digest = (err as { digest?: unknown })?.digest;
  if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT')) return null;
  const url = new URL(digest.split(';')[2] ?? '', 'http://x');
  return { redirected: true, error: url.searchParams.get('error'), path: url.pathname };
}

/** Run a site action that ends in a redirect; resolves to the path it sent the browser to. */
export async function runRedirectingAction(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const r = redirectOutcome(err);
    if (!r) throw err;
    if (r.error) throw new ApiError(400, r.error);
    return r.path;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return json({ error: err.message }, err.status);
  const redirect = redirectOutcome(err);
  if (redirect) return redirect.error ? json({ error: redirect.error }, 400) : json({ ok: true });
  const message = err instanceof Error ? err.message : String(err);
  // The rules engine's refusals are 403s; anything else the action threw is a plain 400 with its message.
  const forbidden = (err as { name?: string })?.name === 'ForbiddenError';
  if (!forbidden) console.error('[api]', err);
  return json({ error: message || 'Something went wrong.' }, forbidden ? 403 : 400);
}

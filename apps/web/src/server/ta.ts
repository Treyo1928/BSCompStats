import { createHash, randomUUID } from 'node:crypto';
import { TA_KEYS, type TaCommandBody, type TaLinkState, type TaReply } from '@bscs/core/match';
import { getPublisher } from '@/lib/redis';

/**
 * The web app's side of the TournamentAssistant link.
 *
 * The worker holds the connection to TA. From here we read what it last said
 * (a snapshot in Redis) and send it the few things that need doing; nothing
 * in the web app talks to TA itself.
 */

/** What the worker sees right now, or null when it is not running or the link is off. */
export async function taState(tournamentId: string): Promise<TaLinkState | null> {
  try {
    const raw = await getPublisher().get(TA_KEYS.state(tournamentId));
    return raw ? (JSON.parse(raw) as TaLinkState) : null;
  } catch {
    return null;
  }
}

/** Changes when anything in the state worth redrawing a page for does. */
export function taStamp(state: TaLinkState | null): string {
  const { at: _at, ...rest } = state ?? { at: 0 };
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

/**
 * TA's Discord sign-in address, set to send the organiser back to `returnTo`
 * with their TA token. TA carries the return address in the `state` it signed,
 * after a comma - the same way its own web app does.
 */
export function taSignInUrl(authUrl: string, returnTo: string): string | null {
  try {
    const url = new URL(authUrl);
    const state = url.searchParams.get('state');
    if (!state) return null;
    url.searchParams.set('state', `${state},${returnTo}`);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Ask the worker to do something and wait for its answer. An unanswered
 * command means no worker is listening, which is its own message: the site
 * can run without one, TA cannot.
 */
export async function taCommand(tournamentId: string, body: TaCommandBody, waitMs = 20_000): Promise<TaReply> {
  const id = randomUUID();
  const redis = getPublisher();
  try {
    const listeners = await redis.publish(TA_KEYS.commands, JSON.stringify({ id, tournamentId, ...body }));
    if (listeners === 0) return { ok: false, error: NO_WORKER };
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      const raw = await redis.get(TA_KEYS.reply(id));
      if (raw) return JSON.parse(raw) as TaReply;
      await new Promise((r) => setTimeout(r, 120));
    }
    return { ok: false, error: 'TournamentAssistant took too long to answer. Look at the status here and try again.' };
  } catch {
    return { ok: false, error: 'The site could not reach its own message bus (Redis), so TournamentAssistant cannot be controlled right now.' };
  }
}

/** Tell the worker something changed, without waiting: a start was requested, a setting saved. */
export async function taPoke(tournamentId: string): Promise<void> {
  try {
    await getPublisher().publish(TA_KEYS.commands, JSON.stringify({ id: randomUUID(), tournamentId, type: 'poke' }));
  } catch {
    // The worker looks every couple of seconds anyway.
  }
}

const NO_WORKER =
  'The background worker is not running, and it is what talks to TournamentAssistant. Start it (the "worker" service) and try again.';

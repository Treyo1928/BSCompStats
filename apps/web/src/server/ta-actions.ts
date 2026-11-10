'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import { assertCan, TA_DEFAULT_HOST, TA_DEFAULT_PORT, type TaCommandBody } from '@bscs/core/match';
import { getActor } from './session';
import { failBack } from './form-errors';
import { taCommand } from './ta';

/**
 * Setting up and running a tournament's TournamentAssistant link, from the
 * tournament's TA page. Tournament admins only. Each action comes back to the
 * page with what it did or why it could not.
 */

async function staffOf(formData: FormData) {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { id: true, slug: true, name: true } });
  if (!tournament) throw new Error('No such tournament.');
  return { tournament, back: `/t/${tournament.slug}/ta` };
}

function done(back: string, saved: string): never {
  revalidatePath(back);
  redirect(`${back}?saved=${saved}`);
}

/**
 * After a change to the stored link: have the worker act on it now and wait until it has, so the page this
 * goes back to shows where things stand. No worker listening is not this action's failure; the page says so.
 */
async function applied(tournamentId: string): Promise<void> {
  await taCommand(tournamentId, { type: 'reconnect' }, 8000);
}

/** Run a worker command; a refusal goes back to the page as its error. */
async function run(tournamentId: string, back: string, body: TaCommandBody, saved: string): Promise<never> {
  const reply = await taCommand(tournamentId, body);
  if (!reply.ok) failBack(back, reply.error);
  done(back, saved);
}

/** A host as typed: "ta.example.com", "wss://ta.example.com:8676/", "ta.example.com:8676". */
function parseHost(raw: string): { host: string; port: number | null } | null {
  const cleaned = raw.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(cleaned);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : null;
  if (port != null && (port < 1 || port > 65535)) return null;
  return { host: match[1]!.toLowerCase(), port };
}

/** Which TA server, whether the link is on, and how songs are started. */
export async function saveTaLink(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  const typed = String(formData.get('host') ?? '').trim();
  const parsed = typed ? parseHost(typed) : { host: TA_DEFAULT_HOST, port: null };
  if (!parsed) failBack(back, `"${typed}" is not a server address. Use a name like ${TA_DEFAULT_HOST}.`);
  const portField = String(formData.get('port') ?? '').trim();
  const port = portField ? Number(portField) : (parsed.port ?? TA_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) failBack(back, `"${portField}" is not a port. TA's websocket port is ${TA_DEFAULT_PORT} unless your server was set up otherwise.`);

  const options = {
    disableFail: formData.get('disableFail') === 'on',
    disablePause: formData.get('disablePause') === 'on',
    showScoreboard: formData.get('showScoreboard') === 'on',
    autoClose: formData.get('autoClose') === 'on',
  };
  const enabled = formData.get('enabled') === 'on';
  const existing = await prisma.taLink.findUnique({ where: { tournamentId: tournament.id }, select: { host: true, port: true } });
  // A sign-in and a TA tournament belong to one server: on another they mean nothing.
  const moved = existing != null && (existing.host !== parsed.host || existing.port !== port);
  await prisma.taLink.upsert({
    where: { tournamentId: tournament.id },
    create: { tournamentId: tournament.id, host: parsed.host, port, enabled, options },
    update: {
      host: parsed.host,
      port,
      enabled,
      options,
      ...(moved ? { token: null, tokenName: null, tokenUserId: null, signedInBy: null, taTournamentId: null, taTournamentName: null } : {}),
    },
  });
  await applied(tournament.id);
  done(back, 'link');
}

/** Forget the TA sign-in. The TA tournament itself is untouched. */
export async function taSignOut(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  await prisma.taLink.update({
    where: { tournamentId: tournament.id },
    data: { token: null, tokenName: null, tokenUserId: null, signedInBy: null },
  });
  await applied(tournament.id);
  done(back, 'signedOut');
}

/** Take TournamentAssistant off this tournament altogether. */
export async function removeTaLink(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  await prisma.taLink.deleteMany({ where: { tournamentId: tournament.id } });
  await applied(tournament.id);
  done(back, 'removed');
}

/** Sign in with a token pasted in: a TA bot token, or (on a server without Discord sign-in) a person's. */
export async function taUseToken(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  const token = String(formData.get('token') ?? '').trim();
  if (token.split('.').length !== 3) failBack(back, 'That does not look like a TournamentAssistant token (three parts separated by dots).');
  await run(tournament.id, back, { type: 'adoptToken', token }, 'signedIn');
}

/** Use an existing TA tournament, or make one. */
export async function taChooseTournament(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  const guid = String(formData.get('guid') ?? '');
  if (guid === 'new' || !guid) {
    const name = String(formData.get('name') ?? '').trim() || tournament.name;
    await run(tournament.id, back, { type: 'createTournament', name }, 'tournament');
  }
  await run(tournament.id, back, { type: 'chooseTournament', guid }, 'tournament');
}

/** Stop using the chosen TA tournament (it is not deleted from TA). */
export async function taLeaveTournament(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  await prisma.taLink.update({ where: { tournamentId: tournament.id }, data: { taTournamentId: null, taTournamentName: null } });
  await taCommand(tournament.id, { type: 'reconnect' });
  done(back, 'tournament');
}

/** One of the TA tournament's own switches. */
export async function taSetting(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  const setting = String(formData.get('setting'));
  const on = formData.get('value') === 'on';
  if (setting === 'replayStreaming') await run(tournament.id, back, { type: 'setReplayStreaming', on }, 'setting');
  if (setting === 'allowMockClients') await run(tournament.id, back, { type: 'setAllowMockClients', on }, 'setting');
  if (setting === 'scoreUpdateFrequency') {
    const frames = Number(formData.get('frames'));
    if (!Number.isFinite(frames) || frames < 1) failBack(back, 'Give a number of frames, 1 or more (30 is about three times a second at 90 fps).');
    await run(tournament.id, back, { type: 'setScoreUpdateFrequency', frames }, 'setting');
  }
  failBack(back, 'Unknown setting.');
}

/** Send players back to the game's menu: everyone connected, or the ones ticked. */
export async function taReturnToMenu(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  const guids = formData.getAll('guid').map(String).filter(Boolean);
  if (!guids.length) failBack(back, 'Nobody to send back to the menu.');
  await run(tournament.id, back, { type: 'returnToMenu', guids }, 'menu');
}

const TA_ROLES = ['admin', 'coordinator', 'view_only'] as const;

/** Let someone into the TA tournament in TA's own app, by Discord id. */
export async function taAddUser(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  const discordId = String(formData.get('discordId') ?? '').trim();
  if (!/^\d{15,21}$/.test(discordId) && !/^[0-9a-f-]{36}$/i.test(discordId)) {
    failBack(back, 'Give a Discord user id (a long number: in Discord, right-click the person, Copy User ID) or a TA bot id.');
  }
  const role = TA_ROLES.find((r) => r === formData.get('role')) ?? 'coordinator';
  await run(tournament.id, back, { type: 'addAuthorizedUser', discordId, role }, 'people');
}

export async function taRemoveUser(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  await run(tournament.id, back, { type: 'removeAuthorizedUser', discordId: String(formData.get('discordId') ?? '') }, 'people');
}

/**
 * Give every admin of this tournament here the same standing in the TA
 * tournament, for those who signed in to this site with Discord (TA knows
 * people by their Discord id). They do not need it to run matches from this
 * site; it is for opening the tournament in TA's own app.
 */
export async function taSyncAdmins(formData: FormData): Promise<void> {
  const { tournament, back } = await staffOf(formData);
  const members = await prisma.tournamentMember.findMany({
    where: { tournamentId: tournament.id, role: { in: ['OWNER', 'ORGANIZER'] } },
    select: { user: { select: { name: true, accounts: { where: { provider: 'discord' }, select: { providerAccountId: true } } } } },
  });
  const ids = members.flatMap((m) => m.user.accounts.map((a) => a.providerAccountId));
  if (!ids.length) failBack(back, 'None of this tournament\'s admins signed in here with Discord, so there is nobody to add.');
  for (const discordId of ids) {
    const reply = await taCommand(tournament.id, { type: 'addAuthorizedUser', discordId, role: 'admin' });
    if (!reply.ok) failBack(back, reply.error);
  }
  done(back, 'people');
}

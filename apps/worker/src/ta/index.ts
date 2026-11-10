import { TA_KEYS, type TaCommand, type TaReply } from '@bscs/core/match';
import { prisma } from '@bscs/db';
import { createSubscriber, getPublisher } from '../bus.js';
import { log } from '../log.js';
import { TaSession, type LinkRow } from './session.js';

/**
 * TournamentAssistant, run from the site.
 *
 * Each tournament with a TA link (TaLink) gets one connection to its TA
 * server, held here for as long as the worker runs. The web app never talks
 * to TA: it stores what organisers ask for, reads what this publishes to
 * Redis, and sends the few things that need an answer as commands.
 */

const sessions = new Map<string, TaSession>();
const SYNC_MS = 5_000;
let timer: NodeJS.Timeout | null = null;
let subscriber: ReturnType<typeof createSubscriber> | null = null;
let syncing: Promise<void> | null = null;

const loadLinks = (): Promise<LinkRow[]> =>
  prisma.taLink.findMany({
    where: { enabled: true },
    select: {
      tournamentId: true,
      host: true,
      port: true,
      token: true,
      tokenName: true,
      taTournamentId: true,
      taTournamentName: true,
      options: true,
      tournament: { select: { name: true, slug: true } },
    },
  });

/** Make the open connections match the stored links: new ones opened, changed ones reopened, removed ones closed. */
async function sync(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const links = await loadLinks();
    const wanted = new Map(links.map((l) => [l.tournamentId, l]));
    for (const [id, session] of sessions) {
      const row = wanted.get(id);
      if (row && session.sameConnection(row)) {
        session.update(row);
        continue;
      }
      sessions.delete(id);
      await session.dispose();
    }
    for (const row of links) {
      if (!sessions.has(row.tournamentId)) sessions.set(row.tournamentId, new TaSession(row));
    }
  })().finally(() => (syncing = null));
  return syncing;
}

async function handle(cmd: TaCommand): Promise<TaReply> {
  // A command may be the first the worker hears of a link made a second ago.
  if (!sessions.has(cmd.tournamentId) || cmd.type === 'reconnect') await sync();
  const session = sessions.get(cmd.tournamentId);
  if (!session) return { ok: false, error: 'TournamentAssistant is not set up, or is switched off, for this tournament.' };
  return session.command(cmd);
}

export async function startTa(): Promise<void> {
  await sync().catch((err) => log.error('ta: could not load links', err));
  timer = setInterval(() => void sync().catch((err) => log.error('ta: could not load links', err)), SYNC_MS);

  subscriber = createSubscriber();
  await subscriber.subscribe(TA_KEYS.commands);
  subscriber.on('message', (_channel: string, raw: string) => {
    let cmd: TaCommand;
    try {
      cmd = JSON.parse(raw) as TaCommand;
    } catch {
      return;
    }
    if (!cmd?.id || !cmd.tournamentId || !cmd.type) return;
    void handle(cmd)
      .catch((err): TaReply => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .then((reply) => {
        if (cmd.type !== 'poke' || !reply.ok) {
          if (!reply.ok) log.warn(`ta: ${cmd.type} refused: ${reply.error}`);
        }
        return getPublisher().set(TA_KEYS.reply(cmd.id), JSON.stringify(reply), 'EX', 60);
      })
      .catch(() => {});
  });
  log.info(`ta: ${sessions.size} TournamentAssistant link(s)`);
}

export async function stopTa(): Promise<void> {
  if (timer) clearInterval(timer);
  await subscriber?.quit().catch(() => {});
  await Promise.all(
    [...sessions.values()].map((s) => s.dispose('The site was restarted while this map was being started or played. Restart the map, or type the scores in.')),
  );
  sessions.clear();
}

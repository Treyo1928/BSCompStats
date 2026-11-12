import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { prisma } from '@bscs/db';
import { can, parseTaOptions, TA_DEFAULT_HOST, TA_DEFAULT_PORT, TA_DIFFICULTIES, TA_DIFFICULTY_LABELS, TA_MODIFIERS, TA_MODIFIER_LABELS, type TaAuthorizedUser, type TaLinkState, type TaReplayPage, type TaRoom, type TaUser } from '@bscs/core/match';
import { Badge, Button, Field, FieldAction, FormError, PageHeader, Panel, inputClass } from '@/components/ui';
import { TaLive } from '@/components/ta-live';
import { env } from '@/lib/env';
import { getActorOrAnonymous } from '@/server/session';
import { taCommand, taSignInUrl, taStamp, taState } from '@/server/ta';
import {
  removeTaLink,
  saveTaLink,
  taAddUser,
  taChooseTournament,
  taLeaveTournament,
  taRemoveUser,
  taReturnToMenu,
  taSetting,
  taSignOut,
  taSyncAdmins,
  taUseToken,
  taSyncPlayers,
  taPlayerCommand,
  taDeleteTournament,
  taSetImage,
  taRoomLoad,
  taRoomPlay,
  taRoomEnd,
  taDeleteReplay,
} from '@/server/ta-actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'TournamentAssistant' };

const SAVED: Record<string, string> = {
  link: 'Saved.',
  signedIn: 'Signed in to TournamentAssistant.',
  signedOut: 'Signed out of TournamentAssistant.',
  tournament: 'TA tournament set.',
  setting: 'Saved in TournamentAssistant.',
  menu: 'Sent back to the menu.',
  people: 'Saved in TournamentAssistant.',
  playersOnly: 'Only this tournament\'s players and staff see it in game now. The roster has been given to TournamentAssistant.',
  playersSynced: 'TournamentAssistant\'s list of players matches the roster.',
  sent: 'Sent to the ticked players.',
  deleted: 'The TA tournament was deleted from TournamentAssistant.',
  removed: 'TournamentAssistant removed from this tournament.',
  image: 'Picture set. Players see it beside the tournament in game the next time their list loads.',
  imageRemoved: 'Picture removed.',
  roomLoading: 'The map is loading for the ticked players. Start the song once everyone has it.',
  roomPlaying: 'Song started.',
  roomClosed: 'Free room closed.',
  replayDeleted: 'Replay deleted.',
};

/**
 * TournamentAssistant for one tournament, run from the site: which TA server,
 * the sign-in, the TA tournament players join, who is connected right now and
 * who else may open it in TA. It replaces TA's own coordinator app for
 * everything a match night needs; maps themselves are started from each match's page.
 */
export default async function TaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; saved?: string; replays?: string }>;
}) {
  const { slug } = await params;
  const { error, saved, replays: replaysPage } = await searchParams;
  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      taModeDefault: true,
      taLink: { select: { enabled: true, host: true, port: true, token: true, tokenName: true, tokenUserId: true, signedInBy: true, taTournamentName: true, options: true } },
    },
  });
  if (!tournament) notFound();
  const actor = await getActorOrAnonymous(tournament.id);
  if (!can(actor, 'MANAGE_TOURNAMENT')) notFound();

  const link = tournament.taLink;
  const state = link?.enabled ? await taState(tournament.id) : null;
  const hidden = <input type="hidden" name="tournamentId" value={tournament.id} />;
  const header = (
    <PageHeader
      crumbs={[{ label: tournament.name, href: `/t/${slug}` }]}
      title="TournamentAssistant"
      meta="Start every map for all its players at once, straight from the match page, and get their scores back from the game. No separate TA app."
      actions={link ? <LinkBadge enabled={link.enabled} state={state} /> : undefined}
    />
  );

  if (!link) {
    return (
      <div className="space-y-6">
        {header}
        <FormError message={error} />
        {saved && SAVED[saved] && <p className="text-sm text-green-300">{SAVED[saved]}</p>}
        <Panel title="Connect this tournament to TournamentAssistant" subtitle="Three steps: pick the TA server, sign in once, choose the TA tournament your players join in game.">
          <form action={saveTaLink} className="space-y-3">
            {hidden}
            <input type="hidden" name="enabled" value="on" />
            <input type="hidden" name="disableFail" value="on" />
            <ServerFields host={TA_DEFAULT_HOST} port={TA_DEFAULT_PORT} />
            <Button type="submit">Connect</Button>
          </form>
        </Panel>
      </div>
    );
  }

  const options = parseTaOptions(link.options);
  const phase = state?.phase ?? 'off';
  const signInUrl = state?.authUrl ? taSignInUrl(state.authUrl, `${env.APP_URL.replace(/\/+$/, '')}/t/${slug}/ta/signed-in`) : null;
  const authorized = phase === 'ready' ? await taCommand(tournament.id, { type: 'listAuthorizedUsers' }, 6000) : null;
  const everyoneWithAccess = authorized?.ok ? ((authorized.data as TaAuthorizedUser[]) ?? []) : null;
  // Roster players the site put there (TA's player role and nothing else) are counted, not listed.
  const isRosterEntry = (u: TaAuthorizedUser) => u.roles.length === 1 && u.roles[0] === 'player';
  const people = everyoneWithAccess?.filter((u) => !isRosterEntry(u)) ?? null;
  const playerIds = everyoneWithAccess?.filter(isRosterEntry).length ?? 0;

  // What TA recorded, a page at a time.
  const recorded = phase === 'ready' && state?.tournament ? await taCommand(tournament.id, { type: 'listReplays', page: Math.max(1, Number(replaysPage) || 1) }, 6000) : null;
  const replays = recorded?.ok ? (recorded.data as TaReplayPage) : null;

  // Names for the maps in that list, where the site knows the map.
  const hashes = [...new Set((replays?.replays ?? []).map((r) => r.mapHash.toUpperCase()).filter(Boolean))];
  const known = hashes.length
    ? await prisma.beatMap.findMany({ where: { hash: { in: hashes.map((h) => h.toLowerCase()) } }, select: { hash: true, name: true } })
    : [];
  const mapNames = new Map(known.map((m) => [m.hash.toUpperCase(), m.name]));
  const when = (ms: number, time = true) =>
    ms > 0 ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', ...(time ? { hour: 'numeric', minute: '2-digit' } : { year: 'numeric' }), timeZone: 'UTC' }) + (time ? ' UTC' : '') : '';

  // Roster players, to show who has not connected yet.
  const roster =
    phase === 'ready'
      ? await prisma.teamMember.findMany({
          where: { team: { adHoc: false, division: { tournamentId: tournament.id } } },
          orderBy: [{ team: { name: 'asc' } }, { player: { name: 'asc' } }],
          select: { team: { select: { name: true } }, player: { select: { id: true, name: true, taPlatformId: true, beatLeaderId: true } } },
        })
      : [];
  const players = (state?.users ?? []).filter((u) => u.kind === 'player');
  const others = (state?.users ?? []).filter((u) => u.kind !== 'player');
  const here = new Set(players.map((u) => u.playerId).filter(Boolean));
  const absent = roster.filter((m) => !here.has(m.player.id));

  return (
    <div className="space-y-6">
      <TaLive slug={slug} stamp={taStamp(state)} />
      {header}
      <FormError message={error} />
      {saved && SAVED[saved] && <p className="text-sm text-green-300">{SAVED[saved]}</p>}

      {!link.enabled && (
        <Panel title="Switched off">
          <p className="text-sm text-muted">The link is off, so the site is not connected to TournamentAssistant. Turn it on under Server and song settings below.</p>
        </Panel>
      )}

      {link.enabled && !state && (
        <Panel title="Waiting for the worker">
          <p className="text-sm text-muted">
            The site&apos;s background worker is what talks to TournamentAssistant, and it has not reported in. If this stays for more than a few
            seconds, the worker is not running: start the <code>worker</code> service (<code>docker compose up -d worker</code>).
          </p>
        </Panel>
      )}

      {state && (phase === 'connecting' || phase === 'error') && (
        <Panel title={phase === 'error' ? 'Not connected' : 'Connecting'}>
          <p className={`text-sm ${phase === 'error' ? 'text-lose' : 'text-muted'}`}>
            {state.message ?? `Connecting to ${state.host}:${state.port}…`}
          </p>
          {phase === 'error' && <p className="mt-2 text-xs text-faint">It keeps trying every few seconds. Check the server address below if this does not clear.</p>}
        </Panel>
      )}

      {state && phase === 'signIn' && (
        <Panel title="Sign in to TournamentAssistant" subtitle={`Connected to ${state.host}. TA needs to know who is running this tournament.`}>
          <div className="space-y-4 text-sm">
            {state.message && <p className="text-warn">{state.message}</p>}
            {signInUrl ? (
              <div className="space-y-2">
                <a
                  href={signInUrl}
                  className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-surface hover:brightness-110"
                >
                  Sign in with Discord (through TA)
                </a>
                <p className="text-xs text-faint">
                  You go to Discord, approve TournamentAssistant, and come straight back here. The site then makes itself a TA bot of its own
                  (shown under Applications in TA&apos;s app, where you can revoke it) and keeps that, not your sign-in.
                </p>
              </div>
            ) : (
              <p className="text-muted">This TA server has no Discord sign-in of its own (a self-hosted or test server). Paste a token for it below.</p>
            )}
            <details className="rounded-lg border border-edge p-3" open={!signInUrl}>
              <summary className="cursor-pointer text-xs font-medium text-muted">Use a token instead</summary>
              <form action={taUseToken} className="mt-3 flex flex-wrap items-start gap-2">
                {hidden}
                <div className="min-w-64 flex-1">
                  <Field label="TA token" hint="A bot token from TA's app (Applications, Copy to Clipboard), or a token for your own TA server.">
                    <input name="token" required autoComplete="off" className={`${inputClass} font-mono text-xs`} placeholder="eyJ…" />
                  </Field>
                </div>
                <FieldAction>
                  <Button type="submit" variant="ghost">
                    Use this token
                  </Button>
                </FieldAction>
              </form>
            </details>
          </div>
        </Panel>
      )}

      {state && phase === 'noTournament' && (
        <Panel
          title="Choose the TA tournament"
          subtitle="The tournament your players pick inside the game (Mods, TournamentAssistant). Use one you already have, or let the site make one."
        >
          {state.message && <p className="mb-4 text-sm text-warn">{state.message}</p>}
          <div className="grid gap-6 text-sm md:grid-cols-2">
            <form action={taChooseTournament} className="space-y-3">
              {hidden}
              <input type="hidden" name="guid" value="new" />
              <Field label="Make a new TA tournament called" hint="Players look for this name in game. Live replay streaming is switched on for it.">
                <input name="name" defaultValue={tournament.name} maxLength={80} required className={inputClass} />
              </Field>
              <Button type="submit">Make it and use it</Button>
            </form>
            <form action={taChooseTournament} className="space-y-3">
              {hidden}
              <Field label="Or use an existing one" hint="Ones you are an admin of appear here just after you sign in with Discord.">
                <select name="guid" className={inputClass} required defaultValue="">
                  <option value="" disabled>
                    {state.tournaments.length ? 'Choose…' : 'None visible to this sign-in'}
                  </option>
                  {state.tournaments.map((t) => (
                    <option key={t.guid} value={t.guid}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" variant="ghost" disabled={!state.tournaments.length}>
                Use this one
              </Button>
            </form>
          </div>
        </Panel>
      )}

      {state && phase === 'ready' && state.tournament && (
        <>
          <Panel
            title={
              <>
                In game: <span className="text-accent">{state.tournament.name}</span>
              </>
            }
            subtitle={`Players open Mods, TournamentAssistant${state.host === TA_DEFAULT_HOST ? '' : `, add the server ${state.host}`}, and join this tournament. Then they wait; maps are started for them from each match's page.`}
            actions={
              <form action={taLeaveTournament}>
                {hidden}
                <Button type="submit" variant="ghost" className="h-8 text-xs" title="Stop using this TA tournament here. It is not deleted from TA.">
                  Use a different one
                </Button>
              </form>
            }
          >
            <form action={taSetImage} className="mb-4 flex flex-wrap items-center gap-3 border-b border-edge pb-4 text-sm">
              {hidden}
              {state.tournament.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/t/${slug}/ta/image?v=${encodeURIComponent(state.tournament.image.slice(-12))}`} alt="The TA tournament's picture" className="h-16 w-16 rounded-lg border border-edge object-cover" />
              ) : (
                <div className="grid h-16 w-16 place-items-center rounded-lg border border-dashed border-warn text-center text-[10px] leading-tight text-warn">no picture</div>
              )}
              <div className="min-w-56 flex-1">
                <Field
                  label="Picture in the game's tournament list"
                  hint={
                    state.tournament.image
                      ? 'PNG, JPEG or GIF, up to 1 MB. Square works best. Choosing a new one replaces it.'
                      : 'This TA tournament has no picture yet, so it shows blank in game. PNG, JPEG or GIF, up to 1 MB. Square works best.'
                  }
                >
                  <input type="file" name="image" accept="image/png,image/jpeg,image/gif" className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border file:border-edge-strong file:bg-transparent file:px-3 file:py-1.5 file:text-xs file:text-ink" />
                </Field>
              </div>
              <Button type="submit" variant="ghost">
                Set picture
              </Button>
              {state.tournament.image && (
                <button type="submit" name="remove" value="1" className="h-8 rounded-lg border border-edge-strong px-3 text-xs text-muted hover:border-faint hover:text-ink">
                  Remove
                </button>
              )}
            </form>
            <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
              <Toggle tournamentId={tournament.id} setting="replayStreaming" on={state.tournament.replayStreaming} label="Live replay streaming">
                Each player&apos;s game sends its replay to TA as they play, which is what the stream overlay draws. Needs TA 1.3 or newer in game.
              </Toggle>
              <Toggle tournamentId={tournament.id} setting="playersOnly" on={state.tournament.playersOnly} label="Only this tournament's players see it in game">
                Hides the TA tournament from everyone except the people on this site&apos;s Teams page (and its staff), and keeps TA&apos;s list of
                players in step with the roster. TA recognises a player by their TA id (Teams page), their BeatLeader id, which is the Steam
                id for Steam players, or their Discord id if they signed in here with Discord. A Quest player whose TA id is not set yet
                may not see the tournament: leave this off until everyone has joined once and shows as matched under &quot;Connected right
                now&quot;, or set their TA id first.
                {state.tournament.playersOnly ? ` TA holds ${playerIds} player id${playerIds === 1 ? '' : 's'} for the roster.` : ''}
              </Toggle>
              {state.tournament.playersOnly && (
                <form action={taSyncPlayers} className="flex items-start">
                  {hidden}
                  <Button type="submit" variant="ghost" className="h-8 text-xs" title="Happens by itself every couple of minutes; this does it now">
                    Give TA the roster now
                  </Button>
                </form>
              )}
              <Toggle tournamentId={tournament.id} setting="allowMockClients" on={state.tournament.allowMockClients} label="Allow mock players">
                Lets TA&apos;s fake test players join. For rehearsing without anyone in a headset; leave off on match day.
              </Toggle>
              <Toggle tournamentId={tournament.id} setting="showTournamentButton" on={state.tournament.showTournamentButton} label={'Show the "Tournament" button in game'}>
                The button players press to enter the tournament room, where the site loads maps for them.
              </Toggle>
              <Toggle tournamentId={tournament.id} setting="showQualifierButton" on={state.tournament.showQualifierButton} label={'Show the "Qualifier" button in game'}>
                Only useful with TA qualifiers. Qualifiers here run on BeatLeader, so leave it off.
              </Toggle>
              <Toggle tournamentId={tournament.id} setting="replayRecording" on={state.tournament.replayRecording} label="Record replays in TA">
                TA keeps a replay file of every song played in the tournament. They are listed at the bottom of this page.
              </Toggle>
              {state.tournament.replayRecording && (
                <form action={taSetting} className="flex items-start gap-2">
                  {hidden}
                  <input type="hidden" name="setting" value="replayRetention" />
                  <Field label="Keep recorded replays for">
                    <select name="retention" defaultValue={state.tournament.replayRetention} className={`${inputClass} w-32`}>
                      <option value="30d">30 days</option>
                      <option value="90d">90 days</option>
                      <option value="1y">1 year</option>
                      <option value="3y">3 years</option>
                    </select>
                  </Field>
                  <FieldAction>
                    <Button type="submit" variant="ghost">Save</Button>
                  </FieldAction>
                </form>
              )}
              <Toggle tournamentId={tournament.id} setting="enableTeams" on={state.tournament.enableTeams} label="TA teams">
                Makes every player pick one of TA&apos;s own teams on a screen in game when they join. Not needed: this site knows the teams.
              </Toggle>
              <Toggle tournamentId={tournament.id} setting="enablePools" on={state.tournament.enablePools} label="TA map pools">
                TA&apos;s own map pools are only a song list inside TA&apos;s coordinator app; players never see them in game. Not needed: maps are loaded from this site&apos;s pools.
              </Toggle>
              <form action={taSetting} className="flex items-start gap-2">
                {hidden}
                <input type="hidden" name="setting" value="name" />
                <Field label="Name in game" hint="What players look for in the game's tournament list.">
                  <input name="name" defaultValue={state.tournament.name} maxLength={80} required className={`${inputClass} w-64`} />
                </Field>
                <FieldAction>
                  <Button type="submit" variant="ghost">Rename</Button>
                </FieldAction>
              </form>
              <form action={taSetting} className="flex items-start gap-2">
                {hidden}
                <input type="hidden" name="setting" value="bannedMods" />
                <Field label="Banned mods" hint="Mod names, separated by commas. A player with one installed is told to remove it.">
                  <input name="mods" defaultValue={state.tournament.bannedMods.join(', ')} placeholder="IntroSkip, AutoPauseStealth" className={`${inputClass} w-72`} />
                </Field>
                <FieldAction>
                  <Button type="submit" variant="ghost">Save</Button>
                </FieldAction>
              </form>
              <form action={taSetting} className="flex items-start gap-2">
                {hidden}
                <input type="hidden" name="setting" value="scoreUpdateFrequency" />
                <Field label="Send live scores every" hint="Frames of the player's game. 30 is about 3 a second.">
                  <input name="frames" inputMode="numeric" defaultValue={state.tournament.scoreUpdateFrequency || 30} className={`${inputClass} w-24 tabular`} />
                </Field>
                <FieldAction>
                  <Button type="submit" variant="ghost">
                    Set
                  </Button>
                </FieldAction>
              </form>
            </div>
            {!tournament.taModeDefault && (
              <p className="mt-3 text-xs text-warn">
                New matches here do not run through TournamentAssistant by default. Tick &quot;Run matches through TournamentAssistant&quot; under
                Settings, Match rules, or tick it when you set a match up.
              </p>
            )}
          </Panel>

          <Panel
            title="Connected right now"
            subtitle={`${players.length} ${players.length === 1 ? 'player' : 'players'} in the TA tournament${absent.length ? `, ${absent.length} on the rosters not connected` : ''}`}
            flush
          >
            {players.length === 0 ? (
              <p className="p-4 text-sm text-muted">Nobody yet. Players appear here the moment they join the tournament in game.</p>
            ) : (
              <form action={taReturnToMenu}>
                {hidden}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-faint">
                      <th className="px-4 py-2 font-medium">Player in TA</th>
                      <th className="px-2 py-2 font-medium">On the roster as</th>
                      <th className="px-2 py-2 font-medium">Doing</th>
                      <th className="px-4 py-2 text-right font-medium">Tick</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((u) => (
                      <PlayerRow key={u.guid} user={u} rosterName={roster.find((m) => m.player.id === u.playerId)?.player.name ?? null} />
                    ))}
                  </tbody>
                </table>
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-edge px-4 py-2">
                  <span className="mr-auto text-xs text-faint">
                    For the ticked players. &quot;To menu&quot; pulls them out of a song or a loaded map; the rest change their game as it is
                    played (for a player on the wrong hand or colours, or a one-saber map).
                  </span>
                  {(
                    [
                      ['flipColors', 'Flip colours', 'Swap red and blue for these players'],
                      ['flipHands', 'Flip hands', 'Swap which hand holds which saber'],
                      ['disableBlueNotes', 'No blue notes', 'Hide the blue notes for these players'],
                      ['disableRedNotes', 'No red notes', 'Hide the red notes for these players'],
                    ] as const
                  ).map(([command, text, title]) => (
                    <button
                      key={command}
                      type="submit"
                      formAction={taPlayerCommand.bind(null, command)}
                      data-command={command}
                      title={title}
                      className="h-8 rounded-lg border border-edge-strong px-3 text-xs text-muted hover:border-faint hover:text-ink"
                    >
                      {text}
                    </button>
                  ))}
                  <Button type="submit" variant="ghost" className="h-8 text-xs">
                    Send ticked to menu
                  </Button>
                </div>
                <div className="flex flex-wrap items-end gap-2 border-t border-edge px-4 py-3">
                  <div className="min-w-56 flex-1">
                    <Field label="Free room: any map for the ticked players" hint="A BeatSaver key (2f4a1), a beatsaver.com link or a map hash. For warm-ups and map checks; nothing is written to a match.">
                      <input name="song" placeholder="2f4a1" className={`${inputClass} font-mono`} autoComplete="off" />
                    </Field>
                  </div>
                  <Field label="Difficulty">
                    <select name="difficulty" defaultValue="ExpertPlus" className={`${inputClass} w-32`}>
                      {TA_DIFFICULTIES.map((d) => (
                        <option key={d} value={d}>
                          {TA_DIFFICULTY_LABELS[d]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Mode">
                    <input name="characteristic" defaultValue="Standard" className={`${inputClass} w-32`} title="Standard, OneSaber, NoArrows, Lawless, 90Degree, 360Degree…" />
                  </Field>
                  <FieldAction>
                    <button type="submit" formAction={taRoomLoad} data-command="roomLoad" className="h-9 rounded-lg border border-edge-strong px-3 text-sm text-ink hover:border-faint">
                      Load for ticked players
                    </button>
                  </FieldAction>
                </div>
              </form>
            )}
            {absent.length > 0 && (
              <div className="border-t border-edge px-4 py-3 text-xs text-muted">
                <span className="font-medium text-faint">Not connected: </span>
                {absent.map((m, i) => (
                  <span key={`${m.team.name}-${m.player.id}`}>
                    {i > 0 && ', '}
                    {m.player.name} <span className="text-faint">({m.team.name})</span>
                  </span>
                ))}
                <p className="mt-1 text-faint">
                  Someone who is in game but listed here is connected under an id the site does not know: set their TA id on the Teams page
                  (it is the &quot;Player in TA&quot; id shown above for anyone not matched to the roster).
                </p>
              </div>
            )}
            {others.length > 0 && (
              <p className="border-t border-edge px-4 py-2 text-xs text-faint">
                Also connected (coordinators and overlays): {others.map((u) => u.name).join(', ')}
              </p>
            )}
          </Panel>

          {state.room && <RoomPanel room={state.room} hidden={hidden} />}

          <Panel
            title="Who else can open it in TA"
            subtitle="Nobody needs this to run matches from this site. It is for admins who also want the tournament in TA's own app."
            actions={
              <form action={taSyncAdmins}>
                {hidden}
                <Button type="submit" variant="ghost" className="h-8 text-xs" title="Adds every admin of this tournament who signed in here with Discord as an admin of the TA tournament">
                  Add this tournament&apos;s admins
                </Button>
              </form>
            }
          >
            {people == null ? (
              <p className="text-sm text-muted">{authorized && !authorized.ok ? authorized.error : 'Could not read the list.'}</p>
            ) : (
              <ul className="divide-y divide-edge text-sm">
                {people.map((p) => (
                  <li key={p.discordId} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="min-w-0 truncate font-medium">{p.name}</span>
                    <span className="font-mono text-[10px] text-faint">{p.discordId}</span>
                    {p.discordId === link.tokenUserId && <Badge tone="accent">this site</Badge>}
                    {p.roles.map((r) => (
                      <Badge key={r}>{r.replace('_', ' ')}</Badge>
                    ))}
                    {p.discordId !== link.tokenUserId && (
                      <form action={taRemoveUser} className="ml-auto">
                        {hidden}
                        <input type="hidden" name="discordId" value={p.discordId} />
                        <Button type="submit" variant="ghost" className="h-7 px-2 text-xs">
                          Remove
                        </Button>
                      </form>
                    )}
                  </li>
                ))}
                {people.length === 0 && <li className="py-1.5 text-muted">Only this site.</li>}
              </ul>
            )}
            <form action={taAddUser} className="mt-3 flex flex-wrap items-start gap-2 border-t border-edge pt-3">
              {hidden}
              <div className="min-w-56 flex-1">
                <Field label="Add by Discord user id" hint="In Discord: Settings, Advanced, Developer Mode on; then right-click the person, Copy User ID.">
                  <input name="discordId" required inputMode="numeric" className={`${inputClass} tabular`} placeholder="123456789012345678" />
                </Field>
              </div>
              <Field label="As">
                <select name="role" className={inputClass} defaultValue="coordinator">
                  <option value="admin">Admin</option>
                  <option value="coordinator">Coordinator</option>
                  <option value="player">Player (sees and joins it in game)</option>
                  <option value="view_only">View only</option>
                </select>
              </Field>
              <FieldAction>
                <Button type="submit" variant="ghost">
                  Add
                </Button>
              </FieldAction>
            </form>
          </Panel>
          <Panel
            title="Replays recorded in TA"
            subtitle={
              replays
                ? !replays.storage
                  ? 'This TA server keeps no replays'
                  : `${replays.total} kept${state.tournament.replayRecording ? '' : '; recording is switched off'}`
                : undefined
            }
            flush={!!replays?.replays.length}
          >
            {!replays ? (
              <p className="text-sm text-muted">{recorded && !recorded.ok ? recorded.error : 'Could not read the list.'}</p>
            ) : !replays.storage ? (
              <p className="text-sm text-muted">
                This TournamentAssistant server has no replay storage set up, so &quot;Record replays in TA&quot; has nowhere to put them. The
                public server has it; on a server of your own it is the <span className="font-mono">replayDatabaseUrl</span> setting.
              </p>
            ) : replays.replays.length === 0 ? (
              <p className="text-sm text-muted">
                None yet.{' '}
                {state.tournament.replayRecording
                  ? 'Every song played in the tournament from now on is kept here.'
                  : 'Switch on "Record replays in TA" above and every song played in the tournament is kept here.'}
              </p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-faint">
                      <th className="px-4 py-2 font-medium">Player</th>
                      <th className="px-2 py-2 font-medium">Map</th>
                      <th className="px-2 py-2 font-medium">Played</th>
                      <th className="px-2 py-2 font-medium">Kept until</th>
                      <th className="px-2 py-2 text-right font-medium">Size</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {replays.replays.map((r) => (
                      <tr key={r.guid} className="border-t border-edge">
                        <td className="px-4 py-1.5 font-medium">{r.playerName || r.platformId}</td>
                        <td className="px-2 py-1.5">
                          {mapNames.get(r.mapHash.toUpperCase()) ?? <span className="font-mono text-xs text-muted">{r.mapHash.slice(0, 10)}</span>}{' '}
                          <span className="text-xs text-faint">
                            {r.characteristic && r.characteristic !== 'Standard' ? `${r.characteristic} ` : ''}
                            {TA_DIFFICULTY_LABELS[TA_DIFFICULTIES[r.difficulty] ?? 'ExpertPlus']}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-muted">{when(r.recordedAt)}</td>
                        <td className="px-2 py-1.5 text-muted">{when(r.expiresAt, false)}</td>
                        <td className="px-2 py-1.5 text-right tabular text-muted">{r.size >= 1048576 ? `${(r.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(r.size / 1024))} KB`}</td>
                        <td className="px-4 py-1.5">
                          <div className="flex items-center justify-end gap-2">
                            <a href={`/t/${slug}/ta/replay/${r.guid}`} className="text-xs text-accent hover:underline" download>
                              Download
                            </a>
                            <form action={taDeleteReplay}>
                              {hidden}
                              <input type="hidden" name="guid" value={r.guid} />
                              <Button type="submit" variant="ghost" className="h-7 px-2 text-xs" title="Deletes it from TournamentAssistant for good">
                                Delete
                              </Button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {replays.total > replays.pageSize && (
                  <p className="flex items-center gap-3 border-t border-edge px-4 py-2 text-xs text-muted">
                    Page {replays.page} of {Math.ceil(replays.total / replays.pageSize)}
                    {replays.page > 1 && (
                      <a className="text-accent hover:underline" href={`/t/${slug}/ta?replays=${replays.page - 1}`}>
                        Newer
                      </a>
                    )}
                    {replays.page * replays.pageSize < replays.total && (
                      <a className="text-accent hover:underline" href={`/t/${slug}/ta?replays=${replays.page + 1}`}>
                        Older
                      </a>
                    )}
                  </p>
                )}
                <p className="border-t border-edge px-4 py-2 text-xs text-faint">
                  These are TA&apos;s own replay files (.tarf), which open in TA&apos;s replay tools. They are not BeatLeader replays.
                </p>
              </>
            )}
          </Panel>
        </>
      )}

      <Panel title="Server and song settings" subtitle={link.token ? `Signed in as ${link.tokenName ?? 'a saved token'}${link.signedInBy ? `, made by ${link.signedInBy}` : ''}` : 'Not signed in'}>
        <form action={saveTaLink} className="space-y-3 text-sm" key={`${link.host}|${link.port}|${link.enabled}|${JSON.stringify(options)}`}>
          {hidden}
          <ServerFields host={link.host} port={link.port} />
          <p className="-mt-1 text-xs text-faint">Changing the server signs the site out: a sign-in and a TA tournament belong to one server.</p>
          <fieldset className="space-y-2 border-t border-edge pt-3">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">When a song is started</legend>
            <Check name="disableFail" checked={options.disableFail}>
              Players cannot fail
              <Note>The song plays to the end whatever their energy, and the score is exactly what they hit. Off: a player who runs out of energy stops there with the score they had.</Note>
            </Check>
            <Check name="disablePause" checked={options.disablePause}>
              Players cannot pause
            </Check>
            <Check name="showScoreboard" checked={options.showScoreboard}>
              Show TA&apos;s in-game scoreboard
              <Note>Each player sees the others&apos; live scores in their headset.</Note>
            </Check>
          </fieldset>
          <fieldset className="space-y-2 border-t border-edge pt-3">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">Modifiers on every song</legend>
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {TA_MODIFIERS.map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="modifier" value={m} defaultChecked={options.modifiers.includes(m)} /> {TA_MODIFIER_LABELS[m]}
                </label>
              ))}
            </div>
            <p className="text-xs text-faint">
              Beat Saber&apos;s own modifiers, the same list TA&apos;s app has. Leave them all off for a normal match: a modifier changes the
              score a map can give, and this site works accuracy out against the map&apos;s normal maximum. Of the speed ones, and of No
              Fail / One Life / Four Lives, only one is kept.
            </p>
            <Check name="disableScoresaberSubmission" checked={options.disableScoresaberSubmission}>
              Do not submit these scores to ScoreSaber
            </Check>
            <Check name="disableCustomNotesOnStream" checked={options.disableCustomNotesOnStream}>
              Switch off players&apos; custom notes
              <Note>Everyone plays with the normal notes, so the stream shows the same thing for every player.</Note>
            </Check>
          </fieldset>
          <fieldset className="space-y-2 border-t border-edge pt-3">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">When a song ends</legend>
            <Check name="autoClose" checked={options.autoClose}>
              Close the map by itself
              <Note>When every player&apos;s score came in from TA the map is closed and counted straight away. If someone left the song or dropped off TA it stays open for you to sort out. A closed map can be reopened on the match page.</Note>
            </Check>
          </fieldset>
          <fieldset className="space-y-2 border-t border-edge pt-3">
            <Check name="enabled" checked={link.enabled}>
              Link switched on
              <Note>Off: the site disconnects from TA and keeps these settings.</Note>
            </Check>
          </fieldset>
          <Button type="submit">Save</Button>
        </form>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-edge pt-3">
          {link.token && (
            <form action={taSignOut}>
              {hidden}
              <Button type="submit" variant="ghost" className="h-8 text-xs" title="Forget the TA sign-in. The TA tournament is untouched.">
                Sign out of TA
              </Button>
            </form>
          )}
          <form action={removeTaLink}>
            {hidden}
            <Button type="submit" variant="ghost" className="h-8 text-xs" title="Take TournamentAssistant off this tournament. Nothing is deleted from TA.">
              Remove TournamentAssistant from this tournament
            </Button>
          </form>
        </div>
        {phase === 'ready' && state?.tournament && (
          <details className="mt-4 border-t border-edge pt-3 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">Delete the TA tournament</summary>
            <form action={taDeleteTournament} className="mt-3 flex flex-wrap items-end gap-2">
              {hidden}
              <Field
                label={`Type "${state.tournament.name}" to delete it from TournamentAssistant`}
                hint="TA's End Tournament: it is gone from TA for everyone, with its settings and who had access. Nothing on this site is deleted; you can make or choose another TA tournament afterwards."
              >
                <input name="confirm" autoComplete="off" className={`${inputClass} w-72`} />
              </Field>
              <FieldAction>
                <Button type="submit" variant="danger">Delete from TA</Button>
              </FieldAction>
            </form>
          </details>
        )}
      </Panel>
    </div>
  );
}

function LinkBadge({ enabled, state }: { enabled: boolean; state: TaLinkState | null }) {
  if (!enabled) return <Badge>Off</Badge>;
  if (!state) return <Badge tone="warn">Worker not reporting</Badge>;
  switch (state.phase) {
    case 'ready':
      return <Badge tone="win">Connected</Badge>;
    case 'signIn':
      return <Badge tone="warn">Sign-in needed</Badge>;
    case 'noTournament':
      return <Badge tone="warn">No TA tournament chosen</Badge>;
    case 'error':
      return <Badge tone="lose">Not connected</Badge>;
    default:
      return <Badge>Connecting</Badge>;
  }
}

function ServerFields({ host, port }: { host: string; port: number }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-64 flex-1">
        <Field label="TA server" hint={`${TA_DEFAULT_HOST} is TA's public server, the one the game lists by default. Your own server: its address.`}>
          <input name="host" defaultValue={host} required className={inputClass} />
        </Field>
      </div>
      <Field label="Websocket port" hint={`${TA_DEFAULT_PORT} unless the server says otherwise.`}>
        <input name="port" inputMode="numeric" defaultValue={port} className={`${inputClass} w-28 tabular`} />
      </Field>
    </div>
  );
}

const ROOM_STATES: Record<string, string> = {
  loading: 'Fetching the map',
  ready: 'Ready',
  playing: 'Playing',
  finished: 'Finished',
  failed: 'Finished, ran out of health',
  quit: 'Quit',
  missing: 'Left TA',
};

/** The free room: what is loaded, for whom, and their scores as they come. */
function RoomPanel({ room, hidden }: { room: TaRoom; hidden: React.ReactNode }) {
  const scored = room.phase === 'playing' || room.phase === 'finished';
  const order = scored ? [...room.players].sort((a, b) => b.score - a.score) : room.players;
  return (
    <Panel
      title={
        <>
          Free room: <span className="text-accent">{room.song.name}</span>
        </>
      }
      subtitle={`${room.song.characteristic === 'Standard' ? '' : `${room.song.characteristic} `}${TA_DIFFICULTY_LABELS[room.song.difficulty]}${room.song.mapper ? `, mapped by ${room.song.mapper}` : ''}${room.song.key ? `, key ${room.song.key}` : ''}. ${
        room.phase === 'loading'
          ? 'Loading for the players.'
          : room.phase === 'ready'
            ? 'Everyone has the map.'
            : room.phase === 'playing'
              ? 'Being played.'
              : room.phase === 'finished'
                ? 'Finished.'
                : 'Did not load.'
      } Played with the song settings below.`}
      actions={
        <div className="flex gap-2">
          {(room.phase === 'ready' || room.phase === 'finished') && (
            <form action={taRoomPlay}>
              {hidden}
              <Button type="submit" className="h-8 text-xs">
                {room.phase === 'finished' ? 'Play it again' : 'Start song'}
              </Button>
            </form>
          )}
          <form action={taRoomEnd}>
            {hidden}
            <Button type="submit" variant="ghost" className="h-8 text-xs" title="Sends the players back to waiting and closes the room">
              Close the room
            </Button>
          </form>
        </div>
      }
      flush
    >
      {room.message && <p className="px-4 pt-3 text-sm text-warn">{room.message}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-faint">
            <th className="px-4 py-2 font-medium">Player</th>
            <th className="px-2 py-2 font-medium">Doing</th>
            <th className="px-2 py-2 text-right font-medium">Score</th>
            <th className="px-2 py-2 text-right font-medium">Accuracy</th>
            <th className="px-4 py-2 text-right font-medium">Misses</th>
          </tr>
        </thead>
        <tbody>
          {order.map((p) => (
            <tr key={p.guid} className="border-t border-edge">
              <td className="px-4 py-1.5 font-medium">{p.name}</td>
              <td className={`px-2 py-1.5 ${p.state === 'quit' || p.state === 'missing' ? 'text-lose' : 'text-muted'}`}>{ROOM_STATES[p.state] ?? p.state}</td>
              <td className="px-2 py-1.5 text-right tabular">{scored && p.state !== 'quit' ? p.score.toLocaleString('en-US') : ''}</td>
              <td className="px-2 py-1.5 text-right tabular">{scored && p.state !== 'quit' ? `${(p.accuracy * 100).toFixed(2)}%` : ''}</td>
              <td className="px-4 py-1.5 text-right tabular text-muted">{scored && p.state !== 'quit' ? p.misses : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function PlayerRow({ user, rosterName }: { user: TaUser; rosterName: string | null }) {
  const doing =
    user.playState === 'inGame'
      ? 'In a song'
      : user.downloadState === 'downloading'
        ? 'Downloading a map'
        : user.downloadState === 'error'
          ? 'Map download failed'
          : user.downloadState === 'downloaded'
            ? 'Map loaded, waiting'
            : user.playState === 'waiting'
              ? 'Waiting'
              : 'In the menu';
  return (
    <tr className="border-t border-edge">
      <td className="px-4 py-1.5">
        <span className="font-medium">{user.name}</span>
        {user.isMock && (
          <span className="ml-1.5">
            <Badge tone="warn">mock</Badge>
          </span>
        )}
        <span className="block font-mono text-[10px] text-faint">{user.platformId}</span>
      </td>
      <td className="px-2 py-1.5">{rosterName ?? <span className="text-warn">not matched to anyone</span>}</td>
      <td className={`px-2 py-1.5 ${user.downloadState === 'error' ? 'text-lose' : 'text-muted'}`}>{doing}</td>
      <td className="px-4 py-1.5 text-right">
        <input type="checkbox" name="guid" value={user.guid} aria-label={`Tick ${user.name}`} />
      </td>
    </tr>
  );
}

function Toggle({
  tournamentId,
  setting,
  on,
  label,
  children,
}: {
  tournamentId: string;
  setting: string;
  on: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <form action={taSetting} className="max-w-xs space-y-1">
      <input type="hidden" name="tournamentId" value={tournamentId} />
      <input type="hidden" name="setting" value={setting} />
      {!on && <input type="hidden" name="value" value="on" />}
      <div className="flex items-center gap-2">
        <span className="font-medium">{label}</span>
        <Badge tone={on ? 'win' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>
        <Button type="submit" variant="ghost" className="h-7 px-2 text-xs">
          Turn {on ? 'off' : 'on'}
        </Button>
      </div>
      <p className="text-xs text-faint">{children}</p>
    </form>
  );
}

function Check({ name, checked, children }: { name: string; checked: boolean; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-1" />
      <span>{children}</span>
    </label>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <span className="block text-xs text-faint">{children}</span>;
}

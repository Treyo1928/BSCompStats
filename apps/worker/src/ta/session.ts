import {
  DEFAULT_TA_OPTIONS,
  TA_DEFAULT_HOST,
  TA_DIFFICULTIES,
  TA_KEYS,
  TA_STATE_TTL_SECONDS,
  parseTaOptions,
  type TaAuthorizedUser,
  type TaCommand,
  type TaLinkPhase,
  type TaLinkState,
  type TaOptions,
  type TaReplay,
  type TaReplayPage,
  type TaReply,
  type TaUser,
} from '@bscs/core/match';
import { prisma } from '@bscs/db';
import {
  ReplayRetention,
  Response_ResponseType,
  TAClient,
  User_ClientTypes,
  User_DownloadStates,
  User_PlayStates,
  type Tournament,
  type User,
} from 'moons-ta-client';
import { getPublisher } from '../bus.js';
import { log } from '../log.js';
import { FreeRoom } from './room.js';
import { MapRuns } from './runs.js';

/** The stored half of a link: what an organiser set, and the sign-in. */
export interface LinkRow {
  tournamentId: string;
  host: string;
  port: number;
  token: string | null;
  tokenName: string | null;
  taTournamentId: string | null;
  taTournamentName: string | null;
  options: unknown;
  tournament: { name: string; slug: string };
}

const RETRY_MS = 5_000;
/** How long a person's own TA sign-in is kept in memory after they sign in, to finish setting up with. */
const SETUP_MS = 30 * 60_000;

const ok = (r: { type: Response_ResponseType }) => r.type === Response_ResponseType.Success;
const RETENTION_VALUES = { '30d': ReplayRetention.ThirtyDays, '90d': ReplayRetention.NinetyDays, '1y': ReplayRetention.OneYear, '3y': ReplayRetention.ThreeYears } as const;
const RETENTION_NAMES: Record<number, '30d' | '90d' | '1y' | '3y'> = {
  [ReplayRetention.ThirtyDays]: '30d', [ReplayRetention.NinetyDays]: '90d', [ReplayRetention.OneYear]: '1y', [ReplayRetention.ThreeYears]: '3y',
};

/** What a TA token says about who it is, without trusting it: TA checks the signature, we only read the name. */
export function readTaToken(token: string): { id: string; name: string; isBot: boolean; expiresAt: number | null } | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const id = String(claims['ta:discord_id'] ?? '');
    if (!id) return null;
    return {
      id,
      name: String(claims['ta:discord_name'] ?? ''),
      // A bot's "Discord id" is a guid TA made up for it.
      isBot: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      expiresAt: Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : null,
    };
  } catch {
    return null;
  }
}

/**
 * One tournament's connection to its TA server.
 *
 * Signs in with the stored token, joins the chosen TA tournament, keeps the
 * list of who is connected, and publishes all of that to Redis whenever it
 * changes so the site can show it. Starting maps is MapRuns' job; this is the
 * connection it does it over.
 */
export class TaSession {
  readonly tournamentId: string;
  ta = new TAClient();
  /** The TA tournament we are in; empty until joined. */
  taTournament = '';
  options: TaOptions = DEFAULT_TA_OPTIONS;
  readonly runs: MapRuns;
  readonly room: FreeRoom;
  /** Recorded replays as last listed: where each downloads from. */
  private replayFiles = new Map<string, { url: string; fileName: string }>();

  private row: LinkRow;
  private phase: TaLinkPhase = 'connecting';
  private message: string | null = null;
  private authUrl: string | null = null;
  private disposed = false;
  /** Asking TA for the first thing with the saved sign-in: a hang-up now means the sign-in was refused. */
  private entering = false;
  private retry: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout;
  private lastPublished = '';
  private publishing: Promise<void> = Promise.resolve();
  /** Roster players by the ids TA might know them by. */
  private roster: { at: number; byId: Map<string, string>; byName: Map<string, string> } = { at: 0, byId: new Map(), byName: new Map() };
  /** The person who just signed in, connected as themselves: used to give our bot rights in their tournament. */
  private setup: { client: TAClient; discordId: string; name: string; until: number } | null = null;

  constructor(row: LinkRow) {
    this.row = row;
    this.tournamentId = row.tournamentId;
    this.options = parseTaOptions(row.options);
    this.runs = new MapRuns(this);
    this.room = new FreeRoom(this);
    // The state key expires by itself; refresh it while we are alive.
    this.keepAlive = setInterval(() => void this.publish(true), (TA_STATE_TTL_SECONDS * 1000) / 3);
    void this.connect();
  }

  /** True when this session was made for the same server and sign-in as `row`. */
  sameConnection(row: LinkRow): boolean {
    return row.host === this.row.host && row.port === this.row.port && row.token === this.row.token;
  }

  /** Settings that do not need a new connection. */
  update(row: LinkRow): void {
    const tournamentChanged = row.taTournamentId !== this.row.taTournamentId;
    this.row = row;
    this.options = parseTaOptions(row.options);
    if (tournamentChanged && this.ta.isConnected) void this.enterTournament();
  }

  get ready(): boolean {
    return this.phase === 'ready' && this.ta.isConnected && this.taTournament !== '';
  }

  get slug(): string {
    return this.row.tournament.slug;
  }

  users(): User[] {
    return this.taTournament ? (this.ta.stateManager.getUsers(this.taTournament) ?? []) : [];
  }

  /** Close the connection. `reason` is what a map that was being started or played is left saying. */
  async dispose(reason = 'The TournamentAssistant link was switched off or changed. Restart the map once it is connected again.'): Promise<void> {
    this.disposed = true;
    clearInterval(this.keepAlive);
    if (this.retry) clearTimeout(this.retry);
    await this.runs.abandon(reason);
    this.runs.stop();
    await this.room.close().catch(() => {});
    this.dropSetup();
    this.ta.disconnect();
    await getPublisher().del(TA_KEYS.state(this.tournamentId)).catch(() => {});
  }

  // -------------------------------------------------------------------------
  //  Connecting and signing in
  // -------------------------------------------------------------------------

  private set(phase: TaLinkPhase, message: string | null = null): void {
    this.phase = phase;
    this.message = message;
    void this.publish();
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, RETRY_MS);
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    this.ta.disconnect();
    this.taTournament = '';
    this.authUrl = null;
    const ta = (this.ta = new TAClient());
    this.room.drop();
    // Pictures are uploaded to the server's own API. The client library only knows the public server's.
    (ta as unknown as { _imageServer: string })._imageServer = this.apiBase();
    this.set('connecting');
    ta.setAuthToken(this.row.token ?? '');

    ta.on('disconnectedFromServer', () => {
      if (this.disposed || this.ta !== ta) return;
      if (!this.row.token) {
        // Not signed in, and the server hung up when asked how to sign in: it has no Discord sign-in of its own
        // (a self-hosted or test server). Nothing to do until someone gives us a token; no point reconnecting.
        this.authUrl = null;
        this.set('signIn');
        return;
      }
      if (this.entering) {
        // Signed in with a saved token, and the server hung up on the first thing asked with it: on a server
        // without Discord sign-in that is how a refused (expired, revoked) token shows.
        this.authUrl = null;
        this.set('signIn', 'TournamentAssistant did not accept the saved sign-in (it may have expired or been revoked). Sign in again.');
        return;
      }
      log.warn(`ta[${this.slug}]: lost ${this.row.host}, reconnecting`);
      this.taTournament = '';
      void this.runs.abandon('The connection to TournamentAssistant dropped. Restart the map once it is back.');
      this.room.drop();
      this.set('connecting', 'The connection to TournamentAssistant dropped; reconnecting.');
      this.scheduleRetry();
    });
    // TA answers a request it will not take from this sign-in with "go and sign in with Discord".
    ta.on('authorizationRequestedFromServer', (url) => {
      if (this.ta !== ta) return;
      this.authUrl = url;
      this.taTournament = '';
      this.set('signIn', this.row.token ? 'TournamentAssistant no longer accepts the saved sign-in. Sign in again.' : null);
    });
    const changed = () => void this.publish();
    for (const event of ['userConnected', 'userUpdated', 'userDisconnected', 'tournamentCreated', 'tournamentUpdated', 'tournamentDeleted'] as const) {
      ta.stateManager.on(event, changed);
    }
    ta.stateManager.on('userDisconnected', () => this.runs.poke());
    ta.stateManager.on('userConnected', () => this.runs.poke());
    ta.stateManager.on('userUpdated', () => this.runs.userChanged());
    ta.on('realtimeScore', (score) => {
      this.runs.onScore(score);
      this.room.onScore(score);
    });
    ta.on('songFinished', (finished) => {
      this.runs.onFinished(finished);
      this.room.onFinished(finished);
    });

    try {
      const response = await ta.connect(this.row.host, String(this.row.port));
      if (this.ta !== ta || this.disposed) return;
      if (!ok(response)) {
        const reason = response.details.oneofKind === 'connect' ? response.details.connect.message : '';
        this.set('error', `TournamentAssistant at ${this.row.host} refused the connection${reason ? `: ${reason}` : '.'} The site and the TA server may be on different TA versions.`);
        this.scheduleRetry();
        return;
      }
    } catch (err) {
      if (this.ta !== ta || this.disposed) return;
      // TA refused the saved token on the connect request itself: the handler above has already asked for a
      // fresh sign-in, and the client's connect then only ever times out. Retrying would just be refused again.
      if (this.phase === 'signIn') return;
      this.set('error', `Could not reach TournamentAssistant at ${this.row.host}:${this.row.port} (${err instanceof Error ? err.message : String(err)}).`);
      this.scheduleRetry();
      return;
    }
    log.info(`ta[${this.slug}]: connected to ${this.row.host}:${this.row.port}`);

    if (!this.row.token) {
      // Ask for something only a signed-in user may have; TA replies with its Discord sign-in address.
      this.set('signIn');
      await ta.getBotTokensForUser('0').catch(() => {});
      return;
    }
    await this.enterTournament();
  }

  /** Join the chosen TA tournament (finding or making it by name where only a name is set). */
  private async enterTournament(): Promise<void> {
    const ta = this.ta;
    this.taTournament = '';
    this.entering = true;
    try {
      let guid = this.row.taTournamentId;
      if (!guid && this.row.taTournamentName) {
        // Set up by name (the test stack does this): use the tournament of that name, or make it.
        const found = ta.stateManager.getTournaments().find((t) => t.settings?.tournamentName === this.row.taTournamentName);
        guid = found?.guid ?? (await this.createTournament(this.row.taTournamentName));
        if (this.ta !== ta) return;
        await prisma.taLink.update({ where: { tournamentId: this.tournamentId }, data: { taTournamentId: guid } });
        this.row = { ...this.row, taTournamentId: guid };
      }
      if (!guid) {
        // Still check the sign-in works, so a bad token shows now and not when a map is started: ask for
        // something any signed-in user may have (their own bot tokens). Not waited on for long; TA is slow to
        // answer some sign-ins here, and only a refusal (handled where it arrives) matters.
        const me = this.row.token ? readTaToken(this.row.token)?.id : null;
        await Promise.race([ta.getBotTokensForUser(me ?? '0'), new Promise((r) => setTimeout(r, 2500))]);
        if (this.ta === ta && this.phase !== 'signIn') this.set('noTournament');
        return;
      }
      const joined = await ta.joinTournament(guid);
      if (this.ta !== ta || this.phase === 'signIn') return;
      if (!ok(joined)) {
        const why = joined.details.oneofKind === 'join' ? joined.details.join.message : '';
        // Back to choosing: the list is offered again, with why the last choice did not work.
        this.set(
          'noTournament',
          `Could not join the TA tournament${this.row.taTournamentName ? ` "${this.row.taTournamentName}"` : ''}${why ? `: ${why}` : '.'} ` +
            'It may have been deleted, or this sign-in is not one of its admins. Choose it again (just after signing in with Discord, so the site can be given access), or another.',
        );
        return;
      }
      this.taTournament = guid;
      const name = this.tournamentOf(guid)?.settings?.tournamentName ?? this.row.taTournamentName;
      if (name && name !== this.row.taTournamentName) {
        await prisma.taLink.update({ where: { tournamentId: this.tournamentId }, data: { taTournamentName: name } });
        this.row = { ...this.row, taTournamentName: name };
      }
      log.info(`ta[${this.slug}]: in TA tournament "${name}"`);
      this.set('ready');
      this.runs.poke();
    } catch (err) {
      // A rejected request here is TA asking for a sign-in; the handler above has already said so.
      if (this.ta === ta && this.phase !== 'signIn') {
        this.set('error', `TournamentAssistant did not answer: ${err instanceof Error ? err.message : String(err)}`);
        this.scheduleRetry();
      }
    } finally {
      if (this.ta === ta) this.entering = false;
    }
  }

  /**
   * The TA server's web API (pictures, replay downloads). TA serves it two ports above the websocket: 8678 beside
   * 8676 on the public server and on a server set up the standard way.
   */
  private apiBase(): string {
    return this.row.host === TA_DEFAULT_HOST ? `https://${TA_DEFAULT_HOST}:8678` : `https://${this.row.host}:${this.row.port + 2}`;
  }

  private tournamentOf(guid: string): Tournament | undefined {
    return this.ta.stateManager.getTournament(guid);
  }

  private dropSetup(): void {
    this.setup?.client.disconnect();
    this.setup = null;
  }

  private liveSetup() {
    if (this.setup && this.setup.until < Date.now()) this.dropSetup();
    return this.setup?.client.isConnected ? this.setup : null;
  }

  // -------------------------------------------------------------------------
  //  What the site sees
  // -------------------------------------------------------------------------

  private async rosterIds(): Promise<typeof this.roster> {
    if (Date.now() - this.roster.at < 10_000) return this.roster;
    const members = await prisma.teamMember.findMany({
      where: { team: { division: { tournamentId: this.tournamentId } } },
      select: { player: { select: { id: true, name: true, beatLeaderId: true, taPlatformId: true } } },
    });
    const byId = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const { player } of members) {
      // The TA id an organiser set wins over the BeatLeader id (they differ for Quest players).
      if (!byId.has(player.beatLeaderId)) byId.set(player.beatLeaderId, player.id);
      byName.set(player.name.trim().toLowerCase(), player.id);
    }
    for (const { player } of members) if (player.taPlatformId) byId.set(player.taPlatformId, player.id);
    this.roster = { at: Date.now(), byId, byName };
    return this.roster;
  }

  private async state(): Promise<TaLinkState> {
    const ta = this.ta;
    const signedIn = this.row.token ? readTaToken(this.row.token) : null;
    const roster = await this.rosterIds().catch(() => this.roster);
    const tournament = this.taTournament ? this.tournamentOf(this.taTournament) : undefined;
    // A hidden tournament's players are whoever is on the roster now: a player added since, or one whose TA id was
    // just set, is passed on within a couple of minutes without anyone pressing a button.
    if (this.phase === 'ready' && tournament && tournament.settings?.allowUnauthorizedView === false && Date.now() - this.playersSyncedAt > 120_000) {
      this.playersSyncedAt = Date.now();
      void this.syncPlayers().catch((err) => log.warn(`ta[${this.slug}]: could not bring TA's players in step with the roster`, err));
    }
    const users: TaUser[] = (tournament ? this.users() : [])
      .filter((u) => u.guid !== ta.stateManager.getSelfGuid())
      .map((u) => ({
        guid: u.guid,
        name: u.name || u.discordInfo?.username || 'Unnamed',
        platformId: u.platformId,
        kind: u.clientType === User_ClientTypes.Player ? ('player' as const) : ('coordinator' as const),
        playState:
          u.playState === User_PlayStates.InGame ? ('inGame' as const) : u.playState === User_PlayStates.WaitingForCoordinator ? ('waiting' as const) : ('menu' as const),
        downloadState:
          u.downloadState === User_DownloadStates.Downloading
            ? ('downloading' as const)
            : u.downloadState === User_DownloadStates.Downloaded
              ? ('downloaded' as const)
              : u.downloadState === User_DownloadStates.DownloadError
                ? ('error' as const)
                : ('none' as const),
        mods: u.modList ?? [],
        playerId:
          u.clientType === User_ClientTypes.Player
            ? (roster.byId.get(u.platformId) ?? roster.byName.get(u.name.trim().toLowerCase()) ?? null)
            : null,
        isMock: u.isMock,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind) * -1 || a.name.localeCompare(b.name));

    // The tournaments on offer: what our own sign-in can see, plus what the person who just signed in can.
    const listed = new Map<string, { guid: string; name: string; users: number }>();
    for (const client of [this.liveSetup()?.client, ta]) {
      for (const t of client?.isConnected ? client.stateManager.getTournaments() : []) {
        listed.set(t.guid, { guid: t.guid, name: t.settings?.tournamentName ?? 'Unnamed', users: t.users.length });
      }
    }

    return {
      tournamentId: this.tournamentId,
      phase: this.phase,
      message: this.message,
      host: this.row.host,
      port: this.row.port,
      signedInAs: this.row.token ? this.row.tokenName || signedIn?.name || 'a saved token' : null,
      authUrl: this.phase === 'signIn' ? this.authUrl : null,
      tournaments: [...listed.values()].sort((a, b) => a.name.localeCompare(b.name)),
      tournament: tournament
        ? {
            guid: tournament.guid,
            name: tournament.settings?.tournamentName ?? 'Unnamed',
            users: users.length,
            replayStreaming: tournament.settings?.enableReplayStreaming ?? false,
            allowMockClients: tournament.settings?.allowMockClients ?? false,
            playersOnly: !(tournament.settings?.allowUnauthorizedView ?? true),
            showTournamentButton: tournament.settings?.showTournamentButton ?? true,
            showQualifierButton: tournament.settings?.showQualifierButton ?? false,
            enableTeams: tournament.settings?.enableTeams ?? false,
            enablePools: tournament.settings?.enablePools ?? false,
            replayRecording: tournament.settings?.enableReplayRecording ?? false,
            replayRetention: RETENTION_NAMES[tournament.settings?.replayRetention ?? ReplayRetention.ThirtyDays] ?? '30d',
            bannedMods: tournament.settings?.bannedMods ?? [],
            scoreUpdateFrequency: tournament.settings?.scoreUpdateFrequency ?? 0,
            permissions: tournament.settings?.myPermissions ?? [],
            image: tournament.settings?.tournamentImage ? `${this.apiBase()}/api/file/${encodeURIComponent(tournament.settings.tournamentImage)}` : null,
          }
        : null,
      users,
      room: tournament ? this.room.view() : null,
      at: Date.now(),
    };
  }

  /**
   * Write the state to Redis. `refresh` rewrites it unchanged, to keep it from expiring.
   * One at a time, in order, so an older picture can never land on top of a newer one.
   */
  publish(refresh = false): Promise<void> {
    this.publishing = this.publishing.then(() => this.writeState(refresh));
    return this.publishing;
  }

  private async writeState(refresh: boolean): Promise<void> {
    if (this.disposed) return;
    try {
      const state = await this.state();
      const { at: _at, ...rest } = state;
      const body = JSON.stringify(rest);
      if (!refresh && body === this.lastPublished) return;
      this.lastPublished = body;
      await getPublisher().set(TA_KEYS.state(this.tournamentId), JSON.stringify(state), 'EX', TA_STATE_TTL_SECONDS);
    } catch (err) {
      log.warn(`ta[${this.slug}]: could not publish state`, err);
    }
  }

  // -------------------------------------------------------------------------
  //  Commands from the site
  // -------------------------------------------------------------------------

  async command(cmd: TaCommand): Promise<TaReply> {
    try {
      switch (cmd.type) {
        case 'poke':
          this.runs.poke();
          return { ok: true };
        case 'reconnect':
          await this.connect();
          return { ok: true };
        case 'adoptToken':
          return await this.adoptToken(cmd.token);
        case 'chooseTournament':
          return await this.chooseTournament(cmd.guid);
        case 'createTournament': {
          this.need('signedIn');
          const guid = await this.createTournament(cmd.name);
          return await this.chooseTournament(guid);
        }
        case 'setReplayStreaming':
          this.need('ready');
          return this.reply(await this.ta.setTournamentEnableReplayStreaming(this.taTournament, cmd.on), 'change replay streaming');
        case 'setPlayersOnly': {
          this.need('ready');
          // The roster goes in first, so nobody on it loses sight of the tournament for a moment.
          const synced = cmd.on ? await this.syncPlayers() : null;
          const reply = this.reply(await this.ta.setTournamentAllowUnauthorizedView(this.taTournament, !cmd.on), 'change who can see the tournament');
          return reply.ok && synced ? { ok: true, data: synced } : reply;
        }
        case 'syncPlayers':
          this.need('ready');
          return { ok: true, data: await this.syncPlayers() };
        case 'setAllowMockClients':
          this.need('ready');
          return this.reply(await this.ta.setTournamentAllowMockClients(this.taTournament, cmd.on), 'change the mock player setting');
        case 'setScoreUpdateFrequency':
          this.need('ready');
          return this.reply(
            await this.ta.setTournamentScoreUpdateFrequency(this.taTournament, Math.max(1, Math.min(300, Math.round(cmd.frames)))),
            'change how often scores are sent',
          );
        case 'setTournamentSetting': {
          this.need('ready');
          const t = this.taTournament;
          const s = cmd.setting;
          const change = 'change that setting';
          switch (s.key) {
            case 'name': {
              const name = s.value.trim().slice(0, 80);
              if (!name) throw new Error('Give the TA tournament a name.');
              const reply = this.reply(await this.ta.setTournamentName(t, name), 'rename the tournament');
              if (reply.ok) await prisma.taLink.update({ where: { tournamentId: this.tournamentId }, data: { taTournamentName: name } }).catch(() => {});
              return reply;
            }
            case 'bannedMods':
              return this.reply(await this.ta.setTournamentBannedMods(t, s.value.map((m) => m.trim()).filter(Boolean).slice(0, 50)), change);
            case 'showTournamentButton':
              return this.reply(await this.ta.setTournamentShowTournamentButton(t, s.value), change);
            case 'showQualifierButton':
              return this.reply(await this.ta.setTournamentShowQualifierButton(t, s.value), change);
            case 'enableTeams':
              return this.reply(await this.ta.setTournamentEnableTeams(t, s.value), change);
            case 'enablePools':
              return this.reply(await this.ta.setTournamentEnablePools(t, s.value), change);
            case 'replayRecording':
              return this.reply(await this.ta.setTournamentEnableReplayRecording(t, s.value), change);
            case 'replayRetention':
              return this.reply(await this.ta.setTournamentReplayRetention(t, RETENTION_VALUES[s.value]), change);
          }
          throw new Error('Unknown setting.');
        }
        case 'deleteTournament': {
          this.need('ready');
          const reply = this.reply(await this.ta.deleteTournament(this.taTournament), 'delete the tournament');
          if (reply.ok) {
            await prisma.taLink.update({ where: { tournamentId: this.tournamentId }, data: { taTournamentId: null, taTournamentName: null } }).catch(() => {});
            setTimeout(() => void this.connect().catch(() => {}), 0);
          }
          return reply;
        }
        case 'playerCommand': {
          this.need('ready');
          if (!cmd.guids.length) throw new Error('Tick the players it is for.');
          this.ta[cmd.command](this.taTournament, cmd.guids);
          return { ok: true };
        }
        case 'returnToMenu':
          this.need('ready');
          this.ta.returnToMenu(this.taTournament, cmd.guids);
          return { ok: true };
        case 'listAuthorizedUsers':
          this.need('ready');
          return { ok: true, data: await this.authorizedUsers() };
        case 'addAuthorizedUser':
          this.need('ready');
          return this.reply(await this.ta.addAuthorizedUser(this.taTournament, cmd.discordId, [cmd.role]), 'add that person');
        case 'removeAuthorizedUser':
          this.need('ready');
          return this.reply(await this.ta.removeAuthorizedUser(this.taTournament, cmd.discordId), 'remove that person');
        case 'setImage': {
          this.need('ready');
          let bytes = new Uint8Array(1);
          if (cmd.uploadId) {
            const upload = await prisma.upload.findFirst({ where: { id: cmd.uploadId, tournamentId: this.tournamentId }, select: { bytes: true } });
            if (!upload) throw new Error('That picture is no longer stored. Choose it again.');
            bytes = new Uint8Array(upload.bytes);
          }
          // One byte is how the client library says "no picture".
          return this.reply(await this.ta.setTournamentImage(this.taTournament, bytes), cmd.uploadId ? 'set the picture' : 'remove the picture');
        }
        case 'roomLoad':
          this.need('ready');
          await this.room.load(cmd.guids, cmd.song, TA_DIFFICULTIES.includes(cmd.difficulty) ? cmd.difficulty : 'ExpertPlus', cmd.characteristic);
          return { ok: true };
        case 'roomPlay':
          this.need('ready');
          await this.room.play();
          return { ok: true };
        case 'roomEnd':
          await this.room.close();
          return { ok: true };
        case 'listReplays':
          this.need('ready');
          return { ok: true, data: await this.replays(cmd.page) };
        case 'replayFile': {
          this.need('ready');
          // Not listed since the worker started: look through the list for it.
          for (let page = 1; !this.replayFiles.has(cmd.guid) && page <= 20; page++) {
            const listed = await this.replays(page);
            if (page * listed.pageSize >= listed.total) break;
          }
          const file = this.replayFiles.get(cmd.guid);
          if (!file) throw new Error('TournamentAssistant no longer has that replay.');
          return { ok: true, data: file };
        }
        case 'deleteReplay': {
          this.need('ready');
          const reply = this.reply(await this.ta.deleteReplay(this.taTournament, cmd.guid), 'delete that replay');
          if (reply.ok) this.replayFiles.delete(cmd.guid);
          return reply;
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Before the answer goes back: the page that asked is redrawn from this state.
      await this.publish();
    }
  }

  private need(what: 'ready' | 'signedIn'): void {
    if (!this.ta.isConnected) throw new Error('Not connected to TournamentAssistant right now.');
    if (!this.row.token || this.phase === 'signIn') throw new Error('Sign in to TournamentAssistant first.');
    if (what === 'ready' && !this.ready) throw new Error('Choose a TA tournament first.');
  }

  private reply(response: { type: Response_ResponseType }, what: string): TaReply {
    return ok(response)
      ? { ok: true }
      : { ok: false, error: `TournamentAssistant would not ${what}. This sign-in may lack the permission for it in the TA tournament.` };
  }

  /**
   * Someone signed in to TA (or pasted a token). A bot token is used as it is.
   * A person's token lasts five days, so it is traded for a bot token of our
   * own, which lasts; the person's connection is kept for half an hour to give
   * that bot rights in whichever of their tournaments they then choose.
   */
  private async adoptToken(token: string): Promise<TaReply> {
    const who = readTaToken(token);
    if (!who) return { ok: false, error: 'That is not a TournamentAssistant token.' };
    let stored = { token, tokenName: who.name || 'a TA bot', tokenUserId: who.id, signedInBy: null as string | null };

    if (!who.isBot) {
      const person = new TAClient();
      person.setAuthToken(token);
      let refused = false;
      person.on('authorizationRequestedFromServer', () => (refused = true));
      const connected = await person.connect(this.row.host, String(this.row.port));
      if (!ok(connected)) return { ok: false, error: 'TournamentAssistant refused the connection.' };
      const made = await person.generateBotToken(`BSCompStats (${this.row.tournament.slug})`.slice(0, 60)).catch(() => null);
      const botToken = made && ok(made) && made.details.oneofKind === 'generateBotToken' ? made.details.generateBotToken.botToken : '';
      const bot = botToken ? readTaToken(botToken) : null;
      if (refused || !bot) {
        person.disconnect();
        return { ok: false, error: 'TournamentAssistant did not accept that sign-in (it may have expired). Sign in again.' };
      }
      this.dropSetup();
      this.setup = { client: person, discordId: who.id, name: who.name, until: Date.now() + SETUP_MS };
      stored = { token: botToken, tokenName: bot.name || 'BSCompStats', tokenUserId: bot.id, signedInBy: who.name || who.id };
      log.info(`ta[${this.slug}]: ${who.name || who.id} signed in; made bot ${bot.id}`);
    }

    // Signing in again for a tournament already chosen: the new bot needs the same access the old one had.
    const setup = this.liveSetup();
    if (setup && stored.tokenUserId !== who.id && this.row.taTournamentId && setup.client.stateManager.getTournament(this.row.taTournamentId)) {
      await setup.client.addAuthorizedUser(this.row.taTournamentId, stored.tokenUserId, ['admin']).catch(() => {});
    }

    await prisma.taLink.update({ where: { tournamentId: this.tournamentId }, data: stored });
    this.row = { ...this.row, token: stored.token, tokenName: stored.tokenName };
    await this.connect();
    return { ok: true };
  }

  private async chooseTournament(guid: string): Promise<TaReply> {
    this.need('signedIn');
    const us = this.row.token ? readTaToken(this.row.token) : null;
    const setup = this.liveSetup();
    // The person who signed in adds our bot as an admin of their tournament, where they can.
    if (us?.isBot && setup && setup.client.stateManager.getTournament(guid)) {
      const added = await setup.client.addAuthorizedUser(guid, us.id, ['admin']).catch(() => null);
      if (!added || !ok(added)) {
        return {
          ok: false,
          error: 'You are not an admin of that TA tournament, so the site could not be given access to it. Ask its owner to add you, or make a new one here.',
        };
      }
      // What a sign-in may see is sent when it connects: connect again to see the tournament.
      await prisma.taLink.update({ where: { tournamentId: this.tournamentId }, data: { taTournamentId: guid, taTournamentName: null } });
      this.row = { ...this.row, taTournamentId: guid, taTournamentName: null };
      await this.connect();
    } else {
      await prisma.taLink.update({ where: { tournamentId: this.tournamentId }, data: { taTournamentId: guid, taTournamentName: null } });
      this.row = { ...this.row, taTournamentId: guid, taTournamentName: null };
      await this.enterTournament();
    }
    if (this.ready) return { ok: true };
    const fix =
      us?.isBot && !setup
        ? ` Sign in again and choose it, or add the bot (id ${us.id}) as an admin in the TA tournament's settings.`
        : '';
    return { ok: false, error: `${this.message ?? 'Could not join that TA tournament.'}${fix}` };
  }

  /** Make a TA tournament on this server, as our sign-in (which then owns it). Answers its guid. */
  private async createTournament(name: string): Promise<string> {
    const ta = this.ta;
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error('Give the TA tournament a name.');
    if (ta.stateManager.getTournaments().some((t) => t.settings?.tournamentName === clean)) {
      throw new Error(`There is already a TA tournament called "${clean}". Choose it from the list, or pick another name.`);
    }
    const servers = ta.stateManager.getKnownServers();
    const server = servers.find((s) => s.address === this.row.host) ?? servers[0];
    const response = await ta.createTournament(
      server?.address ?? this.row.host,
      server?.name ?? this.row.host,
      String(server?.port ?? 8675),
      String(server?.websocketPort ?? this.row.port),
      clean,
      new Uint8Array([1]), // no image
      false, // teams: lineups are the site's business
      false, // pools likewise
      true, // show the tournament button in game
      false, // no qualifier button
      [],
      [],
      30, // score update frequency, in frames
      [],
      [],
      false,
      true, // replay streaming: the overlay's live replays
      false, // mock players: switched on from the site when testing
    );
    const made = response.details.oneofKind === 'createTournament' ? response.details.createTournament.tournament : undefined;
    if (!ok(response) || !made) {
      const why = response.details.oneofKind === 'createTournament' ? response.details.createTournament.message : '';
      throw new Error(`TournamentAssistant would not make the tournament${why ? `: ${why}` : '.'}`);
    }
    log.info(`ta[${this.slug}]: made TA tournament "${clean}" (${made.guid})`);
    // The person who signed in can open it in TA's own app too.
    const setup = this.liveSetup();
    if (setup) await ta.addAuthorizedUser(made.guid, setup.discordId, ['admin']).catch(() => {});
    return made.guid;
  }

  /**
   * Give TA the roster: everyone on a team of this tournament gets TA's "player" role (see the tournament in game,
   * join it), under every id TA might know them by - the TA id an organiser set, their BeatLeader id (the Steam id
   * for Steam players) and, where they signed in to this site with Discord, their Discord id. Someone who already
   * has a role (an admin, a coordinator) is left exactly as they are. Ids that hold only the player role and are no
   * longer on the roster are taken out again.
   */
  private async syncPlayers(): Promise<{ added: number; removed: number; players: number }> {
    const members = await prisma.teamMember.findMany({
      where: { team: { division: { tournamentId: this.tournamentId } } },
      select: {
        player: {
          select: {
            id: true,
            beatLeaderId: true,
            taPlatformId: true,
            user: { select: { accounts: { where: { provider: 'discord' }, select: { providerAccountId: true } } } },
          },
        },
      },
    });
    const wanted = new Set<string>();
    const players = new Set<string>();
    for (const { player } of members) {
      players.add(player.id);
      for (const id of [player.taPlatformId, player.beatLeaderId, ...(player.user?.accounts.map((a) => a.providerAccountId) ?? [])]) {
        if (id && /^[A-Za-z0-9_-]{1,64}$/.test(id)) wanted.add(id);
      }
    }
    const existing = await this.authorizedUsers();
    const have = new Map(existing.map((u) => [u.discordId, u.roles]));
    let added = 0;
    let removed = 0;
    for (const id of wanted) {
      if (have.has(id)) continue;
      if (ok(await this.ta.addAuthorizedUser(this.taTournament, id, ['player']))) added++;
    }
    for (const [id, roles] of have) {
      if (wanted.has(id) || roles.length !== 1 || roles[0] !== 'player') continue;
      if (ok(await this.ta.removeAuthorizedUser(this.taTournament, id))) removed++;
    }
    this.playersSyncedAt = Date.now();
    if (added || removed) log.info(`ta[${this.slug}]: players in TA brought in step with the roster: ${added} added, ${removed} removed`);
    return { added, removed, players: players.size };
  }
  private playersSyncedAt = 0;

  /** One page of the replays TA recorded for the tournament, newest first. */
  private async replays(page: number): Promise<TaReplayPage> {
    const pageSize = 50;
    // TA counts pages from 0; the site shows them from 1.
    const asked = Math.max(1, Math.round(page) || 1);
    const response = await this.ta.getReplays(this.taTournament, asked - 1, pageSize);
    const got = response.details.oneofKind === 'getReplays' ? response.details.getReplays : undefined;
    if (!ok(response) || !got) throw new Error('TournamentAssistant would not list the recorded replays (this sign-in may not be allowed to see them).');
    const replays: TaReplay[] = got.replays.map((r) => {
      if (r.downloadUrl) this.replayFiles.set(r.guid, { url: r.downloadUrl, fileName: r.fileName || `${r.guid}.tarf` });
      return {
        guid: r.guid,
        playerName: r.playerName,
        platformId: r.platformId,
        mapHash: r.mapHash,
        characteristic: r.characteristic,
        difficulty: r.difficulty,
        recordedAt: Number(r.recordedAt),
        expiresAt: Number(r.expiresAt),
        size: Number(r.size),
        fileName: r.fileName,
      };
    });
    return { replays, total: got.totalCount, page: asked, pageSize: got.pageSize || pageSize, storage: got.storageAvailable };
  }

  private async authorizedUsers(): Promise<TaAuthorizedUser[]> {
    const response = await this.ta.getAuthorizedUsers(this.taTournament);
    if (!ok(response) || response.details.oneofKind !== 'getAuthorizedUsers') {
      throw new Error('TournamentAssistant would not list who has access. This sign-in may not be an admin of the TA tournament.');
    }
    return response.details.getAuthorizedUsers.authorizedUsers.map((u) => ({
      discordId: u.discordId,
      name: u.discordUsername || u.discordId,
      avatar: u.discordAvatarUrl || null,
      roles: u.roles,
    }));
  }
}

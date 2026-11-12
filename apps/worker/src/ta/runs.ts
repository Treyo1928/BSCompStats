import { TA_KEYS, parseFormat, readTaStatus, type TaLive, type TaPhase, type TaPlayerState, type TaStatusInput } from '@bscs/core/match';
import { Prisma, prisma } from '@bscs/db';
import {
  GameplayModifiers_GameOptions,
  PlayerSpecificSettings_ArcVisibilityType,
  PlayerSpecificSettings_NoteJumpDurationTypeSettings,
  PlayerSpecificSettings_PlayerOptions,
  Push_SongFinished_CompletionType,
  Response_ResponseType,
  User_ClientTypes,
  User_DownloadStates,
  type GameplayParameters,
  type Push_SongFinished,
  type RealtimeScore,
  type User,
} from 'moons-ta-client';
import { getPublisher } from '../bus.js';
import { log } from '../log.js';
import type { TaSession } from './session.js';

/** Redis channel the web app listens on for "this match changed" (see apps/web/src/lib/redis.ts). */
const MATCH_CHANGE = 'bscs:match';
/** How long players get to download and load a map. */
const LOAD_TIMEOUT_MS = 120_000;
/** After the song should have ended, how long to wait for a player who has not reported. */
const FINISH_GRACE_MS = 20_000;
/** Live numbers go out this often while a song runs. */
const LIVE_MS = 250;
const SCAN_MS = 2_000;

const DIFFICULTY: Record<string, number> = { Easy: 0, Normal: 1, Hard: 2, Expert: 3, ExpertPlus: 4 };

interface Slot {
  teamId: string;
  slot: number;
  playerId: string;
  name: string;
  /** Ids TA may know this player by, most trusted first: the TA id an organiser set, then their BeatLeader id. */
  ids: string[];
  /** Their TA connection, once found. */
  guid: string | null;
  platformId: string;
}

/** One map being started for its lineups: from the request to the scores. */
interface Run {
  /** Names the request: a restart is a new request, and a new run. */
  key: string;
  matchId: string;
  matchMapId: string;
  matchName: string;
  mapName: string;
  requestedAt: Date;
  slots: Slot[];
  phase: TaPhase;
  message: string | null;
  params: GameplayParameters;
  /** Which run of the map this is: 1, or more once replays have been called. */
  attempt: number;
  maxScore: number;
  duration: number;
  taMatch: string | null;
  /** A step is in flight (loading takes as long as the slowest download). */
  busy: boolean;
  loaded: Set<string>;
  loadFailed: Set<string>;
  scores: Map<string, RealtimeScore>;
  finished: Map<string, Push_SongFinished>;
  startedAt: number;
  lastStatus: string;
  lastLive: number;
}

const requestRows = (tournamentId: string) =>
  prisma.matchMap.findMany({
    where: {
      startRequestedAt: { not: null },
      scoresClosedAt: null,
      match: { tournamentId, taMode: true, state: { not: 'COMPLETE' } },
    },
    select: {
      id: true,
      startRequestedAt: true,
      playRequestedAt: true,
      taStatus: true,
      replayCalledByTeamIds: true,
      match: { select: { id: true, name: true, teamAId: true, teamBId: true, format: true, tournament: { select: { defaultFormat: true } } } },
      poolMap: {
        select: {
          leaderboard: {
            select: { maxScore: true, difficultyName: true, modeName: true, duration: true, map: { select: { hash: true, name: true, duration: true } } },
          },
        },
      },
      lineups: {
        select: {
          teamId: true,
          slots: { orderBy: { slot: 'asc' }, select: { slot: true, player: { select: { id: true, name: true, beatLeaderId: true, taPlatformId: true } } } },
        },
      },
    },
  });
type RequestRow = Awaited<ReturnType<typeof requestRows>>[number];

/**
 * Starts maps in TA for one tournament's TA-mode matches.
 *
 * The site records what an organiser asked for on the map itself (load it,
 * start it, cancel). This watches for those requests and carries them out:
 *
 *   waiting   a lineup player is not connected to TA yet; carries on by itself when they are
 *   loading   a TA match is made with the players, and their games fetch the map
 *   ready     everyone has it; nothing happens until an organiser presses "Start song"
 *   playing   the song runs for all of them at once; live numbers go out to overlays
 *   finished  their scores are on the match as TA scores, for the referee to close
 *
 * Several matches can run at once, each with its own TA match.
 */
export class MapRuns {
  private runs = new Map<string, Run>();
  private scanning = false;
  private again = false;
  private timer: NodeJS.Timeout;
  private liveTimer: NodeJS.Timeout;

  constructor(private readonly session: TaSession) {
    this.timer = setInterval(() => this.poke(), SCAN_MS);
    this.liveTimer = setInterval(() => void this.tickLive(), LIVE_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.liveTimer);
  }

  /** Look for requests now (also runs every couple of seconds). */
  poke(): void {
    if (this.scanning) {
      this.again = true;
      return;
    }
    this.scanning = true;
    void this.scan()
      .catch((err) => log.error(`ta[${this.session.slug}]: scan failed`, err))
      .finally(() => {
        this.scanning = false;
        if (this.again) {
          this.again = false;
          this.poke();
        }
      });
  }

  // -------------------------------------------------------------------------
  //  Following the requests
  // -------------------------------------------------------------------------

  private async scan(): Promise<void> {
    if (!this.session.ready) return;
    const rows = await requestRows(this.session.tournamentId);
    const wanted = new Map(rows.map((row) => [row.id, row]));

    // Runs whose request is gone (cancelled, the lineup changed, the map closed) or was made again.
    for (const run of [...this.runs.values()]) {
      const row = wanted.get(run.matchMapId);
      if (row && this.keyOf(row) === run.key) continue;
      this.runs.delete(run.matchMapId);
      if (run.phase !== 'finished' && run.phase !== 'error') {
        log.info(`ta[${this.session.slug}]: ${run.matchName}: ${run.mapName} cancelled`);
        await this.release(run, true);
        void this.live(run, 'over');
      }
    }

    for (const row of rows) {
      let run = this.runs.get(row.id);
      if (!run) {
        const stored = readTaStatus(row.taStatus);
        if (stored && stored.phase !== 'waiting') {
          // A start from before this worker started. Finished and failed ones are history; one that was
          // under way has lost its TA match with the old connection.
          if (stored.phase !== 'finished' && stored.phase !== 'error') {
            await this.orphan(row, 'The site restarted while this map was being started or played. Restart the map, or type the scores in.');
          }
          continue;
        }
        run = this.begin(row) ?? undefined;
        if (!run) continue;
        this.runs.set(row.id, run);
        log.info(`ta[${this.session.slug}]: ${run.matchName}: ${run.mapName} requested`);
      }
      await this.advance(run, row);
    }
  }

  private keyOf(row: RequestRow): string {
    return `${row.id}@${row.startRequestedAt!.getTime()}`;
  }

  private begin(row: RequestRow): Run | null {
    const format = parseFormat(row.match.format ?? row.match.tournament.defaultFormat);
    const slots: Slot[] = [];
    for (const teamId of [row.match.teamAId, row.match.teamBId]) {
      const lineup = row.lineups.find((l) => l.teamId === teamId);
      for (const s of (lineup?.slots ?? []).slice(0, format.playersPerMap)) {
        slots.push({
          teamId,
          slot: s.slot,
          playerId: s.player.id,
          name: s.player.name,
          ids: [s.player.taPlatformId, s.player.beatLeaderId].filter((id): id is string => !!id),
          guid: null,
          platformId: s.player.taPlatformId ?? s.player.beatLeaderId,
        });
      }
    }
    if (!slots.length) return null;
    const lb = row.poolMap.leaderboard;
    const options = this.session.options;
    return {
      key: this.keyOf(row),
      matchId: row.match.id,
      matchMapId: row.id,
      matchName: row.match.name,
      mapName: lb.map.name,
      requestedAt: row.startRequestedAt!,
      slots,
      phase: 'waiting',
      message: null,
      attempt: 1 + row.replayCalledByTeamIds.length,
      maxScore: lb.maxScore,
      duration: lb.duration || lb.map.duration || 180,
      taMatch: null,
      busy: false,
      loaded: new Set(),
      loadFailed: new Set(),
      scores: new Map(),
      finished: new Map(),
      startedAt: 0,
      lastStatus: '',
      lastLive: 0,
      params: {
        beatmap: {
          name: lb.map.name,
          levelId: `custom_level_${lb.map.hash.toUpperCase()}`,
          characteristic: { serializedName: lb.modeName || 'Standard', difficulties: [] },
          difficulty: DIFFICULTY[lb.difficultyName] ?? 4,
        },
        playerSettings: {
          playerHeight: 0,
          sfxVolume: 0,
          saberTrailIntensity: 0,
          noteJumpStartBeatOffset: 0,
          noteJumpFixedDuration: 0,
          options: PlayerSpecificSettings_PlayerOptions.NoPlayerOptions,
          noteJumpDurationTypeSettings: PlayerSpecificSettings_NoteJumpDurationTypeSettings.Dynamic,
          arcVisibilityType: PlayerSpecificSettings_ArcVisibilityType.None,
        },
        gameplayModifiers: {
          options: options.modifiers.reduce((bits, name) => bits | (GameplayModifiers_GameOptions[name] ?? 0), GameplayModifiers_GameOptions.None as number),
        },
        attempts: 0,
        showScoreboard: options.showScoreboard,
        disablePause: options.disablePause,
        disableFail: options.disableFail,
        disableScoresaberSubmission: options.disableScoresaberSubmission,
        disableCustomNotesOnStream: options.disableCustomNotesOnStream,
        useSync: false,
        target: 0,
      },
    };
  }

  /** Who in TA is each lineup player: by TA id, then BeatLeader id (a Steam player's Steam id), then the same name. */
  private resolve(run: Run): void {
    const players = this.session.users().filter((u) => u.clientType === User_ClientTypes.Player);
    for (const slot of run.slots) {
      const user: User | undefined =
        slot.ids.map((id) => players.find((u) => u.platformId === id)).find((u) => u) ??
        players.find((u) => u.name.trim().toLowerCase() === slot.name.trim().toLowerCase());
      slot.guid = user?.guid ?? null;
      if (user?.platformId) slot.platformId = user.platformId;
    }
  }

  private async advance(run: Run, row: RequestRow): Promise<void> {
    if (run.busy) return;
    if (run.phase === 'waiting') {
      this.resolve(run);
      const missing = run.slots.filter((s) => !s.guid);
      if (missing.length) {
        run.message = `Not connected to TournamentAssistant: ${missing.map((s) => s.name).join(', ')}. The map loads by itself once they join.`;
        await this.report(run);
        return;
      }
      run.message = null;
      run.busy = true;
      void this.load(run).finally(() => {
        run.busy = false;
        this.poke();
      });
      return;
    }
    if (run.phase === 'loading' || run.phase === 'ready') {
      // Someone dropped out of TA: their game no longer has the map. Start over when they are back.
      const here = new Set(this.session.users().map((u) => u.guid));
      const gone = run.slots.filter((s) => s.guid && !here.has(s.guid));
      if (gone.length) {
        log.info(`ta[${this.session.slug}]: ${run.matchName}: ${gone.map((s) => s.name).join(', ')} left TA before the start`);
        await this.release(run, false);
        run.phase = 'waiting';
        run.loaded.clear();
        run.loadFailed.clear();
        // "Start song" was for the players who were ready then; it has to be pressed again.
        await prisma.matchMap.updateMany({ where: { id: run.matchMapId, startRequestedAt: run.requestedAt }, data: { playRequestedAt: null } });
        this.poke();
        return;
      }
    }
    if (run.phase === 'ready' && row.playRequestedAt) {
      await this.play(run);
      return;
    }
    if (run.phase === 'playing') {
      // Over when everyone has reported, or the song (and a little longer) has passed. A player whose game
      // dropped off TA mid-song will never report: once the others have, there is nothing to wait for.
      const here = new Set(this.session.users().map((u) => u.guid));
      const waitingOn = run.slots.filter((s) => s.guid && !run.finished.has(s.guid) && here.has(s.guid));
      const someoneLeft = run.slots.some((s) => s.guid && !run.finished.has(s.guid) && !here.has(s.guid));
      if ((someoneLeft && waitingOn.length === 0) || Date.now() > run.startedAt + run.duration * 1000 + FINISH_GRACE_MS) {
        await this.finish(run);
      }
    }
  }

  // -------------------------------------------------------------------------
  //  The steps
  // -------------------------------------------------------------------------

  private get ta() {
    return this.session.ta;
  }

  /** Whether `run` is still the one being carried out (not cancelled or restarted meanwhile). */
  private current(run: Run): boolean {
    return this.runs.get(run.matchMapId) === run;
  }

  private async load(run: Run): Promise<void> {
    const tournament = this.session.taTournament;
    const guids = run.slots.map((s) => s.guid!);
    try {
      const self = this.ta.stateManager.getSelfGuid();
      // We are in the match ourselves: TA sends live scores only to its non-players.
      const made = await this.ta.createMatch(tournament, { guid: crypto.randomUUID(), leader: self, associatedUsers: [self, ...guids], selectedMap: undefined });
      const match = made.details.oneofKind === 'createMatch' ? made.details.createMatch.match : undefined;
      if (made.type !== Response_ResponseType.Success || !match) throw new Error('TournamentAssistant would not make a match for these players.');
      run.taMatch = match.guid;
      await this.ta.setMatchMap(tournament, match.guid, { guid: crypto.randomUUID(), gameplayParameters: run.params });
      if (!this.current(run)) return void (await this.release(run, true));

      run.phase = 'loading';
      await this.report(run);
      const answers = await this.ta.loadSong(tournament, run.params.beatmap!.levelId, guids, LOAD_TIMEOUT_MS);
      if (!this.current(run)) return void (await this.release(run, true));
      for (const a of answers) (a.response.type === Response_ResponseType.Success ? run.loaded : run.loadFailed).add(a.userId);

      const failed = run.slots.filter((s) => !run.loaded.has(s.guid!));
      if (failed.length) {
        run.phase = 'error';
        run.message = `Could not load the map: ${failed.map((s) => s.name).join(', ')}. Their game did not fetch it in time. Press Restart to try again.`;
        await this.release(run, false);
      } else {
        run.phase = 'ready';
        run.message = null;
        log.info(`ta[${this.session.slug}]: ${run.matchName}: ${run.mapName} loaded for ${run.slots.map((s) => s.name).join(', ')}`);
      }
      await this.report(run);
    } catch (err) {
      if (!this.current(run)) return;
      run.phase = 'error';
      run.message = `TournamentAssistant could not load the map: ${err instanceof Error ? err.message : String(err)}. Press Restart to try again.`;
      await this.release(run, false);
      await this.report(run);
    }
  }

  private async play(run: Run): Promise<void> {
    // This run of the map is being played (again): whatever was recorded for it before is void, so a player who
    // drops out this time is not left with their score from the last one beside everyone else's new ones.
    await prisma.matchMapAttempt.deleteMany({ where: { matchMapId: run.matchMapId, attempt: run.attempt, matchMap: { startRequestedAt: run.requestedAt } } });
    // One command to everyone, so they start together.
    this.ta.playSong(this.session.taTournament, run.params, run.slots.map((s) => s.guid!));
    run.startedAt = Date.now();
    run.phase = 'playing';
    run.scores.clear();
    run.finished.clear();
    await this.report(run);
    await this.live(run, 'playing');
    log.info(`ta[${this.session.slug}]: ${run.matchName}: ${run.mapName} started for ${run.slots.map((s) => s.name).join(', ')}`);
  }

  /** Everyone is done, or the wait for a straggler ran out: TA's scores go on the match. */
  private async finish(run: Run): Promise<void> {
    if (run.phase !== 'playing') return;
    run.phase = 'finished';
    const writes = [];
    for (const slot of run.slots) {
      const f = slot.guid ? run.finished.get(slot.guid) : undefined;
      // A player who quit has no score worth recording; the referee decides what happens.
      if (!f || f.type === Push_SongFinished_CompletionType.Quit) continue;
      const score = Math.max(0, Math.round(f.score));
      const data = {
        score,
        // Of the whole map, like every other score on the site (TA's own figure is of the notes reached).
        accuracy: run.maxScore > 0 ? Math.min(1, score / run.maxScore) : Math.min(1, Math.max(0, f.accuracy)),
        // TA reports the score as played: nothing was halved by No Fail, so nothing is doubled back.
        failed: false,
        misses: f.misses + f.badCuts,
        source: 'TA',
        beatLeaderScoreId: null,
        beatLeaderAttemptId: null,
        endType: f.type === Push_SongFinished_CompletionType.Passed ? 'CLEAR' : 'FAIL',
        timeset: Math.floor(Date.now() / 1000),
        replayUrl: null,
      };
      writes.push(
        prisma.matchMapAttempt.upsert({
          where: { matchMapId_teamId_playerId_attempt: { matchMapId: run.matchMapId, teamId: slot.teamId, playerId: slot.playerId, attempt: run.attempt } },
          create: { matchMapId: run.matchMapId, teamId: slot.teamId, playerId: slot.playerId, attempt: run.attempt, ...data },
          update: data,
        }),
      );
    }
    const unreported = run.slots.filter((s) => !(s.guid && run.finished.has(s.guid)));
    const quit = run.slots.filter((s) => s.guid && run.finished.get(s.guid)?.type === Push_SongFinished_CompletionType.Quit);
    const failed = run.slots.filter((s) => s.guid && run.finished.get(s.guid)?.type === Push_SongFinished_CompletionType.Failed);
    run.message =
      [
        unreported.length ? `No score came from ${unreported.map((s) => s.name).join(', ')} (their game dropped off TournamentAssistant, or never answered): type theirs in, or play the map again.` : '',
        quit.length ? `${quit.map((s) => s.name).join(', ')} left the song before it ended, so no score was entered for them.` : '',
        failed.length ? `${failed.map((s) => s.name).join(', ')} failed; the score is what they had when they did.` : '',
      ]
        .filter(Boolean)
        .join(' ') || null;
    let closed = false;
    try {
      // Only while this is still the request: a map closed or restarted a moment ago keeps what it has.
      const still = await prisma.matchMap.count({ where: { id: run.matchMapId, startRequestedAt: run.requestedAt, scoresClosedAt: null } });
      // A clean run closes its own map: a score from every lineup player. Anything else is the referee's call.
      const clean = writes.length === run.slots.length && !unreported.length && !quit.length;
      closed = !!still && clean && this.session.options.autoClose;
      if (still) {
        await prisma.$transaction([
          ...writes,
          ...(closed ? [prisma.matchMap.updateMany({ where: { id: run.matchMapId, startRequestedAt: run.requestedAt, scoresClosedAt: null }, data: { scoresClosedAt: new Date() } })] : []),
        ]);
      }
    } catch (err) {
      closed = false;
      log.error(`ta[${this.session.slug}]: could not enter scores for ${run.mapName}`, err);
      run.message = `The scores could not be saved (${err instanceof Error ? err.message : String(err)}). Type them in.`;
    }
    await this.report(run);
    await this.live(run, 'over');
    await this.release(run, false);
    log.info(`ta[${this.session.slug}]: ${run.matchName}: ${run.mapName} finished, ${writes.length}/${run.slots.length} scores entered from TA${closed ? ', map closed' : ''}`);
  }

  /** Take the TA match down; `toMenu` also pulls the players out of the song or the loaded map. */
  private async release(run: Run, toMenu: boolean): Promise<void> {
    const tournament = this.session.taTournament;
    if (!tournament || !this.ta.isConnected) return;
    const guids = run.slots.flatMap((s) => (s.guid ? [s.guid] : []));
    if (toMenu && guids.length && (run.phase === 'loading' || run.phase === 'ready' || run.phase === 'playing')) {
      this.ta.returnToMenu(tournament, guids);
    }
    if (run.taMatch) await this.ta.deleteMatch(tournament, run.taMatch).catch(() => {});
    run.taMatch = null;
  }

  /** The connection is going away: whatever was under way cannot be finished. */
  async abandon(reason: string): Promise<void> {
    const runs = [...this.runs.values()];
    this.runs.clear();
    for (const run of runs) {
      if (run.phase === 'finished' || run.phase === 'error') continue;
      await this.release(run, true).catch(() => {});
      if (run.phase !== 'waiting') {
        run.phase = 'error';
        run.message = reason;
        await this.report(run);
      }
      void this.live(run, 'over');
    }
  }

  private async orphan(row: RequestRow, message: string): Promise<void> {
    await prisma.matchMap.updateMany({
      where: { id: row.id, startRequestedAt: row.startRequestedAt },
      data: { taStatus: { phase: 'error', message, reportedAt: new Date().toISOString() } },
    });
    await getPublisher().publish(MATCH_CHANGE, JSON.stringify({ matchId: row.match.id, at: Date.now() })).catch(() => {});
  }

  // -------------------------------------------------------------------------
  //  What TA tells us
  // -------------------------------------------------------------------------

  private runOf(guid: string): Run | undefined {
    for (const run of this.runs.values()) if (run.slots.some((s) => s.guid === guid)) return run;
    return undefined;
  }

  onScore(score: RealtimeScore): void {
    const run = this.runOf(score.userGuid);
    if (run?.phase === 'playing') run.scores.set(score.userGuid, score);
  }

  onFinished(finished: Push_SongFinished): void {
    const guid = finished.player?.guid;
    const run = guid ? this.runOf(guid) : undefined;
    if (!guid || run?.phase !== 'playing') return;
    // TA sends everyone's results to everyone: only take one for the match we made.
    if (finished.matchId && run.taMatch && finished.matchId !== run.taMatch) return;
    run.finished.set(guid, finished);
    void this.live(run, 'playing');
    if (run.slots.every((s) => s.guid && run.finished.has(s.guid))) {
      void this.finish(run).catch((err) => log.error(`ta[${this.session.slug}]: finishing ${run.mapName} failed`, err));
    } else {
      void this.report(run);
    }
  }

  /** A player's download state changed: show it while a map loads. */
  userChanged(): void {
    for (const run of this.runs.values()) if (run.phase === 'loading') void this.report(run);
  }

  // -------------------------------------------------------------------------
  //  Telling the site
  // -------------------------------------------------------------------------

  private playerState(run: Run, slot: Slot): TaPlayerState {
    if (!slot.guid) return 'missing';
    const f = run.finished.get(slot.guid);
    switch (run.phase) {
      case 'waiting':
        return 'ready';
      case 'loading': {
        if (run.loaded.has(slot.guid)) return 'ready';
        if (run.loadFailed.has(slot.guid)) return 'failed';
        const user = this.session.users().find((u) => u.guid === slot.guid);
        return user?.downloadState === User_DownloadStates.Downloaded ? 'ready' : user?.downloadState === User_DownloadStates.DownloadError ? 'failed' : 'loading';
      }
      case 'ready':
        return 'ready';
      case 'error':
        return run.loadFailed.has(slot.guid) || (run.loaded.size > 0 && !run.loaded.has(slot.guid)) ? 'failed' : 'ready';
      case 'playing':
      case 'finished':
        if (!f) return run.phase === 'playing' ? 'playing' : 'quit';
        return f.type === Push_SongFinished_CompletionType.Passed ? 'finished' : f.type === Push_SongFinished_CompletionType.Failed ? 'failed' : 'quit';
    }
  }

  /** Write how the start stands on the map, if that changed, and tell open match pages. */
  private async report(run: Run): Promise<void> {
    const status: TaStatusInput = {
      phase: run.phase,
      ...(run.message ? { message: run.message.slice(0, 500) } : {}),
      players: run.slots.map((slot) => {
        const f = slot.guid ? run.finished.get(slot.guid) : undefined;
        const reported = f && f.type !== Push_SongFinished_CompletionType.Quit;
        return {
          playerId: slot.playerId,
          state: this.playerState(run, slot),
          ...(reported ? { score: Math.max(0, Math.round(f.score)), accuracy: Math.min(1, Math.max(0, run.maxScore > 0 ? f.score / run.maxScore : f.accuracy)) } : {}),
        };
      }),
      ...(run.startedAt ? { startedAt: new Date(run.startedAt).toISOString() } : {}),
    };
    const body = JSON.stringify(status);
    if (body === run.lastStatus) return;
    run.lastStatus = body;
    try {
      const updated = await prisma.matchMap.updateMany({
        where: { id: run.matchMapId, startRequestedAt: run.requestedAt },
        data: { taStatus: { ...status, reportedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue },
      });
      if (updated.count) await getPublisher().publish(MATCH_CHANGE, JSON.stringify({ matchId: run.matchId, at: Date.now() }));
    } catch (err) {
      log.warn(`ta[${this.session.slug}]: could not write status`, err);
    }
  }

  private async tickLive(): Promise<void> {
    for (const run of this.runs.values()) if (run.phase === 'playing') await this.live(run, 'playing');
  }

  /** Live numbers for overlays: every player's score, accuracy, combo and misses, a few times a second. */
  private async live(run: Run, phase: TaLive['phase']): Promise<void> {
    if (!run.startedAt) return;
    const elapsed = Math.min(run.duration, (Date.now() - run.startedAt) / 1000);
    const message: TaLive = {
      matchId: run.matchId,
      matchMapId: run.matchMapId,
      phase,
      startedAt: run.startedAt,
      at: Date.now(),
      players: run.slots.map((slot) => {
        const rt = slot.guid ? run.scores.get(slot.guid) : undefined;
        const f = slot.guid ? run.finished.get(slot.guid) : undefined;
        return {
          playerId: slot.playerId,
          teamId: slot.teamId,
          slot: slot.slot,
          platformId: slot.platformId,
          score: Math.round(f?.score ?? rt?.scoreWithModifiers ?? rt?.score ?? 0),
          accuracy: Math.min(1, Math.max(0, f?.accuracy ?? rt?.accuracy ?? 0)),
          combo: f ? 0 : (rt?.combo ?? 0),
          misses: f ? f.misses + f.badCuts : (rt?.notesMissed ?? 0) + (rt?.badCuts ?? 0),
          songPosition: f?.endTime ?? rt?.songPosition ?? elapsed,
          finished: !!f,
        };
      }),
    };
    await getPublisher().publish(TA_KEYS.live, JSON.stringify(message)).catch(() => {});
  }
}

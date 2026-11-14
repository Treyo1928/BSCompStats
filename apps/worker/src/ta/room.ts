import { parseSongRef, taCountedScore, taHalvedByNoFail, type TaDifficulty, type TaOptions, type TaPlayerState, type TaRoom } from '@bscs/core/match';
import { Push_SongFinished_CompletionType, Response_ResponseType, type GameplayParameters, type Push_SongFinished, type RealtimeScore } from 'moons-ta-client';
import { log } from '../log.js';
import { DIFFICULTY, gameplayParams, markPlayed } from './runs.js';
import type { TaSession } from './session.js';

const LOAD_TIMEOUT_MS = 120_000;
const FINISH_GRACE_MS = 20_000;
/** While a song plays, the page is given fresh scores this often. */
const SCORES_MS = 2_000;

interface Song {
  key: string | null;
  hash: string;
  name: string;
  mapper: string;
  difficulty: TaDifficulty;
  characteristic: string;
  duration: number;
  maxScore: number;
}

interface Active {
  phase: TaRoom['phase'];
  message: string | null;
  song: Song;
  players: Array<{ guid: string; name: string }>;
  params: GameplayParameters;
  options: Pick<TaOptions, 'disableFail' | 'modifiers'>;
  taMatch: string | null;
  loaded: Set<string>;
  scores: Map<string, RealtimeScore>;
  died: Set<string>;
  finished: Map<string, Push_SongFinished>;
  startedAt: number;
}

/** A BeatSaver map's details, by key or hash. Nothing about the tournament goes into the request. */
async function lookUp(ref: { key: string } | { hash: string }, difficulty: TaDifficulty, characteristic: string): Promise<Song> {
  const url = 'key' in ref ? `https://api.beatsaver.com/maps/id/${ref.key}` : `https://api.beatsaver.com/maps/hash/${ref.hash}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error('BeatSaver did not answer, so the map could not be looked up. Try again in a moment.');
  }
  if (res.status === 404) throw new Error('BeatSaver has no map with that key or hash.');
  if (!res.ok) throw new Error(`BeatSaver answered ${res.status} for that map.`);
  const map = (await res.json()) as {
    id?: string;
    name?: string;
    metadata?: { levelAuthorName?: string; duration?: number };
    versions?: Array<{ hash?: string; diffs?: Array<{ characteristic?: string; difficulty?: string; maxScore?: number; seconds?: number }> }>;
  };
  // By hash BeatSaver may hand back the map at a newer version: take the version asked for.
  const version = ('hash' in ref ? map.versions?.find((v) => v.hash?.toUpperCase() === ref.hash) : undefined) ?? map.versions?.at(-1);
  if (!version?.hash) throw new Error('BeatSaver has that map but no published version of it.');
  const diffs = version.diffs ?? [];
  const diff = diffs.find((d) => d.difficulty === difficulty && (d.characteristic ?? 'Standard').toLowerCase() === characteristic.toLowerCase());
  if (!diff) {
    const has = diffs.map((d) => `${d.characteristic === 'Standard' ? '' : `${d.characteristic} `}${d.difficulty === 'ExpertPlus' ? 'Expert+' : d.difficulty}`).join(', ');
    throw new Error(`"${map.name ?? 'That map'}" has no ${characteristic === 'Standard' ? '' : `${characteristic} `}${difficulty === 'ExpertPlus' ? 'Expert+' : difficulty}. It has: ${has || 'nothing playable'}.`);
  }
  return {
    key: map.id ?? ('key' in ref ? ref.key : null),
    hash: version.hash.toUpperCase(),
    name: map.name ?? 'Unnamed map',
    mapper: map.metadata?.levelAuthorName ?? '',
    difficulty,
    characteristic: diff.characteristic ?? 'Standard',
    duration: Math.round(diff.seconds || map.metadata?.duration || 180),
    maxScore: diff.maxScore ?? 0,
  };
}

/**
 * The free room: any BeatSaver map for any connected players, outside the site's matches. For warm-ups and map
 * checks. Nothing it does is written to a match; the scores live here until the room is closed.
 */
export class FreeRoom {
  private room: Active | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly session: TaSession) {}

  private get ta() {
    return this.session.ta;
  }

  /** What the site shows. */
  view(): TaRoom | null {
    const room = this.room;
    if (!room) return null;
    const here = new Set(this.session.users().map((u) => u.guid));
    return {
      phase: room.phase,
      message: room.message,
      song: { key: room.song.key, hash: room.song.hash, name: room.song.name, mapper: room.song.mapper, difficulty: room.song.difficulty, characteristic: room.song.characteristic, duration: room.song.duration },
      startedAt: room.startedAt,
      players: room.players.map((p) => {
        const f = room.finished.get(p.guid);
        const rt = room.scores.get(p.guid);
        if (f) {
          const counted = this.counted(room, p.guid, f);
          const quit = f.type === Push_SongFinished_CompletionType.Quit;
          return {
            guid: p.guid,
            name: p.name,
            state: (quit ? 'quit' : counted.failed ? 'failed' : 'finished') as TaPlayerState,
            score: counted.score,
            accuracy: room.song.maxScore > 0 ? Math.min(1, counted.score / room.song.maxScore) : Math.min(1, Math.max(0, f.accuracy)),
            misses: f.misses + f.badCuts,
            failed: counted.failed,
          };
        }
        const state: TaPlayerState = !here.has(p.guid) ? 'missing' : room.phase === 'playing' ? 'playing' : room.loaded.has(p.guid) ? 'ready' : 'loading';
        const died = room.died.has(p.guid);
        return {
          guid: p.guid,
          name: p.name,
          state,
          score: Math.round((rt?.scoreWithModifiers ?? rt?.score ?? 0) * (died ? 2 : 1)),
          accuracy: Math.min(1, Math.max(0, (rt?.accuracy ?? 0) * (died ? 2 : 1))),
          misses: (rt?.notesMissed ?? 0) + (rt?.badCuts ?? 0),
          failed: died,
        };
      }),
    };
  }

  private counted(room: Active, guid: string, f: Push_SongFinished) {
    const last = room.scores.get(guid);
    const halved = room.died.has(guid) || (!!last && taHalvedByNoFail(room.options, f.score, last.score));
    return taCountedScore({ shown: f.score, halved, reportedFailed: f.type === Push_SongFinished_CompletionType.Failed, maxScore: room.song.maxScore });
  }

  holds(guid: string): boolean {
    return !!this.room && this.room.players.some((p) => p.guid === guid);
  }

  /** Look the map up, make a TA match for the players and have their games fetch it. Answers once they have. */
  async load(guids: string[], songRef: string, difficulty: TaDifficulty, characteristic: string): Promise<void> {
    if (this.room && (this.room.phase === 'loading' || this.room.phase === 'playing')) {
      throw new Error(this.room.phase === 'playing' ? 'A song is being played in the free room. Wait for it, or close the room.' : 'The free room is already loading a map.');
    }
    const ref = parseSongRef(songRef);
    if (!ref) throw new Error(`"${songRef.trim()}" is not a BeatSaver key, link or map hash. A key looks like 2f4a1.`);
    const users = this.session.users();
    const players = [...new Set(guids)].flatMap((guid) => {
      const user = users.find((u) => u.guid === guid);
      return user ? [{ guid, name: user.name || 'Unnamed' }] : [];
    });
    if (!players.length) throw new Error('Tick the connected players the song is for.');
    const inMatch = players.filter((p) => this.session.runs.holds(p.guid));
    if (inMatch.length) throw new Error(`${inMatch.map((p) => p.name).join(', ')} ${inMatch.length === 1 ? 'is' : 'are'} in a match map right now. Leave them out, or wait for the map.`);

    const song = await lookUp(ref, difficulty, characteristic.trim() || 'Standard');
    await this.close(false);
    const options = this.session.options;
    const room: Active = {
      phase: 'loading',
      message: null,
      song,
      players,
      params: gameplayParams(options, { name: song.name, hash: song.hash, characteristic: song.characteristic, difficulty: DIFFICULTY[song.difficulty] ?? 4 }),
      options: { disableFail: options.disableFail, modifiers: options.modifiers },
      taMatch: null,
      loaded: new Set(),
      scores: new Map(),
      died: new Set(),
      finished: new Map(),
      startedAt: 0,
    };
    this.room = room;
    void this.session.publish();
    void this.fetch(room).catch((err) => log.error(`ta[${this.session.slug}]: free room: loading failed`, err));
  }

  private async fetch(room: Active): Promise<void> {
    const tournament = this.session.taTournament;
    const guids = room.players.map((p) => p.guid);
    try {
      const self = this.ta.stateManager.getSelfGuid();
      const made = await this.ta.createMatch(tournament, { guid: crypto.randomUUID(), leader: self, associatedUsers: [self, ...guids], selectedMap: undefined });
      const match = made.details.oneofKind === 'createMatch' ? made.details.createMatch.match : undefined;
      if (made.type !== Response_ResponseType.Success || !match) throw new Error('TournamentAssistant would not make a match for these players.');
      room.taMatch = match.guid;
      await this.ta.setMatchMap(tournament, match.guid, { guid: crypto.randomUUID(), gameplayParameters: room.params });
      if (this.room !== room) return void (await this.release(room, true));
      const answers = await this.ta.loadSong(tournament, room.params.beatmap!.levelId, guids, LOAD_TIMEOUT_MS);
      if (this.room !== room) return void (await this.release(room, true));
      for (const a of answers) if (a.response.type === Response_ResponseType.Success) room.loaded.add(a.userId);
      const failed = room.players.filter((p) => !room.loaded.has(p.guid));
      if (failed.length) {
        room.phase = 'error';
        room.message = `Could not load the map for ${failed.map((p) => p.name).join(', ')}: their game did not fetch it in time. Load it again, or close the room.`;
        await this.release(room, false);
      } else {
        room.phase = 'ready';
        log.info(`ta[${this.session.slug}]: free room: ${room.song.name} loaded for ${room.players.map((p) => p.name).join(', ')}`);
      }
    } catch (err) {
      if (this.room !== room) return;
      room.phase = 'error';
      room.message = `TournamentAssistant could not load the map: ${err instanceof Error ? err.message : String(err)}.`;
      await this.release(room, false);
    }
    void this.session.publish();
  }

  /** Start the loaded song for everyone at once; with a finished room, play the same map again. */
  async play(): Promise<void> {
    const room = this.room;
    if (!room) throw new Error('Load a map into the free room first.');
    if (room.phase === 'loading') throw new Error('The map is still loading for the players.');
    if (room.phase === 'playing') throw new Error('The song is already being played.');
    if (room.phase === 'error' || !room.taMatch) throw new Error('The map did not load. Load it again.');
    const here = new Set(this.session.users().map((u) => u.guid));
    const gone = room.players.filter((p) => !here.has(p.guid));
    if (gone.length) throw new Error(`${gone.map((p) => p.name).join(', ')} left TournamentAssistant. Load the map again for whoever is here.`);
    room.scores.clear();
    room.died.clear();
    room.finished.clear();
    room.message = null;
    this.ta.playSong(this.session.taTournament, room.params, room.players.map((p) => p.guid));
    markPlayed(room.players.map((p) => p.guid), room.params.beatmap!.levelId);
    room.startedAt = Date.now();
    room.phase = 'playing';
    this.watch();
    log.info(`ta[${this.session.slug}]: free room: ${room.song.name} started for ${room.players.map((p) => p.name).join(', ')}`);
  }

  private watch(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const room = this.room;
      if (room?.phase !== 'playing') {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        return;
      }
      const here = new Set(this.session.users().map((u) => u.guid));
      const waitingOn = room.players.filter((p) => !room.finished.has(p.guid) && here.has(p.guid));
      if (waitingOn.length === 0 || Date.now() > room.startedAt + room.song.duration * 1000 + FINISH_GRACE_MS) this.finish(room);
      void this.session.publish();
    }, SCORES_MS);
  }

  private finish(room: Active): void {
    if (room.phase !== 'playing') return;
    room.phase = 'finished';
    const silent = room.players.filter((p) => !room.finished.has(p.guid));
    room.message = silent.length ? `No score came from ${silent.map((p) => p.name).join(', ')}: their game dropped off TournamentAssistant or never answered.` : null;
    log.info(`ta[${this.session.slug}]: free room: ${room.song.name} finished, ${room.finished.size}/${room.players.length} scores`);
    void this.session.publish();
  }

  onScore(score: RealtimeScore): void {
    const room = this.room;
    if (room?.phase !== 'playing' || !room.players.some((p) => p.guid === score.userGuid)) return;
    room.scores.set(score.userGuid, score);
    if (taHalvedByNoFail(room.options, score.scoreWithModifiers, score.score)) room.died.add(score.userGuid);
  }

  onFinished(finished: Push_SongFinished): void {
    const room = this.room;
    const guid = finished.player?.guid;
    if (!guid || room?.phase !== 'playing' || !room.players.some((p) => p.guid === guid)) return;
    if (finished.matchId && room.taMatch && finished.matchId !== room.taMatch) return;
    room.finished.set(guid, finished);
    if (room.players.every((p) => room.finished.has(p.guid))) this.finish(room);
    else void this.session.publish();
  }

  private async release(room: Active, toMenu: boolean): Promise<void> {
    const tournament = this.session.taTournament;
    if (!tournament || !this.ta.isConnected) return;
    if (toMenu && room.players.length) this.ta.returnToMenu(tournament, room.players.map((p) => p.guid));
    if (room.taMatch) await this.ta.deleteMatch(tournament, room.taMatch).catch(() => {});
    room.taMatch = null;
  }

  /** Close the room: the players go back to waiting and TA's match for it is removed. */
  async close(toMenu = true): Promise<void> {
    const room = this.room;
    this.room = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (room) await this.release(room, toMenu).catch(() => {});
  }

  /** The connection is gone: there is nothing left to close on TA's side. */
  drop(): void {
    this.room = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

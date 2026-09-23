import { describe, expect, it } from 'vitest';
import { pickMatchRuns, runStart, type PlayerRuns, type PulledRun } from './pull.js';

const SONG = 180;
/** When the map opened for play. */
const OPEN = 2_000_000_000;

let nextId = 1;
/** A run that started `at` seconds after the map opened and lasted `time`. */
const run = (at: number, over: Partial<PulledRun> = {}): PulledRun => {
  const time = over.time ?? SONG;
  return {
    id: nextId++,
    source: 'RUN',
    endType: 'CLEAR',
    timeset: OPEN + at + time,
    time,
    accuracy: 0.95,
    baseScore: 900_000,
    modifiers: '',
    replayUrl: null,
    ...over,
  };
};
const player = (id: string, runs: PulledRun[], runsPublic = true): PlayerRuns => ({
  playerId: id,
  playerName: id,
  runsPublic,
  runs,
});
const options = { since: OPEN, toleranceSeconds: 15, duration: SONG };
const pick = (players: PlayerRuns[]) => pickMatchRuns(players, options);

describe('picking the runs a match map was played with', () => {
  it('takes the runs that started together', () => {
    const result = pick([player('a', [run(100)]), player('b', [run(104)]), player('c', [run(98)]), player('d', [run(101)])]);
    expect(result.picks.map((p) => p.status)).toEqual(['MATCHED', 'MATCHED', 'MATCHED', 'MATCHED']);
    expect(result.startedAt).toBe(OPEN + 100);
  });

  it('is not fooled by someone playing the map again before the button is pressed', () => {
    // b finished, then went straight back in to practise. The button is pressed long after.
    const matchRun = run(100);
    const practice = run(400, { accuracy: 0.99 });
    const result = pick([player('a', [run(100)]), player('b', [matchRun, practice]), player('c', [run(102)])]);
    expect(result.picks[1]!.chosen).toBe(matchRun);
    expect(result.picks[1]!.status).toBe('MATCHED');
  });

  it('waits for whoever has not finished, and picks them up when pressed again', () => {
    const early = pick([player('a', [run(100)]), player('b', [])]);
    expect(early.picks.map((p) => p.status)).toEqual(['MATCHED', 'WAITING']);
    expect(early.picks[1]!.notes[0]).toMatch(/Pull again/);
    const later = pick([player('a', [run(100)]), player('b', [run(103)])]);
    expect(later.picks.map((p) => p.status)).toEqual(['MATCHED', 'MATCHED']);
  });

  it('lines a fail up by when it started, saves it, and says so', () => {
    const failed = run(100, { endType: 'FAIL', time: 70 });
    expect(runStart(failed, SONG)).toBe(OPEN + 100);
    const result = pick([player('a', [run(100)]), player('b', [failed])]);
    expect(result.picks[1]!.status).toBe('MATCHED');
    expect(result.picks[1]!.notes.join(' ')).toMatch(/failed at 1:10/);
  });

  it('takes the fresh run after a quick restart', () => {
    const restarted = run(100, { endType: 'RESTART', time: 4 });
    const fresh = run(106);
    const result = pick([player('a', [run(100)]), player('b', [restarted, fresh])]);
    expect(result.picks[1]!.chosen).toBe(fresh);
  });

  it('asks rather than saves a restart or a quit, offering the later run', () => {
    const restarted = run(100, { endType: 'RESTART', time: 40 });
    const fresh = run(145);
    const result = pick([player('a', [run(100)]), player('b', [run(101)]), player('c', [restarted, fresh])]);
    expect(result.picks[2]!.status).toBe('CHECK');
    expect(result.picks[2]!.chosen).toBe(restarted);
    expect(result.picks[2]!.candidates).toContain(fresh);
  });

  it('asks about a run that started apart from the others', () => {
    const late = run(125);
    const result = pick([player('a', [run(100)]), player('b', [run(101)]), player('c', [late])]);
    expect(result.picks[2]!.status).toBe('CHECK');
    expect(result.picks[2]!.notes.join(' ')).toMatch(/Started 25s after the others/);
  });

  it('leaves a run that has nothing to do with the go waiting, and offers it', () => {
    const other = run(900);
    const result = pick([player('a', [run(100)]), player('b', [run(101)]), player('c', [other])]);
    expect(result.picks[2]!.status).toBe('WAITING');
    expect(result.picks[2]!.candidates).toEqual([other]);
  });

  it('trusts a clear\'s own length only where it is plausible', () => {
    // Real clears on a 156s song: 138s (the level ends before the audio), and 36s (nonsense).
    expect(runStart({ timeset: 1000, time: 138, endType: 'CLEAR' }, 156)).toBe(862);
    expect(runStart({ timeset: 1000, time: 36, endType: 'CLEAR' }, 156)).toBe(844);
    expect(runStart({ timeset: 1000, time: 70, endType: 'FAIL' }, 156)).toBe(930);
  });

  it('ignores practice and anything from before the map opened', () => {
    const result = pick([player('a', [run(100)]), player('b', [run(-3000), run(100, { endType: 'PRACTICE' })])]);
    expect(result.picks[1]!.status).toBe('WAITING');
    expect(result.picks[1]!.candidates).toEqual([]);
  });

  it('takes a private player\'s new best when it lines up, and explains when there is none', () => {
    const pb = run(100, { source: 'SCORE' });
    expect(pick([player('a', [run(100)]), player('p', [pb], false)]).picks[1]!.status).toBe('MATCHED');
    const none = pick([player('a', [run(100)]), player('p', [], false)]);
    expect(none.picks[1]!.status).toBe('WAITING');
    expect(none.picks[1]!.notes[0]).toMatch(/private/);
  });

  it('wants a look at modifiers, but not No Fail, which matches are played with', () => {
    const result = pick([player('a', [run(100, { modifiers: 'NF,FS' })]), player('b', [run(100, { modifiers: 'NF' })])]);
    expect(result.picks[0]!.status).toBe('CHECK');
    expect(result.picks[0]!.notes).toEqual(['Played with modifiers: FS.']);
    expect(result.picks[1]!.status).toBe('MATCHED');
    expect(result.picks[1]!.notes).toEqual([]);
  });
});

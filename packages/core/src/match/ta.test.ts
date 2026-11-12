import { describe, it, expect } from 'vitest';
import { parseSongRef, DEFAULT_TA_OPTIONS, taCountedScore, taHalvedByNoFail, taModifierMultiplier, nextMapToPlay, parseTaOptions, parseTaStatus, readTaStatus, TA_MAX_PLAYERS, TA_PHASES } from './ta.js';

const now = new Date('2026-10-29T20:00:00Z');

describe('a report on a TA start', () => {
  it('is stored with the time it arrived', () => {
    const out = parseTaStatus(
      {
        phase: 'playing',
        players: [
          { playerId: 'p1', state: 'playing' },
          { playerId: 'p2', state: 'finished', score: 812_345, accuracy: 0.9612 },
        ],
        startedAt: '2026-10-29T19:59:30+00:00',
      },
      now,
    );
    expect(out).toEqual({
      status: {
        phase: 'playing',
        players: [
          { playerId: 'p1', state: 'playing' },
          { playerId: 'p2', state: 'finished', score: 812_345, accuracy: 0.9612 },
        ],
        startedAt: '2026-10-29T19:59:30.000Z',
        reportedAt: '2026-10-29T20:00:00.000Z',
      },
    });
  });

  it('needs only a phase', () => {
    expect(parseTaStatus({ phase: 'waiting' }, now)).toEqual({ status: { phase: 'waiting', reportedAt: now.toISOString() } });
  });

  it('says what is wrong with a bad one', () => {
    expect(parseTaStatus(null)).toHaveProperty('error');
    expect(parseTaStatus({ phase: 'started' })).toMatchObject({ error: expect.stringContaining('status.phase') });
    expect(parseTaStatus({ phase: 'playing', players: [{ playerId: 'p1', state: 'dancing' }] })).toMatchObject({
      error: expect.stringContaining('status.players.0.state'),
    });
    expect(parseTaStatus({ phase: 'finished', players: [{ playerId: 'p1', state: 'finished', accuracy: 96.1 }] })).toMatchObject({
      error: expect.stringContaining('accuracy'),
    });
    expect(parseTaStatus({ phase: 'loading', startedAt: 'soon' })).toMatchObject({ error: expect.stringContaining('startedAt') });
    expect(parseTaStatus({ phase: 'error', message: 'x'.repeat(501) })).toHaveProperty('error');
    expect(parseTaStatus({ phase: 'waiting', extra: 1 })).toHaveProperty('error');
    expect(
      parseTaStatus({ phase: 'loading', players: [{ playerId: 'p1', state: 'ready' }, { playerId: 'p1', state: 'loading' }] }),
    ).toMatchObject({ error: expect.stringContaining('twice') });
  });

  it('is kept small', () => {
    const players = Array.from({ length: TA_MAX_PLAYERS + 1 }, (_, i) => ({ playerId: `p${i}`, state: 'ready' }));
    expect(parseTaStatus({ phase: 'loading', players })).toHaveProperty('error');
  });

  it('reads back what was stored, and nothing else', () => {
    const stored = (parseTaStatus({ phase: 'error', message: 'TA lost the connection' }, now) as { status: unknown }).status;
    expect(readTaStatus(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(readTaStatus(null)).toBeNull();
    expect(readTaStatus({ phase: 'waiting' })).toBeNull();
    expect(readTaStatus('waiting')).toBeNull();
  });
});

describe('the map to play next', () => {
  const map = (order: number, scoresClosed: boolean, isTiebreaker = false) => ({ order, scoresClosed, isTiebreaker });

  it('is the first map still open, in slot order', () => {
    expect(nextMapToPlay([map(2, false), map(1, true), map(3, false)])?.order).toBe(2);
  });

  it('puts the tiebreaker last, whatever its slot', () => {
    expect(nextMapToPlay([map(1, false, true), map(2, false)])?.order).toBe(2);
    expect(nextMapToPlay([map(1, false, true), map(2, true)])?.order).toBe(1);
  });

  it('is none once every map is closed', () => {
    expect(nextMapToPlay([map(1, true), map(2, true)])).toBeNull();
    expect(nextMapToPlay([])).toBeNull();
  });
});

describe('a start with two presses', () => {
  it('knows the ready phase and a player who left the song', () => {
    const parsed = parseTaStatus({ phase: 'ready', players: [{ playerId: 'p1', state: 'ready' }, { playerId: 'p2', state: 'quit' }] });
    expect('status' in parsed && parsed.status.phase).toBe('ready');
    expect(TA_PHASES).toEqual(['waiting', 'loading', 'ready', 'playing', 'finished', 'error']);
  });
});

describe('parseTaOptions', () => {
  it('defaults to players who cannot fail, and keeps what was stored', () => {
    expect(parseTaOptions(null)).toEqual(DEFAULT_TA_OPTIONS);
    expect(DEFAULT_TA_OPTIONS.disableFail).toBe(true);
    expect(parseTaOptions({ disableFail: false, disablePause: true })).toEqual({
      disableFail: false, disablePause: true, showScoreboard: false, autoClose: true,
      modifiers: [], disableScoresaberSubmission: false, disableCustomNotesOnStream: false,
    });
    // modifiers: unknown names go, and of a group that cannot be on together only the first in TA's order stays
    expect(parseTaOptions({ modifiers: ['SlowSong', 'NoBombs', 'FastSong', 'Nonsense', 'GhostNotes', 'DisappearingArrows'] }).modifiers).toEqual(['GhostNotes', 'NoBombs', 'FastSong']);
    expect(parseTaOptions({ autoClose: false }).autoClose).toBe(false);
  });

  it('ignores anything that is not a yes or no', () => {
    expect(parseTaOptions({ disableFail: 'no', showScoreboard: 1, extra: true })).toEqual(DEFAULT_TA_OPTIONS);
    expect(parseTaOptions('nonsense')).toEqual(DEFAULT_TA_OPTIONS);
  });
});

describe('a death in a TA song', () => {
  const nf = { disableFail: false, modifiers: ['NoFail' as const] };
  it('is seen when the No Fail modifier has halved the score', () => {
    expect(taHalvedByNoFail(nf, 400_000, 800_000)).toBe(true);
    expect(taHalvedByNoFail(nf, 800_000, 800_000)).toBe(false);
    // The final score against a slightly older plain score from the live feed.
    expect(taHalvedByNoFail(nf, 410_000, 800_000)).toBe(true);
    expect(taHalvedByNoFail(nf, 0, 0)).toBe(false);
  });
  it('is not read into a score other modifiers lowered', () => {
    const both = { disableFail: false, modifiers: ['NoFail' as const, 'NoArrows' as const] };
    expect(taModifierMultiplier(both.modifiers)).toBeCloseTo(0.7);
    expect(taHalvedByNoFail(both, 560_000, 800_000)).toBe(false);
    expect(taHalvedByNoFail(both, 280_000, 800_000)).toBe(true);
  });
  it("is never read from the score under TA's own cannot-fail, which halves nothing", () => {
    expect(taHalvedByNoFail({ disableFail: true, modifiers: ['NoFail'] }, 400_000, 800_000)).toBe(false);
    expect(taHalvedByNoFail({ disableFail: false, modifiers: [] }, 400_000, 800_000)).toBe(false);
  });
  it('is recorded at the whole score, flagged', () => {
    expect(taCountedScore({ shown: 400_000, halved: true, reportedFailed: false, maxScore: 1_000_000 })).toEqual({ score: 800_000, failed: true });
    expect(taCountedScore({ shown: 520_000, halved: true, reportedFailed: false, maxScore: 1_000_000 })).toEqual({ score: 1_000_000, failed: true });
    expect(taCountedScore({ shown: 800_000, halved: false, reportedFailed: true, maxScore: 1_000_000 })).toEqual({ score: 800_000, failed: true });
    expect(taCountedScore({ shown: 800_000, halved: false, reportedFailed: false, maxScore: 1_000_000 })).toEqual({ score: 800_000, failed: false });
  });
});

describe('a map typed for the free room', () => {
  it('is read from a key, a !bsr, a link or a hash', () => {
    expect(parseSongRef(' 2F4a1 ')).toEqual({ key: '2f4a1' });
    expect(parseSongRef('!bsr 2f4a1')).toEqual({ key: '2f4a1' });
    expect(parseSongRef('https://beatsaver.com/maps/2f4a1/')).toEqual({ key: '2f4a1' });
    expect(parseSongRef('custom_level_' + 'ab'.repeat(20))).toEqual({ hash: 'AB'.repeat(20) });
    expect(parseSongRef('not a map')).toBeNull();
    expect(parseSongRef('')).toBeNull();
  });
});

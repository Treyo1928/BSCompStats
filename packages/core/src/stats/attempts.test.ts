import { describe, expect, it } from 'vitest';
import { maxScoreForNotes, notesHit, notesPassed, pickBestRun, runEvidence, runProgress, type Run } from './attempts.js';

const spin = 'spin-eternally';
/** A run that reached `notes` notes at this accuracy, scored as BeatLeader would have it. */
const run = (over: Partial<Run> & { notes?: number }): Run => {
  const { notes = 200, ...rest } = over;
  const accuracy = rest.accuracy ?? 0.85;
  return {
    playerId: 'gayalex5',
    leaderboardId: spin,
    endType: 'FAIL',
    time: 100,
    timeset: 1_789_941_402,
    baseScore: Math.round(maxScoreForNotes(notes) * accuracy),
    ...rest,
    accuracy,
  };
};

describe('what recorded runs say', () => {
  it('reads the notes a run reached from its score and accuracy', () => {
    // gayalex5's first Spin Eternally run on 2026-09-21, as BeatLeader recorded it.
    const real = { baseScore: 15822, accuracy: 0.408257, missedNotes: 0, badCuts: 0 };
    expect(notesPassed(real)).toBe(51);
    expect(notesHit({ ...real, missedNotes: 3, badCuts: 1 })).toBe(47);
    for (const n of [1, 2, 3, 6, 7, 14, 15, 60, 500]) {
      expect(notesPassed({ baseScore: maxScoreForNotes(n) * 0.9, accuracy: 0.9 })).toBe(n);
    }
    expect(notesPassed({ baseScore: 0, accuracy: 0 })).toBe(0);
  });

  it('takes the longest run of ten notes or more as the score where there is no clear', () => {
    const { observations: obs, outcomes } = runEvidence({
      runs: [
        run({ endType: 'RESTART', time: 40, accuracy: 0.88 }),
        run({ endType: 'FAIL', time: 120, accuracy: 0.86 }),
        run({ endType: 'QUIT', time: 20, accuracy: 0.9 }),
      ],
      durations: { [spin]: 228 },
      cleared: new Set(),
    });
    // The longest, whatever kind of run it was: twenty seconds at 90% is easy, two minutes at 86% is not.
    expect(obs).toHaveLength(1);
    expect(obs[0]!.acc).toBeCloseTo(0.86, 6);
    expect(obs[0]!.weight).toBe(1);
    // Only the fail says the map was not finished; the others were a restart and an early quit.
    expect(outcomes).toEqual([{ playerId: 'gayalex5', leaderboardId: spin, finished: false }]);
  });

  it('never lets a run override a clear the player does have', () => {
    const { observations: obs, outcomes } = runEvidence({
      runs: [run({ time: 200, accuracy: 0.95 }), run({ endType: 'CLEAR', time: 228, accuracy: 0.9 })],
      durations: { [spin]: 228 },
      cleared: new Set([`gayalex5::${spin}`]),
    });
    expect(obs).toHaveLength(0);
    // Both runs still say whether the map gets finished.
    expect(outcomes.map((o) => o.finished)).toEqual([false, true]);
  });

  it('ignores the accuracy of runs that hit fewer than ten notes', () => {
    const { observations: obs, outcomes } = runEvidence({
      runs: [
        run({ endType: 'RESTART', time: 8.8, accuracy: 0.41, notes: 9 }),
        run({ endType: 'RESTART', time: 5.5, accuracy: 0.25, notes: 4 }),
        run({ endType: 'QUIT', time: 10.4, accuracy: 0.45, notes: 12, missedNotes: 3 }),
        run({ endType: 'FAIL', time: 14, accuracy: 0.7, notes: 14, badCuts: 5 }),
      ],
      durations: { [spin]: 228 },
      cleared: new Set(),
    });
    expect(obs).toHaveLength(0);
    // A fail is a fail, however short.
    expect(outcomes).toEqual([{ playerId: 'gayalex5', leaderboardId: spin, finished: false }]);
  });

  it('counts a quit as a fail once the run is well under way', () => {
    const { outcomes } = runEvidence({
      runs: [run({ endType: 'QUIT', time: 150, accuracy: 0.8 })],
      durations: { [spin]: 228 },
      cleared: new Set(),
    });
    expect(outcomes).toEqual([{ playerId: 'gayalex5', leaderboardId: spin, finished: false }]);
  });

  it('prefers accuracy only among runs within a tenth of the song of the longest', () => {
    const a = run({ time: 200, accuracy: 0.8 });
    const near = run({ time: 190, accuracy: 0.85 });
    const far = run({ time: 150, accuracy: 0.95 });
    expect(pickBestRun([a, near, far], 228)).toBe(near);
    expect(pickBestRun([a, far], 228)).toBe(a);
    // Length unknown: the margin is a tenth of the longest run itself.
    expect(pickBestRun([a, near, far])).toBe(near);
    expect(pickBestRun([a, run({ time: 175, accuracy: 0.99 })])).toBe(a);
  });

  it('counts a run that hit ten notes however quickly it ended', () => {
    const { observations: obs } = runEvidence({
      runs: [run({ endType: 'RESTART', time: 6, accuracy: 0.9, notes: 11, missedNotes: 1 })],
      durations: { [spin]: 228 },
      cleared: new Set(),
    });
    expect(obs.map((o) => o.acc)).toEqual([0.9]);
  });

  it('judges progress by the clock when the song length is unknown', () => {
    expect(runProgress({ time: 30, endType: 'FAIL' }, undefined)).toBeCloseTo(0.5, 6);
    expect(runProgress({ time: 30, endType: 'CLEAR' }, undefined)).toBe(1);
    expect(runProgress({ time: 30, endType: 'FAIL' }, 0)).toBeCloseTo(0.5, 6);
  });
});

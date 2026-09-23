import { describe, expect, it } from 'vitest';
import { buildPlayerProfiles, type ScoreDetail } from './profile.js';

describe('buildPlayerProfiles', () => {
  it('describes recorded scores, with abandoned runs counted but kept out of the averages', () => {
    const scores: ScoreDetail[] = [
      { playerId: 'p', leaderboardId: 'a', acc: 0.9, isDnf: false, fullCombo: true },
      { playerId: 'p', leaderboardId: 'b', acc: 0.96, isDnf: false, missedNotes: 2 },
      { playerId: 'p', leaderboardId: 'c', acc: 0.2, isDnf: true },
    ];
    const p = buildPlayerProfiles(scores).p!;
    expect(p.scoreCount).toBe(3);
    expect(p.cleanCount).toBe(2);
    expect(p.failCount).toBe(1);
    expect(p.meanAcc).toBeCloseTo(0.93, 9);
    expect(p.worstCleanAcc).toBe(0.9);
    expect(p.fcRate).toBe(0.5);
    expect(p.missRate).toBe(0.5);
  });
});

import { describe, expect, it } from 'vitest';
import { buildPlayerProfiles, type ScoreDetail } from './profile.js';

describe('buildPlayerProfiles', () => {
  it('describes recorded scores, counting every one however low', () => {
    const scores: ScoreDetail[] = [
      { playerId: 'p', leaderboardId: 'a', acc: 0.9, fullCombo: true },
      { playerId: 'p', leaderboardId: 'b', acc: 0.96, missedNotes: 2 },
      { playerId: 'p', leaderboardId: 'c', acc: 0.2 },
    ];
    const p = buildPlayerProfiles(scores).p!;
    expect(p.scoreCount).toBe(3);
    expect(p.meanAcc).toBeCloseTo((0.9 + 0.96 + 0.2) / 3, 9);
    expect(p.worstAcc).toBe(0.2);
    expect(p.fcRate).toBeCloseTo(1 / 3, 9);
    expect(p.missRate).toBeCloseTo(1 / 3, 9);
  });
});

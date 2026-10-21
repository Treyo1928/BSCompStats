import { describe, expect, it } from 'vitest';
import { DEFAULT_POINTS_CURVE, matchPoints } from './points.js';
import { aggregateTotals, mapResult, tallyMaps, type RecordedRun, type Scoring } from './scoring.js';

const ACC: Scoring = { mode: 'ACCURACY', curve: DEFAULT_POINTS_CURVE };
const POINTS: Scoring = { mode: 'MATCH_POINTS', curve: DEFAULT_POINTS_CURVE };
const MAX = 1_000_000;

const run = (teamId: string, playerId: string, accuracy: number, attempt = 1): RecordedRun => ({
  teamId,
  playerId,
  accuracy,
  score: Math.round(accuracy * MAX),
  attempt,
});

// A strong player carrying a new one, against two players in the middle.
const carried = [run('A', 'star', 0.98), run('A', 'new', 0.8), run('B', 'mid1', 0.9), run('B', 'mid2', 0.9)];

describe('deciding a map', () => {
  it('averages accuracy by default, as the sheets did', () => {
    const result = mapResult(carried, ['A', 'B'], ACC, 0.97);
    expect(result.winnerId).toBe('B');
    expect(result.teams.A!.accEquivalent).toBeCloseTo(0.89, 9);
    expect(result.catchUp).toBeCloseTo(0.01, 9);
  });

  it('curves each player before averaging, which is what makes the carried pair competitive', () => {
    const result = mapResult(carried, ['A', 'B'], POINTS, 0.97);
    expect(result.winnerId).toBe('A');
    // Curve first, then average - not the curve of the average accuracy.
    const expected = (matchPoints(0.98, 0.97, DEFAULT_POINTS_CURVE) + matchPoints(0.8, 0.97, DEFAULT_POINTS_CURVE)) / 2;
    expect(result.teams.A!.points).toBeCloseTo(expected, 9);
    expect(result.teams.A!.points).not.toBeCloseTo(matchPoints(0.89, 0.97, DEFAULT_POINTS_CURVE), 3);
    // Each player's own points are shown too.
    expect(result.teams.A!.runs.find((r) => r.playerId === 'star')!.points).toBeCloseTo(
      matchPoints(0.98, 0.97, DEFAULT_POINTS_CURVE),
      9,
    );
  });

  it('never lets the perfect accuracy decide who wins, only how big the points are', () => {
    for (const perfect of [0.9, 0.95, 0.99, null]) {
      expect(mapResult(carried, ['A', 'B'], POINTS, perfect).winnerId).toBe('A');
    }
    expect(mapResult(carried, ['A', 'B'], POINTS, null).teams.A!.points).toBeNull();
    // The accuracy the team's points come to does not move either.
    const eq = (p: number | null) => mapResult(carried, ['A', 'B'], POINTS, p).teams.B!.accEquivalent;
    expect(eq(0.9)).toBeCloseTo(eq(0.99), 9);
    expect(eq(null)).toBeCloseTo(0.9, 9);
  });

  it('says how much more accuracy each loser needed to draw level', () => {
    const result = mapResult(carried, ['A', 'B'], POINTS, 0.97);
    const needed = result.catchUp!;
    expect(needed).toBeGreaterThan(0);
    // Give both of B that much and the map is level.
    const lifted = [...carried.filter((r) => r.teamId === 'A'), run('B', 'mid1', 0.9 + needed), run('B', 'mid2', 0.9 + needed)];
    const after = mapResult(lifted, ['A', 'B'], POINTS, 0.97);
    expect(after.teams.B!.key).toBeCloseTo(after.teams.A!.key, 6);
  });

  describe('a replayed map', () => {
    // B's replay: mid1 much better, mid2 worse - better as a pair (0.92 vs 0.90).
    const replayed = [...carried, run('B', 'mid1', 0.99, 2), run('B', 'mid2', 0.85, 2)];

    it('counts the best pair run by default, never one player\'s first run beside the other\'s replay', () => {
      const team = mapResult(replayed, ['A', 'B'], ACC, 0.97).teams.B!;
      expect(team.accEquivalent).toBeCloseTo(0.92, 9);
      expect(team.attempt).toBe(2);
      expect(team.runs.every((r) => r.attempt === 2)).toBe(true);
      expect(team.goes.map((g) => [g.attempt, g.counted])).toEqual([[1, false], [2, true]]);
      expect(team.goes[0]!.accEquivalent).toBeCloseTo(0.9, 9);
    });

    it('keeps the first run when the replay was worse as a pair, even if one player improved', () => {
      const worse = [...carried, run('B', 'mid1', 0.95, 2), run('B', 'mid2', 0.8, 2)];
      const team = mapResult(worse, ['A', 'B'], ACC, 0.97).teams.B!;
      expect(team.accEquivalent).toBeCloseTo(0.9, 9);
      expect(team.attempt).toBe(1);
    });

    it('does not count a replay with only some of the pair posted yet', () => {
      const half = [...carried, run('B', 'mid1', 0.99, 2)];
      const team = mapResult(half, ['A', 'B'], ACC, 0.97).teams.B!;
      expect(team.attempt).toBe(1);
      expect(team.goes[1]!.complete).toBe(false);
    });

    it('can count each player\'s own best instead, where the tournament says so', () => {
      const team = mapResult(replayed, ['A', 'B'], { ...ACC, replays: 'BEST_EACH' }, 0.97).teams.B!;
      expect(team.accEquivalent).toBeCloseTo(0.945, 9);
      expect(team.attempt).toBeNull();
      expect(team.runs.find((r) => r.playerId === 'mid1')!.attempt).toBe(2);
      expect(team.runs.find((r) => r.playerId === 'mid2')!.attempt).toBe(1);
      expect(team.goes.some((g) => g.counted)).toBe(false);
    });

    it('decides by the best pair under the curve too', () => {
      const team = mapResult(replayed, ['A', 'B'], POINTS, 0.97).teams.B!;
      const best = Math.max(...team.goes.map((g) => g.key));
      expect(team.key).toBe(best);
    });
  });

  it('says how much more each loser alone would have needed, the other\'s run as it was', () => {
    for (const scoring of [ACC, POINTS]) {
      const result = mapResult(carried, ['A', 'B'], scoring, 0.97);
      const loser = result.winnerId === 'A' ? 'B' : 'A';
      const winner = result.teams[result.winnerId!]!;
      for (const counted of result.teams[loser]!.runs) {
        const alone = result.catchUpAlone[counted.playerId];
        if (alone == null) continue;
        expect(alone).toBeGreaterThan(result.catchUp!);
        const lifted = carried.map((r) =>
          r.teamId === loser && r.playerId === counted.playerId ? { ...r, accuracy: r.accuracy + alone } : r,
        );
        expect(mapResult(lifted, ['A', 'B'], scoring, 0.97).teams[loser]!.key).toBeCloseTo(winner.key, 6);
      }
    }
    // Under accuracy, one of two has to make up twice the gap in averages.
    expect(mapResult(carried, ['A', 'B'], ACC, 0.97).catchUpAlone.star).toBeCloseTo(0.02, 9);
    // Where even 100% would not have done it, there is no figure.
    const far = [run('A', 'x', 0.99), run('A', 'y', 0.99), run('B', 'p', 0.99), run('B', 'q', 0.5)];
    expect(mapResult(far, ['A', 'B'], ACC, null).catchUpAlone.p).toBeNull();
  });

  it('counts a failed run as scored unless fails count double', () => {
    // Stored doubled back from No Fail's halving: 0.9 here was 0.45 on the results screen.
    const failed = [run('A', 'x', 0.9), { ...run('A', 'y', 0.9), failed: true }, run('B', 'p', 0.8), run('B', 'q', 0.8)];
    const plain = mapResult(failed, ['A', 'B'], ACC, null);
    expect(plain.teams.A!.accEquivalent).toBeCloseTo(0.675, 9);
    expect(plain.winnerId).toBe('B');
    const doubled = mapResult(failed, ['A', 'B'], { ...ACC, doubleFails: true }, null);
    expect(doubled.teams.A!.accEquivalent).toBeCloseTo(0.9, 9);
    expect(doubled.winnerId).toBe('A');
  });

  it('waits for both sides before calling a map', () => {
    const result = mapResult(carried.filter((r) => r.teamId === 'A'), ['A', 'B'], ACC, 0.97);
    expect(result.decided).toBe(false);
    expect(result.winnerId).toBeNull();
  });
});

describe('the match', () => {
  const maps = [
    { isTiebreaker: false, perfectAcc: 0.97, attempts: carried },
    { isTiebreaker: false, perfectAcc: 0.97, attempts: [run('A', 'star', 0.95), run('B', 'mid1', 0.96)] },
    { isTiebreaker: true, perfectAcc: 0.97, attempts: [run('A', 'star', 0.97), run('B', 'mid1', 0.9)] },
  ];

  it('tallies maps under the match\'s scoring, with the tiebreaker only when level', () => {
    expect(tallyMaps(maps, 'A', 'B', ACC)).toEqual({ a: 0, b: 2 });
    expect(tallyMaps(maps, 'A', 'B', POINTS)).toEqual({ a: 2, b: 1 });
  });

  it('totals scores, or points, for a format decided on aggregate', () => {
    const acc = aggregateTotals(maps, 'A', 'B', ACC);
    expect(acc.a).toBe(980_000 + 800_000 + 950_000 + 970_000);
    const points = aggregateTotals(maps, 'A', 'B', POINTS);
    expect(points.a).toBeGreaterThan(points.b);
  });
});

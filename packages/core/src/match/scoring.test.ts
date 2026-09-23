import { describe, expect, it } from 'vitest';
import { DEFAULT_POINTS_CURVE, matchPoints } from './points.js';
import { aggregateTotals, mapResult, tallyMaps, type RecordedRun, type Scoring } from './scoring.js';

const ACC: Scoring = { mode: 'ACCURACY', curve: DEFAULT_POINTS_CURVE };
const POINTS: Scoring = { mode: 'MATCH_POINTS', curve: DEFAULT_POINTS_CURVE };
const MAX = 1_000_000;

const run = (teamId: string, playerId: string, accuracy: number): RecordedRun => ({
  teamId,
  playerId,
  accuracy,
  score: Math.round(accuracy * MAX),
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

  it('counts each player\'s best run when a map is replayed', () => {
    const runs = [...carried, run('B', 'mid1', 0.99)];
    expect(mapResult(runs, ['A', 'B'], ACC, 0.97).teams.B!.accEquivalent).toBeCloseTo(0.945, 9);
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

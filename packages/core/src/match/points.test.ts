import { describe, expect, it } from 'vitest';
import {
  accuracyForPoints,
  DEFAULT_POINTS_CURVE,
  matchPoints,
  parsePointsCurve,
  rawCurve,
} from './points.js';

const curve = DEFAULT_POINTS_CURVE;

describe('the match points curve', () => {
  it('uses the parameters of Wynttter\'s sheet by default', () => {
    expect(curve).toEqual({ padding: 0.03, slope: 80, perfectPoints: 100 });
  });

  it('is worth the perfect points at the map\'s perfect accuracy, and more above it', () => {
    expect(matchPoints(0.995, 0.995, curve)).toBeCloseTo(100, 9);
    expect(matchPoints(0.95, 0.95, curve)).toBeCloseTo(100, 9);
    expect(matchPoints(0.999, 0.995, curve)).toBeGreaterThan(100);
  });

  it('matches the formula worked by hand', () => {
    // Brown Eyes (Hard), max score 398,469, perfect 99.5%: 370,000 is 92.855%.
    // raw = 1/(1.03 - 0.928554) + 80 * 0.928554 = 9.85768 + 74.28432
    const acc = 370_000 / 398_469;
    expect(rawCurve(acc, curve)).toBeCloseTo(1 / (1.03 - acc) + 80 * acc, 12);
    expect(matchPoints(acc, 0.995, curve)).toBeCloseTo(77.7856, 3);
  });

  it('climbs faster the nearer it gets to 100%', () => {
    const step = (from: number) => matchPoints(from + 0.01, 0.97, curve) - matchPoints(from, 0.97, curve);
    expect(step(0.98)).toBeGreaterThan(step(0.9));
    expect(step(0.9)).toBeGreaterThan(step(0.6));
  });

  it('runs backwards to the accuracy that earns a number of points', () => {
    for (const acc of [0, 0.5, 0.8, 0.93, 0.99, 1]) {
      const points = matchPoints(acc, 0.98, curve);
      expect(accuracyForPoints(points, 0.98, curve)).toBeCloseTo(acc, 9);
    }
    // More than 100% can earn is not an accuracy.
    expect(accuracyForPoints(matchPoints(1, 0.98, curve) + 1, 0.98, curve)).toBeNull();
    expect(accuracyForPoints(-5, 0.98, curve)).toBe(0);
  });

  it('falls back to the defaults for settings that are missing or nonsense', () => {
    expect(parsePointsCurve(null)).toEqual(curve);
    expect(parsePointsCurve({ slope: 150 })).toEqual({ ...curve, slope: 150 });
    expect(parsePointsCurve({ padding: -1 })).toEqual(curve);
  });
});

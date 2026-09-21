import { describe, it, expect } from 'vitest';
import { categorizeMap } from './categorize.js';

// Ratings as BeatLeader reports them for maps from real pools.
describe('categorizeMap', () => {
  it.each([
    ["buggin'", { pass: 10.6, tech: 3.3, acc: 10.2 }, 'speed'],
    ['AKRASiEL', { pass: 9.2, tech: 2.8, acc: 9.2 }, 'speed'],
    ['Spin Eternally', { pass: 7.2, tech: 5.2, acc: 10.1 }, 'speed-tech'],
    ['Pedi', { pass: 5.4, tech: 8.7, acc: 10.2 }, 'tech'],
    ['Konpeito Extremists', { pass: 4.6, tech: 7.7, acc: 9.3 }, 'tech'],
    ['Annihilation', { pass: 3.2, tech: 2.6, acc: 6.8 }, 'low-tech'],
    ['Hush', { pass: 1.9, tech: 5.5, acc: 9.4 }, 'tech-acc'],
    ['Cicada', { pass: 1.7, tech: 2.2, acc: 5.5 }, 'acc'],
    ['enjoy the ride', { pass: 1.3, tech: 1.2, acc: 4.6 }, 'true acc'],
  ])('%s', (_name, ratings, expected) => {
    expect(categorizeMap(ratings)).toBe(expected);
  });

  it('says nothing about a map BeatLeader has not rated', () => {
    expect(categorizeMap({ pass: 0, tech: 0, acc: 0 })).toBeNull();
  });
});

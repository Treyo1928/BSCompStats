import { describe, expect, it } from 'vitest';
import { draftSequence, draftTeamSizes, nextDraftSlot, parseDraftSettings } from './draft.js';

const snake = { order: 'SNAKE', firstPick: 'A', shareOdd: false } as const;
const alternate = { order: 'ALTERNATE', firstPick: 'A', shareOdd: false } as const;

describe('draftSequence', () => {
  it('alternates', () => {
    expect(draftSequence(alternate, 4).join('')).toBe('ABAB');
  });

  it('snakes, so first pick gives the next two away', () => {
    expect(draftSequence(snake, 6).join('')).toBe('ABBAAB');
  });

  it('starts with whoever was given first pick', () => {
    expect(draftSequence({ ...snake, firstPick: 'B' }, 4).join('')).toBe('BAAB');
  });

  it('shares the last player of an odd pool when asked to', () => {
    expect(draftSequence({ ...snake, shareOdd: true }, 5)).toEqual(['A', 'B', 'B', 'A', 'BOTH']);
  });

  it('leaves an even pool alone when sharing is on', () => {
    expect(draftSequence({ ...alternate, shareOdd: true }, 4).join('')).toBe('ABAB');
  });

  it('gives an odd pool its extra pick when sharing is off', () => {
    expect(draftSequence(alternate, 3).join('')).toBe('ABA');
  });

  it('shares a pool of one', () => {
    expect(draftSequence({ ...snake, shareOdd: true }, 1)).toEqual(['BOTH']);
  });

  it('is empty for an empty pool', () => {
    expect(draftSequence(snake, 0)).toEqual([]);
  });
});

describe('nextDraftSlot', () => {
  it('walks the sequence and ends', () => {
    expect(nextDraftSlot(snake, 3, 0)).toBe('A');
    expect(nextDraftSlot(snake, 3, 1)).toBe('B');
    expect(nextDraftSlot(snake, 3, 2)).toBe('B');
    expect(nextDraftSlot(snake, 3, 3)).toBeNull();
  });
});

describe('draftTeamSizes', () => {
  it('counts captains, and the shared player on both sides', () => {
    expect(draftTeamSizes({ ...snake, shareOdd: true }, 5)).toEqual({ a: 4, b: 4 });
    expect(draftTeamSizes(alternate, 5)).toEqual({ a: 4, b: 3 });
    expect(draftTeamSizes(snake, 6)).toEqual({ a: 4, b: 4 });
  });
});

describe('parseDraftSettings', () => {
  it('falls back to a snake draft with A first', () => {
    expect(parseDraftSettings({ order: 'nonsense', firstPick: null })).toEqual({
      order: 'SNAKE',
      firstPick: 'A',
      shareOdd: false,
    });
  });
});

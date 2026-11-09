import { describe, it, expect } from 'vitest';
import { dayIn, endOfDay, narrowWindows, outsideWindow, startOfDay } from './score-window.js';

describe('score window days (US Central)', () => {
  it('starts at 12:00 AM Central, standard and daylight time', () => {
    expect(startOfDay('2026-11-02')!.toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(startOfDay('2026-07-04')!.toISOString()).toBe('2026-07-04T05:00:00.000Z');
  });

  it('ends at 11:59:59.999 PM Central', () => {
    expect(endOfDay('2026-11-02')!.toISOString()).toBe('2026-11-03T05:59:59.999Z');
    expect(endOfDay('2026-07-04')!.toISOString()).toBe('2026-07-05T04:59:59.999Z');
  });

  it('gets the clock-change days right', () => {
    // 2026-03-08 is 23 hours long in Central, 2026-11-01 is 25.
    expect(endOfDay('2026-03-08')!.getTime() + 1 - startOfDay('2026-03-08')!.getTime()).toBe(23 * 3_600_000);
    expect(endOfDay('2026-11-01')!.getTime() + 1 - startOfDay('2026-11-01')!.getTime()).toBe(25 * 3_600_000);
    expect(endOfDay('2026-12-31')!.toISOString()).toBe('2027-01-01T05:59:59.999Z');
  });

  it('refuses what is not a day', () => {
    expect(startOfDay('2026-02-30')).toBeNull();
    expect(startOfDay('soon')).toBeNull();
    expect(endOfDay('')).toBeNull();
  });

  it('reads a moment back as its Central day', () => {
    expect(dayIn(startOfDay('2026-11-02')!)).toBe('2026-11-02');
    expect(dayIn(endOfDay('2026-11-02')!)).toBe('2026-11-02');
    // 11:56 PM UTC on Nov 2 is 5:56 PM Central the same day.
    expect(dayIn(new Date('2026-11-02T23:56:00Z'))).toBe('2026-11-02');
  });
});

describe('outsideWindow', () => {
  const w = { from: 1000, until: 2000 };
  it('keeps both ends and what is between', () => {
    expect([999, 1000, 1500, 2000, 2001].map((t) => outsideWindow(w, t))).toEqual([true, false, false, false, true]);
  });
  it('leaves an end open when unset, and keeps unknown times', () => {
    expect(outsideWindow({ from: null, until: 2000 }, 1)).toBe(false);
    expect(outsideWindow({ from: 1000, until: null }, 99_999)).toBe(false);
    expect(outsideWindow(w, 0)).toBe(false);
    expect(outsideWindow(undefined, 5)).toBe(false);
  });
  it('narrows two windows to what both allow', () => {
    expect(narrowWindows({ from: 10, until: null }, { from: 5, until: 50 })).toEqual({ from: 10, until: 50 });
  });
});

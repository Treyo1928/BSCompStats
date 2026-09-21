import { describe, expect, it } from 'vitest';
import { buildSpecialty, kindSpread, type KindStandingInput } from './specialty.js';
import { buildPpProfile } from './pp-profile.js';

const kind = (name: string, gap: number | null, spread: number | null, maps = 3, comparisons = 12): KindStandingInput => ({
  kind: name,
  gap,
  spread,
  maps,
  comparisons,
});
const specialty = (kinds: KindStandingInput[], scoreCount = 10) => buildSpecialty({ kinds, scoreCount });

// Roughly the live board: speed maps spread the field ten times as far as acc maps.
const SPREAD = { Speed: 0.12, Tech: 0.08, Acc: 0.012 };

describe('buildSpecialty', () => {
  it('does not make every strong player a speed specialist', () => {
    // Biggest lead in points is on Speed for both - as it is for anyone good. In
    // each kind's own terms, one is furthest ahead on Tech and the other on Acc.
    const treyo = specialty([kind('Speed', 0.111, SPREAD.Speed), kind('Tech', 0.09, SPREAD.Tech), kind('Acc', 0.009, SPREAD.Acc)]);
    const zolism = specialty([kind('Speed', 0.078, SPREAD.Speed), kind('Tech', 0.03, SPREAD.Tech), kind('Acc', 0.024, SPREAD.Acc)]);
    expect(treyo.label).toBe('Tech specialist · Worst on Acc');
    expect(zolism.label).toBe('Acc specialist · Worst on Tech');
  });

  it('lets two players share a specialty', () => {
    const ls = specialty([kind('Speed', 0.3, SPREAD.Speed), kind('Tech', 0.064, SPREAD.Tech), kind('Acc', 0.018, SPREAD.Acc)]);
    const other = specialty([kind('Speed', 0.25, SPREAD.Speed), kind('Tech', 0.02, SPREAD.Tech), kind('Acc', 0.001, SPREAD.Acc)]);
    expect(ls.best!.kind).toBe('Speed');
    expect(other.best!.kind).toBe('Speed');
  });

  it('gives the weakest player a specialty and the strongest a worst kind', () => {
    const weakest = specialty([kind('Speed', -0.196, SPREAD.Speed), kind('Tech', -0.026, SPREAD.Tech), kind('Acc', -0.055, SPREAD.Acc)]);
    expect(weakest.status).toBe('RANGE');
    expect(weakest.label).toBe('Tech specialist · Worst on Acc');
    const strongest = specialty([kind('Speed', 0.152, SPREAD.Speed), kind('Tech', 0.064, SPREAD.Tech), kind('Acc', 0.018, SPREAD.Acc)]);
    expect(strongest.badges.map((b) => b.tone)).toEqual(['good', 'warn']);
  });

  it('leaves out a kind they have not played, or that too few players can be compared on', () => {
    const s = specialty([kind('Speed', 0.1, SPREAD.Speed), kind('Tech', 0.01, SPREAD.Tech), kind('Solo', 0.5, null), kind('Acc', null, SPREAD.Acc, 0)]);
    expect(s.kinds.map((k) => k.kind)).toEqual(['Speed', 'Tech']);
  });

  it('does not let a kind that has separated nobody decide anything', () => {
    // A hair ahead on a kind where everyone is level is not a specialty.
    const s = specialty([kind('Flat', 0.002, 0.0001), kind('Tech', 0.08, SPREAD.Tech), kind('Acc', -0.01, SPREAD.Acc)]);
    expect(s.best!.kind).toBe('Tech');
  });

  it('names neither with one kind, too few scores, or nothing to compare', () => {
    expect(specialty([kind('Tech', 0.05, SPREAD.Tech)]).status).toBe('ONE_KIND');
    expect(specialty([kind('Tech', 0.05, SPREAD.Tech), kind('Acc', 0, SPREAD.Acc)], 2).status).toBe('TOO_FEW');
    expect(specialty([kind('Tech', null, null)]).status).toBe('NOTHING_SHARED');
  });
});

describe('buildSpecialty, with a ranked history', () => {
  // corn, 2026-09-21: called a "Tech Acc" player off three shared maps, while
  // earning half his pp on Speed maps.
  const shared = [kind('Tech Acc', -0.007, SPREAD.Acc, 3, 6), kind('Speed', -0.014, SPREAD.Speed), kind('Tech', -0.03, SPREAD.Tech)];
  const many = (n: number, pp: number) => Array.from({ length: n }, (_, i) => pp - i);
  const corn = buildPpProfile([
    ...many(40, 420).map((pp) => ({ kind: 'Speed', pp })),
    ...many(30, 400).map((pp) => ({ kind: 'Speed Tech', pp })),
    ...many(10, 300).map((pp) => ({ kind: 'Tech', pp })),
  ]);

  it('reads the specialty from where they earn their pp, not from accuracy on shared maps', () => {
    const s = buildSpecialty({ kinds: shared, scoreCount: 324, pp: corn, fieldShare: { Speed: 0.26, 'Speed Tech': 0.45, Tech: 0.25 } });
    expect(s.source).toBe('PP');
    expect(s.badges[0]!.label).toBe('Speed specialist');
    expect(s.badges[1]!.label).toBe('Lighter on Tech');
  });

  it('falls back to shared maps without a ranked history, and needs real evidence there', () => {
    const s = buildSpecialty({ kinds: [kind('Tech', 0.113, SPREAD.Tech, 2, 3), ...shared], scoreCount: 16, pp: null });
    expect(s.source).toBe('SHARED_MAPS');
    expect(s.kinds.filter((k) => k.kind === 'Tech')).toHaveLength(1);
  });
});

describe('kindSpread', () => {
  it('is the spread of players\' gaps, and needs three of them', () => {
    expect(kindSpread([0.1, -0.1, 0])).toBeCloseTo(0.1);
    expect(kindSpread([0.1, null, -0.1])).toBeNull();
  });
});

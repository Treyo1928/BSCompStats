import { describe, expect, it } from 'vitest';
import { buildPpProfile, kindPp, meanShare } from './pp-profile.js';

const scores = (spec: Record<string, number[]>) =>
  Object.entries(spec).flatMap(([kind, pps]) => pps.map((pp) => ({ kind, pp })));
const many = (n: number, pp: number) => Array.from({ length: n }, (_, i) => pp - i);

describe('buildPpProfile', () => {
  it('says where a player earns their pp', () => {
    // A speed player: their best scores are nearly all on speed maps.
    const profile = buildPpProfile(scores({ Speed: many(20, 400), Tech: many(10, 250), Acc: many(5, 120) }))!;
    expect(Object.entries(profile.share).sort((a, b) => b[1] - a[1])[0]![0]).toBe('Speed');
    expect(profile.share.Speed!).toBeGreaterThan(0.6);
    expect(Object.values(profile.share).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('weights scores as BeatLeader does, so a pile of weak scores does not outvote a few strong ones', () => {
    const profile = buildPpProfile(scores({ Tech: many(5, 500), Acc: many(40, 60) }))!;
    expect(profile.share.Tech!).toBeGreaterThan(profile.share.Acc!);
  });

  it('refuses a profile resting on a handful of scores, and ignores maps with no kind', () => {
    expect(buildPpProfile(scores({ Speed: many(6, 300) }))).toBeNull();
    expect(buildPpProfile([...scores({ Speed: many(19, 300) }), { kind: null, pp: 500 }])).toBeNull();
  });
});

describe('kindPp', () => {
  it('ranks within a kind by what has been proved on it, whatever else they play', () => {
    const speedPlayer = kindPp(scores({ Speed: many(30, 400), Tech: many(3, 200) }));
    const techPlayer = kindPp(scores({ Speed: many(4, 380), Tech: many(40, 450) }));
    expect(speedPlayer.Speed!).toBeGreaterThan(techPlayer.Speed!);
    expect(techPlayer.Tech!).toBeGreaterThan(speedPlayer.Tech!);
  });
});

describe('meanShare', () => {
  it('averages profiles, counting a kind someone has none of as zero', () => {
    const a = buildPpProfile(scores({ Speed: many(20, 300) }))!;
    const b = buildPpProfile(scores({ Tech: many(20, 300) }))!;
    expect(meanShare([a, b])).toEqual({ Speed: 0.5, Tech: 0.5 });
  });
});

import { describe, expect, it } from 'vitest';
import { canonicalKind, compareOnSharedMaps, indexScores, rankByGap, sortKinds } from './standings.js';

const score = (playerId: string, leaderboardId: string, acc: number, isDnf = false) => ({
  playerId,
  leaderboardId,
  acc,
  isDnf,
});

describe('compareOnSharedMaps', () => {
  // `thin` has only played the easy map. `full` has played both, and is far
  // better on the one they share - but carries a poor score on the hard one.
  const index = indexScores([
    score('thin', 'easy', 0.8),
    score('full', 'easy', 0.96),
    score('full', 'hard', 0.6),
    score('mate', 'easy', 0.95),
    score('mate', 'hard', 0.85),
  ]);

  it('ignores maps only one of them has played', () => {
    const thin = compareOnSharedMaps(index, 'thin', ['full', 'mate']);
    expect(thin.comparisons).toBe(2);
    expect(thin.maps).toBe(1);
    expect(thin.gap).toBeCloseTo((0.8 - 0.96 + 0.8 - 0.95) / 2);
  });

  it('ranks the player who is behind on shared maps last, however their averages read', () => {
    // Raw averages: thin 80%, full 78%. On shared maps thin is 15 points down.
    const gaps = new Map(
      ['thin', 'full', 'mate'].map((id) => [id, compareOnSharedMaps(index, id, ['thin', 'full', 'mate']).gap]),
    );
    const ranks = rankByGap(gaps);
    expect(ranks.get('thin')).toBe(3);
    expect(ranks.get('mate')).toBe(1);
  });

  it('can be taken over one kind of map', () => {
    const hardOnly = compareOnSharedMaps(index, 'full', ['mate'], (id) => id === 'hard');
    expect(hardOnly.gap).toBeCloseTo(-0.25);
    expect(compareOnSharedMaps(index, 'thin', ['mate'], (id) => id === 'hard').gap).toBeNull();
  });

  it('leaves abandoned runs out', () => {
    const withDnf = indexScores([score('a', 'm', 0.2, true), score('b', 'm', 0.9)]);
    expect(compareOnSharedMaps(withDnf, 'a', ['b']).gap).toBeNull();
  });

  it('does not rank someone with nothing to compare', () => {
    expect(rankByGap(new Map([['a', 0.01], ['b', null]])).get('b')).toBeNull();
  });
});

describe('canonicalKind', () => {
  it('gives an organiser\'s tag and the ratings guess the same spelling', () => {
    expect(canonicalKind('tech')).toBe('Tech');
    expect(canonicalKind('Tech')).toBe('Tech');
    expect(canonicalKind('speed-tech')).toBe('Speed Tech');
    expect(canonicalKind('true acc')).toBe('True Acc');
    expect(canonicalKind('tech-acc')).toBe('Tech Acc');
  });

  it('keeps kinds apart: Speed Tech is not Tech', () => {
    expect(canonicalKind('speed-tech')).not.toBe(canonicalKind('tech'));
  });

  it('tidies an organiser\'s own word, and treats blank as none', () => {
    expect(canonicalKind('  midspeed ')).toBe('Midspeed');
    expect(canonicalKind('low-tech')).toBe('Low Tech');
    expect(canonicalKind('  ')).toBeNull();
    expect(canonicalKind(null)).toBeNull();
  });

  it('lists the usual kinds first, in the usual order', () => {
    expect(sortKinds(['Speed', 'Midspeed', 'Acc', 'Tech', 'Acc'])).toEqual(['Acc', 'Tech', 'Speed', 'Midspeed']);
  });
});

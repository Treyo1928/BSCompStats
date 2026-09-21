import { describe, expect, it } from 'vitest';
import type { PlayerProfile, ScoreDetail } from './profile.js';
import { buildPlayStyles } from './style.js';

const profile = (playerId: string, over: Partial<PlayerProfile> = {}): PlayerProfile => ({
  playerId,
  scoreCount: 6,
  skill: 0,
  sigma: 0.3,
  meanAcc: 0.95,
  medianAcc: 0.95,
  accStdev: 0.01,
  bestAcc: 0.96,
  worstCleanAcc: 0.94,
  fcRate: 0.2,
  missRate: 0.8,
  pauseRate: 0,
  handBalance: 0,
  failRate: 0,
  failCount: 0,
  categoryAffinity: {},
  categoryAccDelta: {},
  lastPlayedAt: null,
  ...over,
});

const categories = { t1: 'Tech', t2: 'Tech', s1: 'Speed', a1: 'Acc' };
const scoresFor = (playerId: string, ids: string[]): ScoreDetail[] =>
  ids.map((leaderboardId) => ({ playerId, leaderboardId, acc: 0.95, isDnf: false }));

const build = (profiles: PlayerProfile[], scores: ScoreDetail[] = []) =>
  buildPlayStyles({
    profiles: Object.fromEntries(profiles.map((p) => [p.playerId, p])),
    scores,
    categories,
  });

describe('buildPlayStyles', () => {
  it('names a specialist when the lean is real and rests on more than one map', () => {
    const styles = build(
      [profile('p', { categoryAffinity: { Tech: 0.4, Speed: -0.3, Acc: 0 } }), profile('q'), profile('r')],
      scoresFor('p', ['t1', 't2', 's1', 'a1']),
    );
    expect(styles.p!.label).toBe('Tech specialist');
    expect(styles.p!.categories.map((c) => c.category)).toEqual(['Tech', 'Acc', 'Speed']);
    expect(styles.p!.categories[0]!.maps).toBe(2);
    expect(styles.p!.traits.map((t) => t.key)).toEqual(expect.arrayContaining(['strength', 'weakness']));
  });

  it('does not crown a specialist on one map, but still lists the lean', () => {
    const styles = build(
      [profile('p', { categoryAffinity: { Speed: 0.5, Tech: -0.2 } }), profile('q'), profile('r')],
      scoresFor('p', ['s1', 't1', 't2']),
    );
    expect(styles.p!.archetype).toBe('ALL_ROUNDER');
    expect(styles.p!.summary).toContain('The exception so far is Speed');
    expect(styles.p!.traits.find((t) => t.key === 'strength')?.detail).toContain('thin evidence');
  });

  it('calls the strong, predictable player the anchor', () => {
    const styles = build([
      profile('top', { skill: 1, sigma: 0.1 }),
      profile('mid', { skill: 0, sigma: 0.3 }),
      profile('low', { skill: -1, sigma: 0.3 }),
    ]);
    expect(styles.top!.archetype).toBe('ANCHOR');
    expect(styles.top!.percentiles.skill).toBe(1);
    expect(styles.low!.percentiles.skill).toBe(0);
    expect(styles.mid!.archetype).toBe('ALL_ROUNDER');
  });

  it('calls a wide spread streaky', () => {
    const styles = build([profile('wild', { sigma: 0.9 }), profile('a'), profile('b')]);
    expect(styles.wild!.archetype).toBe('STREAKY');
  });

  it('says nothing about a player with too few scores', () => {
    const styles = build([
      profile('new', { scoreCount: 2, categoryAffinity: { Tech: 2 }, handBalance: 5 }),
      profile('a'),
    ]);
    expect(styles.new!.thin).toBe(true);
    expect(styles.new!.archetype).toBe('UNKNOWN');
    expect(styles.new!.traits).toEqual([]);
  });

  it('reports hand balance and abandoned runs', () => {
    const styles = build([profile('p', { handBalance: -1.6, failCount: 1 }), profile('q')]);
    const keys = styles.p!.traits.map((t) => t.key);
    expect(keys).toContain('hand');
    expect(keys).toContain('abandons');
    expect(styles.p!.traits.find((t) => t.key === 'hand')!.label).toBe('Right hand leads');
  });
});

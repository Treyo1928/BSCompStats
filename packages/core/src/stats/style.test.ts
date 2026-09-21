import { describe, expect, it } from 'vitest';
import { qualsObservations } from './__fixtures__/quals.js';
import { fitSkillModel } from './model.js';
import { classifyFails } from './normalize.js';
import { buildPlayerProfiles, type PlayerProfile, type ScoreDetail } from './profile.js';
import { buildPlayStyles } from './style.js';

const profile = (playerId: string, over: Partial<PlayerProfile> = {}): PlayerProfile => ({
  playerId,
  scoreCount: 6,
  skill: 0,
  rating: over.skill ?? 0,
  cleanCount: 6,
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
const level = { Tech: 0, Speed: 0, Acc: 0 };

const build = (profiles: PlayerProfile[], scores: ScoreDetail[] = []) =>
  buildPlayStyles({
    profiles: Object.fromEntries(profiles.map((p) => [p.playerId, p])),
    scores,
    categories,
  });

describe('buildPlayStyles', () => {
  it('passes no verdict on what anyone is good or bad at', () => {
    // A heavy lean against their own level is kept as a figure, and nothing more:
    // whether it matters depends on their teammates, which this cannot see.
    const styles = build(
      [profile('p', { categoryAffinity: { Speed: -0.9, Tech: 0.4, Acc: 0 } }), profile('q', { categoryAffinity: level })],
      scoresFor('p', ['s1', 't1', 't2', 'a1']),
    );
    expect(styles.p!.categories.map((c) => c.category)).toEqual(['Tech', 'Acc', 'Speed']);
    expect(styles.p!.categories[0]).toMatchObject({ maps: 2, fieldRank: 1, fieldSize: 2 });
    expect(styles.p!.traits.map((t) => t.key)).not.toEqual(expect.arrayContaining(['strength']));
    expect(styles.p!.traits.map((t) => t.key)).not.toEqual(expect.arrayContaining(['weakness']));
    expect(styles.p).not.toHaveProperty('label');
  });

  it('calls a tight spread consistent, given enough scores to know', () => {
    const styles = build([
      profile('steady', { sigma: 0.1, categoryAffinity: level }),
      profile('few', { sigma: 0.1, scoreCount: 3, cleanCount: 3, categoryAffinity: level }),
      profile('a', { categoryAffinity: level }),
      profile('b', { categoryAffinity: level }),
    ]);
    expect(styles.steady!.traits.map((t) => t.key)).toContain('consistent');
    expect(styles.few!.traits.map((t) => t.key)).not.toContain('consistent');
    expect(styles.steady!.percentiles.consistency).toBe(1);
  });

  it('calls a wide spread streaky', () => {
    const styles = build([profile('wild', { sigma: 0.9 }), profile('a'), profile('b')]);
    expect(styles.wild!.traits.map((t) => t.key)).toContain('streaky');
  });

  it('says nothing about a player with too few scores', () => {
    const styles = build([profile('new', { scoreCount: 2, handBalance: 5 }), profile('a')]);
    expect(styles.new!.thin).toBe(true);
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

describe('rating, on the real MSU board', () => {
  const raw = qualsObservations();
  const flags = classifyFails(raw);
  const scores = raw.map((o, i) => ({ ...o, isDnf: flags[i]! }));
  const model = fitSkillModel(scores, { latentFactors: 0, biasRegularization: 0.5 });
  const profiles = buildPlayerProfiles({ scores, model });

  it('does not let three easy-map scores outrank seven that include the hard maps', () => {
    // Alex has played the three easiest maps and nothing else. Kadence has
    // played all seven, and carries a 50% on Spin Eternally for it.
    expect(profiles.alex!.skill).toBeGreaterThan(profiles.kadence!.skill);
    expect(profiles.alex!.rating).toBeLessThan(profiles.kadence!.rating);
  });

  it('still ranks a short record above a long one when it is clearly better', () => {
    expect(profiles.will!.cleanCount).toBe(3);
    expect(profiles.will!.rating).toBeGreaterThan(profiles.cat!.rating);
  });
});

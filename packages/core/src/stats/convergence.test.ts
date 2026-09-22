import { describe, expect, it } from 'vitest';
import { fitSkillModel, type Observation, type SkillModel } from './model.js';
import { fitBestModel } from './cv.js';
import fixture from './fixtures/msu-fall-2026.json' with { type: 'json' };

/**
 * The MSU fall 2026 board as it stood on 2026-09-22: twelve players, four
 * pools, 207 best scores. It is the case that found two faults at once.
 *
 * gayalex5 had ten scores, every one on an acc map, and was 1-2 points behind
 * LS and Treyo on every map the three had in common. The one-factor model,
 * stopped after forty sweeps, put gayalex5 at 93% on Spin Eternally - above
 * LS's real 90.5% - and the outlook called the map lost 84:16 for a duo that
 * would win it comfortably.
 */
const observations = fixture as Observation[];

const spin = 'spin-eternally';

const players = [...new Set(observations.map((o) => o.playerId))];
const maps = [...new Set(observations.map((o) => o.leaderboardId))];
/** Largest difference between two fits' predictions over every cell, in accuracy points. */
const maxDrift = (a: SkillModel, b: SkillModel): number =>
  Math.max(
    ...players.flatMap((p) => maps.map((m) => Math.abs(a.predict(p, m).acc - b.predict(p, m).acc))),
  ) * 100;

describe('fitting to convergence', () => {
  it('stops when the parameters stop moving, well inside the cap', () => {
    const settled = fitSkillModel(observations, { latentFactors: 1 });
    const longer = fitSkillModel(observations, { latentFactors: 1, iterations: 5000, tolerance: 0 });
    // The Huber reweighting leaves a fit cycling by a few hundredths of a
    // point; anything larger would mean the stop came too early.
    expect(maxDrift(settled, longer)).toBeLessThan(0.2);
  });

  it('is not where forty sweeps left it', () => {
    // The old fixed sweep count, with the old factor ridge. Where a fit was
    // still drifting at sweep forty, the number shown depended on the
    // starting point - which is seeded from the ids - rather than the data.
    const cut = fitSkillModel(observations, {
      latentFactors: 1,
      factorRegularization: 0.3,
      iterations: 40,
      tolerance: 0,
    });
    const settled = fitSkillModel(observations, { latentFactors: 1, factorRegularization: 0.3 });
    expect(maxDrift(cut, settled)).toBeGreaterThan(0.5);
  });
});

describe('a thin, one-sided sample', () => {
  it('does not put a player above those who beat them on every shared map', () => {
    const { model } = fitBestModel(observations);
    const gayalex5 = model.predict('gayalex5', spin);
    const wat = model.predict('Wat500036XD', spin);
    expect(gayalex5.extrapolated).toBe(true);
    expect(gayalex5.acc).toBeLessThan(model.predict('LS', spin).acc);
    expect(gayalex5.acc).toBeLessThan(model.predict('Treyo', spin).acc);
    expect(wat.acc).toBeLessThan(model.predict('LS', spin).acc);
    // And well below: LS and Treyo score 90.5 and 89.6 there.
    expect(gayalex5.acc + wat.acc).toBeLessThan(0.905 + 0.896 - 0.03);
  });

  it('is shrunk toward the additive answer by the factor ridge', () => {
    const additive = fitSkillModel(observations, { latentFactors: 0 }).predict('gayalex5', spin);
    const weak = fitSkillModel(observations, { latentFactors: 1, factorRegularization: 0.3 });
    const strong = fitSkillModel(observations, { latentFactors: 1, factorRegularization: 3 });
    const gapWeak = Math.abs(weak.predict('gayalex5', spin).acc - additive.acc);
    const gapStrong = Math.abs(strong.predict('gayalex5', spin).acc - additive.acc);
    expect(gapStrong).toBeLessThan(gapWeak);
  });
});

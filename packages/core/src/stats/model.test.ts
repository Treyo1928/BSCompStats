import { describe, it, expect } from 'vitest';
import { fitSkillModel } from './model.js';
import { fitBestModel, crossValidate } from './cv.js';
import {
  normalizeScores,
  detectDnf,
  columnDeviationsBelow,
  toLogit,
  fromLogit,
} from './normalize.js';
import { buildPlayerProfiles, buildFailModel } from './profile.js';
import { qualsObservations, QUALS_MAPS } from './__fixtures__/quals.js';

function observations() {
  return normalizeScores({
    scores: qualsObservations().map((o) => ({ ...o, baseScore: 0, accuracy: o.acc })),
    maxScores: {},
  }).map((n) => ({
    playerId: n.playerId,
    leaderboardId: n.leaderboardId,
    acc: n.acc,
    isDnf: n.isDnf,
  }));
}

describe('fail detection on the real qualifiers board', () => {
  it('flags the one abandoned run and nothing else', () => {
    const flagged = observations()
      .filter((o) => o.isDnf)
      .map((o) => `${o.playerId}/${o.leaderboardId}`);

    // Alex's 20% on Madeleine is an abandoned run on the *easiest* map in the
    // pool: everyone else there is between 96% and 98%.
    expect(flagged).toEqual(['alex/madeleine']);
  });

  it('treats a score on a map beyond the player as their real score', () => {
    // Kadence, Wyatt and Mia did fail Spin Eternally - but it is a map they
    // cannot beat, in a column that runs from 50% to 92%. That is what they
    // score on it, and it must not be written off as an anomaly.
    const spin = observations().filter((o) => o.leaderboardId === 'spin');
    for (const player of ['kadence', 'wyatt', 'mia']) {
      expect(spin.find((o) => o.playerId === player)?.isDnf).toBe(false);
    }
  });

  it('does not mistake a merely-weak score for a fail', () => {
    // Kaiden's 89.83% on Sentiment is nearly six deviations below a very tight
    // column. It is also simply what Kaiden scores, which is why the column
    // test alone is not enough.
    const kaiden = observations().filter((o) => o.playerId === 'kaiden');
    expect(kaiden.find((o) => o.leaderboardId === 'sentiment')?.isDnf).toBe(false);

    const sentimentOthers = qualsObservations()
      .filter((o) => o.leaderboardId === 'sentiment' && o.playerId !== 'kaiden')
      .map((o) => o.acc);
    expect(columnDeviationsBelow(0.8983, sentimentOthers)).toBeGreaterThan(4);
  });

  it('separates the two kinds of bad score by a wide margin', () => {
    const others = (map: string, player: string) =>
      qualsObservations()
        .filter((o) => o.leaderboardId === map && o.playerId !== player)
        .map((o) => o.acc);

    expect(columnDeviationsBelow(0.2036, others('madeleine', 'alex'))).toBeGreaterThan(10);
    expect(columnDeviationsBelow(0.5045, others('spin', 'kadence'))).toBeLessThan(3);
    expect(columnDeviationsBelow(0.5153, others('spin', 'wyatt'))).toBeLessThan(3);
  });

  it('needs both the player and the column to call it an anomaly', () => {
    const tight = [0.96, 0.965, 0.97, 0.975, 0.98];
    const scattered = [0.92, 0.9, 0.81, 0.71, 0.52];

    // Far below the player's norm and far below a tight column: anomaly.
    expect(detectDnf(0.71, 0.96, tight)).toBe(true);
    // The same score in a column that scatters that far: a hard map.
    expect(detectDnf(0.71, 0.96, scattered)).toBe(false);
    // The same score from a player who lives at 75%: just their score.
    expect(detectDnf(0.71, 0.75, tight)).toBe(false);
    // A rough night - 88% of normal - is not an abandoned map.
    expect(detectDnf(0.85, 0.97, tight)).toBe(false);
  });

  it('takes a bad score at face value when there is no column to judge by', () => {
    expect(detectDnf(0.2, 0.96, [0.97, 0.98])).toBe(false);
    expect(detectDnf(0.2, 0.96, [0.97, 0.98, 0.96])).toBe(true);
  });
});

describe('the skill model', () => {
  it('ranks players the way the board does', () => {
    const model = fitSkillModel(observations());

    // Wynttter posted 98.60 and 99.02 - the two best scores on the board.
    // Kaiden is the weakest of the regulars.
    const ranked = model.playerIds.sort(
      (a, b) => model.playerBias[b]! - model.playerBias[a]!,
    );
    expect(ranked[0]).toBe('wynttter');
    expect(ranked.at(-1)).toBe('kaiden');
    expect(model.playerBias.will!).toBeGreaterThan(model.playerBias.mia!);
  });

  it('ranks maps by difficulty without being told any of them', () => {
    const model = fitSkillModel(observations());
    const byDifficulty = [...QUALS_MAPS].sort(
      (a, b) => model.mapBias[a]! - model.mapBias[b]!,
    );

    // Konpeito and Spin Eternally are the two everyone struggled on; CASINO
    // RAVE and Madeleine are where the whole field sits near 97%.
    expect(byDifficulty.slice(0, 2).sort()).toEqual(['konpeito', 'spin']);
    expect(model.mapBias.casino!).toBeGreaterThan(model.mapBias.spin!);
    expect(model.mapBias.madeleine!).toBeGreaterThan(model.mapBias.konpeito!);
  });

  it("is not dragged down by Alex's abandoned run", () => {
    // Alex scored 95-96% on three maps and 20.36% on a fourth. If the 20%
    // counted, his profile would be nonsense.
    const model = fitSkillModel(observations());
    const predicted = model.predict('alex', 'madeleine').acc;

    expect(predicted).toBeGreaterThan(0.9);
    // He should land near the other three scores he actually posted.
    expect(model.predict('alex', 'casino').acc).toBeCloseTo(0.963, 1);
  });

  it('shrinks a two-score player toward the field instead of crowning them', () => {
    const model = fitSkillModel(observations());
    // Wynttter is top of the board on two scores; Cat is strong across seven.
    // Wynttter should still lead, but not by the raw 1.5-point gap.
    const gap = model.playerBias.wynttter! - model.playerBias.cat!;
    expect(gap).toBeGreaterThan(0);

    // Wynttter's two scores average 98.81% against Cat's 95.22% - a raw gap of
    // about 1.25 in logit units. Shrinkage should cut that substantially,
    // because two scores is not enough to claim that lead.
    const rawGap = toLogit(0.9881) - toLogit(0.9522);
    expect(gap).toBeLessThan(rawGap * 0.6);
    expect(model.playerCount.wynttter).toBe(2);
  });

  it('predicts a cell nobody filled in, and says it is extrapolating', () => {
    const model = fitSkillModel(observations());
    // Will never played Konpeito. He is a strong player, Konpeito is hard.
    const p = model.predict('will', 'konpeito');

    expect(p.extrapolated).toBe(true);
    expect(p.acc).toBeGreaterThan(0.9);
    expect(p.acc).toBeLessThan(0.99);
    expect(p.accLow).toBeLessThan(p.acc);
    expect(p.accHigh).toBeGreaterThan(p.acc);
    // A cell he did play is not extrapolated.
    expect(model.predict('will', 'casino').extrapolated).toBe(false);
  });

  it('gives an unknown player a usable answer at low confidence', () => {
    const model = fitSkillModel(observations());
    const p = model.predict('brand-new-signup', 'casino');

    expect(Number.isFinite(p.acc)).toBe(true);
    expect(p.acc).toBeGreaterThan(0);
    expect(p.acc).toBeLessThan(1);
    expect(p.confidence).toBeLessThan(0.2);
  });

  it('predicts what a player actually scored on a map they have played', () => {
    // The complaint that prompted this: Kadence scored 50.45% on Spin
    // Eternally and the model told her captain to expect 88%.
    const model = fitSkillModel(observations());

    const kadence = model.predict('kadence', 'spin');
    expect(kadence.observedAcc).toBeCloseTo(0.5045, 4);
    expect(Math.abs(kadence.acc - 0.5045)).toBeLessThan(0.04);
    expect(kadence.accLow).toBeLessThan(0.5045);
    expect(kadence.accHigh).toBeGreaterThan(0.5045);
    // General skill alone still says otherwise - which is the point of anchoring.
    expect(kadence.modelAcc).toBeGreaterThan(0.75);

    expect(Math.abs(model.predict('wyatt', 'spin').acc - 0.5153)).toBeLessThan(0.04);
    expect(Math.abs(model.predict('mia', 'spin').acc - 0.7097)).toBeLessThan(0.03);

    // And every unflagged cell on the board lands close to its real score.
    for (const o of observations().filter((x) => !x.isDnf)) {
      const p = model.predict(o.playerId, o.leaderboardId);
      expect(Math.abs(p.acc - o.acc)).toBeLessThan(0.04);
    }
  });

  it('never anchors to an abandoned run', () => {
    const p = fitSkillModel(observations()).predict('alex', 'madeleine');
    expect(p.observedAcc).toBeNull();
    expect(p.anchorWeight).toBe(0);
    expect(p.acc).toBe(p.modelAcc);
  });

  it('anchors an old score less firmly than a fresh one', () => {
    const stale = observations().map((o) =>
      o.playerId === 'kadence' && o.leaderboardId === 'spin' ? { ...o, weight: 0.25 } : o,
    );
    const fresh = fitSkillModel(observations()).predict('kadence', 'spin');
    const aged = fitSkillModel(stale).predict('kadence', 'spin');
    expect(aged.anchorWeight).toBeLessThan(fresh.anchorWeight);
    expect(aged.acc).toBeGreaterThan(fresh.acc);
  });

  it('can have anchoring switched off', () => {
    const p = fitSkillModel(observations(), { anchorWeight: 0 }).predict('kadence', 'spin');
    expect(p.acc).toBe(p.modelAcc);
  });

  it('knows Spin Eternally is the unpredictable map', () => {
    const model = fitSkillModel(observations());
    const scales = Object.entries(model.mapSigmaScale).sort((a, b) => b[1] - a[1]);
    expect(scales[0]![0]).toBe('spin');
    expect(model.mapSigmaScale.spin!).toBeGreaterThan(2);
    expect(model.mapSigmaScale.sentiment!).toBeLessThan(1);

    // Will has played neither map. His uncertainty on Spin should be visibly
    // wider than on Girls' Night, whatever the means are.
    const onSpin = model.predict('will', 'spin');
    const onGirlsNight = model.predict('will', 'girlsnight');
    expect(onSpin.sigmaLogit).toBeGreaterThan(onGirlsNight.sigmaLogit * 2);
    expect(onSpin.accHigh - onSpin.accLow).toBeGreaterThan(0.05);
  });

  it("does not let Spin Eternally rewrite Kadence's profile", () => {
    // Her 50% is real, but a map that scatters the whole field is weak
    // evidence about general level. She should still read as a ~96% player on
    // the maps where that is what she is.
    const model = fitSkillModel(observations());
    expect(model.predict('kadence', 'electric').modelAcc).toBeGreaterThan(0.95);
    expect(model.playerBias.kadence!).toBeGreaterThan(model.playerBias.kaiden!);
  });

  it('is deterministic - the same data gives the same model', () => {
    const a = fitSkillModel(observations());
    const b = fitSkillModel(observations());
    expect(a.playerBias).toEqual(b.playerBias);
    expect(a.predict('mia', 'spin').acc).toBe(b.predict('mia', 'spin').acc);
  });
});

describe('model selection', () => {
  it('prefers the additive model on a pool this small', () => {
    // Latent factors lift training fit and hurt held-out error here; the whole
    // point of choosing by cross-validation is to catch that automatically.
    const { chosen, comparison } = fitBestModel(observations());

    expect(chosen.latentFactors).toBe(0);
    expect(comparison[0]!.maeAccPoints).toBeLessThan(
      comparison.at(-1)!.maeAccPoints,
    );
  });

  it('predicts a typical held-out score to within about one accuracy point', () => {
    const result = crossValidate(observations(), {
      latentFactors: 0,
      biasRegularization: 0.5,
    });
    expect(result.samples).toBeGreaterThan(30);
    expect(result.medianErrorAccPoints).toBeLessThan(1.2);
    // The mean is a different story, and honestly so: it now includes the
    // Spin Eternally scores, which no model predicts blind from seven scores a
    // map. That is what anchoring is for.
    expect(result.maeAccPoints).toBeGreaterThan(result.medianErrorAccPoints);
    expect(result.maeAccPoints).toBeLessThan(4);
  });

  it('falls back safely when there is barely any data', () => {
    const { model, chosen } = fitBestModel([
      { playerId: 'a', leaderboardId: 'm1', acc: 0.95 },
      { playerId: 'b', leaderboardId: 'm1', acc: 0.93 },
    ]);
    expect(chosen.latentFactors).toBe(0);
    expect(model.predict('a', 'm1').acc).toBeGreaterThan(0.9);
  });
});

describe('player profiles', () => {
  it('summarises a player the way the board reads', () => {
    const obs = observations();
    const model = fitSkillModel(obs);
    const profiles = buildPlayerProfiles({
      scores: obs.map((o) => ({ ...o, isDnf: o.isDnf ?? false })),
      model,
      categories: {
        madeleine: 'True Acc',
        casino: 'Acc',
        sentiment: 'Acc',
        electric: 'Tech Acc',
        girlsnight: 'Balanced',
        konpeito: 'Tech',
        spin: 'Speed',
      },
    });

    const kadence = profiles.kadence!;
    expect(kadence.scoreCount).toBe(7);
    // Spin Eternally is a real score, so it counts - and her average comes out
    // at the 88.05% the spreadsheet shows.
    expect(kadence.failCount).toBe(0);
    expect(kadence.worstCleanAcc).toBeCloseTo(0.5045, 4);
    expect(kadence.meanAcc).toBeCloseTo(0.8805, 3);

    // Alex's abandoned run is the one thing that does not count.
    const alex = profiles.alex!;
    expect(alex.failCount).toBe(1);
    expect(alex.failRate).toBeCloseTo(1 / 4, 2);
    expect(alex.worstCleanAcc).toBeGreaterThan(0.95);

    // Category affinity is derived, not declared.
    expect(Object.keys(kadence.categoryAffinity).sort()).toEqual([
      'Acc',
      'Balanced',
      'Speed',
      'Tech',
      'Tech Acc',
      'True Acc',
    ]);
    // Measured against unanchored skill, so it can actually show something:
    // Speed is where she falls furthest short of her general level.
    expect(kadence.categoryAffinity.Speed!).toBeLessThan(-1);
  });
});

describe('the fail model', () => {
  const build = () => {
    const obs = observations();
    const model = fitSkillModel(obs);
    return buildFailModel({
      scores: obs.map((o) => ({ ...o, isDnf: o.isDnf ?? false })),
      model,
    });
  };

  it('does not count a map beyond the player as a fail', () => {
    const fail = build();
    // Nobody abandoned Spin Eternally. The risk of putting Kadence on it lives
    // in her predicted score, not in a fail probability.
    expect(fail.mapRate.spin!).toBeLessThanOrEqual(fail.globalRate);
    expect(fail.probability('kadence', 'spin')).toBeLessThan(0.05);
  });

  it('carries a player-specific risk onto a map they have never played', () => {
    const fail = build();
    // Cat cleared everything; Alex has an abandoned run on record. On a map
    // neither has the same history on, Alex should still carry more risk.
    expect(fail.probability('alex', 'konpeito')).toBeGreaterThan(
      fail.probability('cat', 'konpeito'),
    );
    expect(fail.probability('cat', 'casino')).toBeLessThan(0.05);
  });

  it('does not count one abandoned run twice', () => {
    // The single anomaly raises both Alex's rate and Madeleine's. Multiplying
    // the two once made him 61% likely to abandon it again.
    expect(build().probability('alex', 'madeleine')).toBeLessThan(0.25);
  });

  it('never returns an impossible probability', () => {
    const obs = observations();
    const model = fitSkillModel(obs);
    const fail = buildFailModel({
      scores: obs.map((o) => ({ ...o, isDnf: o.isDnf ?? false })),
      model,
    });
    for (const p of model.playerIds) {
      for (const m of QUALS_MAPS) {
        const v = fail.probability(p, m);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(0.9);
      }
    }
  });
});

describe('logit helpers', () => {
  it('round-trip and stay inside (0,1)', () => {
    expect(fromLogit(toLogit(0.965))).toBeCloseTo(0.965, 6);
    expect(fromLogit(toLogit(0))).toBeGreaterThan(0);
    expect(fromLogit(toLogit(1))).toBeLessThan(1);
    expect(fromLogit(50)).toBeLessThanOrEqual(1);
  });
});

import { describe, it, expect } from 'vitest';
import { fitBestModel } from '../stats/cv.js';
import { normalizeScores } from '../stats/normalize.js';
import { buildFailModel } from '../stats/profile.js';
import { qualsObservations } from '../stats/__fixtures__/quals.js';
import { evaluateMaps, recommendAction } from './advisor.js';
import { recommendLineups } from './lineup.js';
import { drawSamples, simulate, type SimMap } from './simulate.js';
import { MSU_DUOS_FORMAT } from '../match/format.js';

/** Max scores read from the live BeatLeader API for the real pool. */
const MAX_SCORES: Record<string, number> = {
  electric: 568675,
  casino: 387435,
  sentiment: 463795,
  madeleine: 98555,
  spin: 1682795,
  konpeito: 488635,
  girlsnight: 858475,
};

const MAROON = ['cat', 'treyo', 'mia', 'will'];
const WHITE = ['kaiden', 'kadence', 'wyatt', 'alex'];

function buildEngine() {
  const obs = normalizeScores({
    scores: qualsObservations().map((o) => ({ ...o, baseScore: 0, accuracy: o.acc })),
    maxScores: MAX_SCORES,
  }).map((n) => ({
    playerId: n.playerId,
    leaderboardId: n.leaderboardId,
    acc: n.acc,
    isDnf: n.isDnf,
  }));

  const { model } = fitBestModel(obs);
  const failModel = buildFailModel({
    scores: obs.map((o) => ({ ...o, isDnf: o.isDnf ?? false })),
    model,
  });

  const maps: SimMap[] = Object.keys(MAX_SCORES).map((id) => ({
    id,
    leaderboardId: id,
    maxScore: MAX_SCORES[id]!,
    isTiebreaker: false,
  }));

  const setup = {
    maps,
    format: MSU_DUOS_FORMAT,
    playerIds: [...MAROON, ...WHITE],
    predict: (playerId: string, leaderboardId: string) => {
      const p = model.predict(playerId, leaderboardId);
      return {
        acc: p.acc,
        sigmaLogit: p.sigmaLogit,
        failProbability: failModel.probability(playerId, leaderboardId),
      };
    },
    iterations: 10_000,
    seed: 2026,
  };

  return { maps, setup, model };
}

describe('pool evaluation on the real MSU data', () => {
  const { maps, setup } = buildEngine();
  const values = evaluateMaps({
    maps,
    format: MSU_DUOS_FORMAT,
    ourRoster: MAROON,
    theirRoster: WHITE,
    setup,
  });

  it('scores every map in the pool', () => {
    expect(values).toHaveLength(7);
    for (const v of values) {
      expect(v.expected).toBeGreaterThanOrEqual(0);
      expect(v.expected).toBeLessThanOrEqual(1);
      // Committing your best duo cannot be worse than the average pairing.
      expect(v.bestCase).toBeGreaterThanOrEqual(v.expected - 0.01);
      // And the opponent answering with their best cannot be better than that.
      expect(v.bestVsBest).toBeLessThanOrEqual(v.bestCase + 0.01);
      expect(v.bestGroup).toHaveLength(2);
    }
  });

  it('knows Spin Eternally is a strong map for Maroon, not a coin flip', () => {
    // Kadence and Wyatt score around 50% on Spin Eternally; Cat and Treyo
    // score 90%. While those 50s were written off as anomalies the engine
    // rated this the least certain map on the board - exactly backwards.
    const spin = values.find((v) => v.mapId === 'spin')!;
    expect(spin.bestCase).toBeGreaterThan(0.95);
    expect(spin.expected).toBeGreaterThan(0.9);
  });

  it('favours Maroon overall, which is what actually happened', () => {
    // Maroon won the real scrim on every map. The model should agree they were
    // the stronger side across the pool.
    const mean = values.reduce((acc, v) => acc + v.expected, 0) / values.length;
    expect(mean).toBeGreaterThan(0.6);
  });
});

describe('pick and ban advice', () => {
  const { maps, setup } = buildEngine();
  const values = evaluateMaps({
    maps,
    format: MSU_DUOS_FORMAT,
    ourRoster: MAROON,
    theirRoster: WHITE,
    setup,
  });
  const allIds = Object.keys(MAX_SCORES);

  it('recommends picking the map with the best chance', () => {
    const advice = recommendAction('PICK', allIds, values);
    const best = [...values].sort((a, b) => b.expected - a.expected)[0]!;
    expect(advice[0]!.mapId).toBe(best.mapId);
    expect(advice[0]!.reason).toMatch(/%/);
  });

  it('recommends banning the map with the worst chance', () => {
    const advice = recommendAction('BAN', allIds, values);
    const worst = [...values].sort((a, b) => a.expected - b.expected)[0]!;
    expect(advice[0]!.mapId).toBe(worst.mapId);
  });

  it('explains honestly when no ban is actually dangerous', () => {
    // Maroon is favoured on every map here, so the advice must not claim it is
    // removing a threat.
    const advice = recommendAction('BAN', allIds, values);
    expect(advice[0]!.reason).toMatch(/no dangerous ban|least comfortable|against you/i);
  });

  it('only considers maps still available', () => {
    const remaining = ['spin', 'konpeito'];
    const advice = recommendAction('PICK', remaining, values);
    expect(advice.map((a) => a.mapId).sort()).toEqual(['konpeito', 'spin']);
  });
});

describe('the tiebreaker is scored on the games it is actually played in', () => {
  const { setup } = buildEngine();

  const played: SimMap[] = [
    { id: 'madeleine', leaderboardId: 'madeleine', maxScore: MAX_SCORES.madeleine!, isTiebreaker: false },
    { id: 'casino', leaderboardId: 'casino', maxScore: MAX_SCORES.casino!, isTiebreaker: false },
    { id: 'sentiment', leaderboardId: 'sentiment', maxScore: MAX_SCORES.sentiment!, isTiebreaker: false },
    { id: 'konpeito', leaderboardId: 'konpeito', maxScore: MAX_SCORES.konpeito!, isTiebreaker: false },
    { id: 'girlsnight', leaderboardId: 'girlsnight', maxScore: MAX_SCORES.girlsnight!, isTiebreaker: true },
  ];
  const opponent = {
    madeleine: ['kaiden', 'kadence'],
    casino: ['kadence', 'alex'],
    sentiment: ['kaiden', 'alex'],
    konpeito: ['wyatt', 'alex'],
    girlsnight: ['kaiden', 'kadence'],
  };

  it('does not report a favoured tiebreaker as a near-certain loss', () => {
    // A match Maroon wins outright rarely reaches the decider. Averaging the
    // tiebreaker over every simulated match made it look like a 2% map that
    // Maroon nonetheless out-scored - a contradiction that made the whole
    // recommendation untrustworthy.
    const samples = drawSamples({ ...setup, maps: played });
    const result = simulate(
      samples,
      {
        madeleine: ['cat', 'treyo'],
        casino: ['mia', 'will'],
        sentiment: ['cat', 'mia'],
        konpeito: ['treyo', 'will'],
        girlsnight: ['cat', 'mia'],
      },
      opponent,
      MSU_DUOS_FORMAT,
    );

    const tb = result.perMap.girlsnight!;
    expect(tb.playProbability).toBeLessThan(0.2); // rarely reached
    expect(tb.winProbability).toBeGreaterThan(0.5); // but Maroon is favoured
    // Win probability and margin must agree in direction.
    expect(tb.expectedMargin).toBeGreaterThan(0);
  });

  it('does not describe a rarely-played tiebreaker as conceded', () => {
    const rec = recommendLineups(
      { ...setup, maps: played },
      {
        maps: played,
        format: MSU_DUOS_FORMAT,
        roster: MAROON,
        opponentLineups: opponent,
        objective: 'WIN_PROBABILITY',
      },
    );
    expect(rec.best!.concededMapIds).not.toContain('girlsnight');
  });
});

describe('the engine end to end', () => {
  it('recommends a legal lineup for the real match, fast', () => {
    const { setup } = buildEngine();
    const played: SimMap[] = [
      { id: 'madeleine', leaderboardId: 'madeleine', maxScore: MAX_SCORES.madeleine!, isTiebreaker: false },
      { id: 'casino', leaderboardId: 'casino', maxScore: MAX_SCORES.casino!, isTiebreaker: false },
      { id: 'sentiment', leaderboardId: 'sentiment', maxScore: MAX_SCORES.sentiment!, isTiebreaker: false },
      { id: 'konpeito', leaderboardId: 'konpeito', maxScore: MAX_SCORES.konpeito!, isTiebreaker: false },
      { id: 'girlsnight', leaderboardId: 'girlsnight', maxScore: MAX_SCORES.girlsnight!, isTiebreaker: true },
    ];
    const opponent = {
      madeleine: ['kaiden', 'kadence'], casino: ['kadence', 'alex'],
      sentiment: ['kaiden', 'alex'], konpeito: ['wyatt', 'alex'],
      girlsnight: ['kaiden', 'kadence'],
    };

    const started = performance.now();
    const rec = recommendLineups(
      { ...setup, maps: played },
      { maps: played, format: MSU_DUOS_FORMAT, roster: MAROON, opponentLineups: opponent },
    );
    const elapsed = performance.now() - started;

    expect(rec.strategy).toBe('EXHAUSTIVE');
    expect(rec.evaluated).toBe(432); // every legal lineup for this format
    expect(elapsed).toBeLessThan(3000);

    // Legal: four distinct duos, everyone playing exactly twice.
    const scoring = ['madeleine', 'casino', 'sentiment', 'konpeito'];
    const duos = scoring.map((id) => [...rec.best!.lineups[id]!].sort().join('|'));
    expect(new Set(duos).size).toBe(4);

    const counts: Record<string, number> = {};
    for (const id of scoring) {
      for (const p of rec.best!.lineups[id]!) counts[p] = (counts[p] ?? 0) + 1;
    }
    expect(Object.values(counts).sort()).toEqual([2, 2, 2, 2]);

    // Maroon swept the real scrim; the model should make them heavy favourites.
    expect(rec.best!.winProbability).toBeGreaterThan(0.8);
  });
});

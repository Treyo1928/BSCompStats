import { describe, it, expect } from 'vitest';
import { fitBestModel } from '../stats/cv.js';
import { normalizeScores } from '../stats/normalize.js';
import { buildFailModel } from '../stats/profile.js';
import { qualsObservations } from '../stats/__fixtures__/quals.js';
import { evaluateMaps, recommendAction } from './advisor.js';
import { answerOpponentCard, computeMatchAdvice } from './match-advice.js';
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

describe('the headline win chance is about lineups a captain would field', () => {
  // The real match, 2026-09-21: on the speed map Team corn's two speed players
  // beat anything Team Wynttter has, but their bench scores in the 30s - so
  // averaged over every possible duo the map read 54% for Team Wynttter, and
  // was their "suggested pick". With best lineups it was 29%.
  const speed: Record<string, number> = {
    wynttter: 0.887, treyo: 0.68, ohmydazed: 0.624, pretzel: 0.368, alexA: 0.264, zolism: 0.6,
    corn: 0.855, ls: 0.81, mia: 0.545, wat: 0.593, layz: 0.301, alexB: 0.264,
  };
  const ours = ['wynttter', 'treyo', 'ohmydazed', 'pretzel', 'alexA', 'zolism'];
  const theirs = ['corn', 'ls', 'mia', 'wat', 'layz', 'alexB'];
  const maps: SimMap[] = [{ id: 'buggin', leaderboardId: 'buggin', maxScore: 1_000_000, isTiebreaker: false }];
  const [value] = evaluateMaps({
    maps,
    format: MSU_DUOS_FORMAT,
    ourRoster: ours,
    theirRoster: theirs,
    setup: {
      maps,
      format: MSU_DUOS_FORMAT,
      playerIds: [...ours, ...theirs],
      predict: (playerId) => ({ acc: speed[playerId]!, sigmaLogit: 0.15, failProbability: 0 }),
      iterations: 4000,
      seed: 7,
    },
  });

  it('does not call a map ours because their bench is weak', () => {
    expect(value!.opponentBestGroup.sort()).toEqual(['corn', 'ls']);
    expect(value!.bestVsBest).toBeLessThan(0.35);
    expect(value!.likely).toBeLessThan(0.35);
    // The old headline, for the record: it leaned our way, or near it.
    expect(value!.expected).toBeGreaterThan(value!.likely + 0.05);
  });
});

describe('best against best means the best answer to their best', () => {
  // The real match again, on the true-acc map. Wynttter + zolism beat corn + LS
  // by over a point, but zolism has abandoned two maps in this pool, so there is
  // a real chance he throws one away - which made Wynttter + Treyo the "best"
  // duo on average over everything Team corn could field, and the map read 23%.
  const acc: Record<string, number> = { wynttter: 0.9913, zolism: 0.9813, treyo: 0.963, corn: 0.9811, ls: 0.9777, mia: 0.9683 };
  const fail: Record<string, number> = { zolism: 0.2 };
  const ours = ['wynttter', 'zolism', 'treyo'];
  const theirs = ['corn', 'ls', 'mia'];
  const maps: SimMap[] = [{ id: 'ride', leaderboardId: 'ride', maxScore: 1_000_000, isTiebreaker: false }];
  const [value] = evaluateMaps({
    maps,
    format: MSU_DUOS_FORMAT,
    ourRoster: ours,
    theirRoster: theirs,
    setup: {
      maps,
      format: MSU_DUOS_FORMAT,
      playerIds: [...ours, ...theirs],
      predict: (playerId) => ({ acc: acc[playerId]!, sigmaLogit: 0.12, failProbability: fail[playerId] ?? 0 }),
      iterations: 6000,
      seed: 11,
    },
  });

  it('answers their best lineup with whoever does best against it', () => {
    expect([...value!.opponentBestGroup].sort()).toEqual(['corn', 'ls']);
    expect([...value!.bestGroup].sort()).toEqual(['wynttter', 'zolism']);
    expect(value!.likely).toBeGreaterThan(0.5);
  });
});

describe('the opponent has a captain too', () => {
  // Two stars and two passengers against six even players. With a duo usable
  // once and everyone playing twice, the stars carry two maps at most; the
  // passengers must play two together or split - and a real captain on the
  // other side meets them with strength. This card read 97% to win when the
  // opponent was assumed to rotate their roster blindly.
  const acc: Record<string, number> = {
    wyn: 0.985, corn: 0.975, wat: 0.9, alex: 0.88,
    ls: 0.965, treyo: 0.96, ohmy: 0.955, zol: 0.955, mia: 0.955, pretzel: 0.95,
  };
  const ours = ['wyn', 'corn', 'wat', 'alex'];
  const theirs = ['ls', 'treyo', 'ohmy', 'zol', 'mia', 'pretzel'];
  const maps: SimMap[] = ['m1', 'm2', 'm3', 'm4', 'tb'].map((id) => ({ id, leaderboardId: id, maxScore: 1_000_000, isTiebreaker: id === 'tb' }));
  const advice = computeMatchAdvice({
    format: MSU_DUOS_FORMAT,
    poolMaps: maps,
    playedMaps: maps,
    ourRoster: ours,
    theirRoster: theirs,
    pending: null,
    predictions: Object.fromEntries(
      [...ours, ...theirs].map((p) => [p, Object.fromEntries(maps.map((m) => [m.id, { acc: acc[p]!, sigmaLogit: 0.12, failProbability: 0 }]))]),
    ),
    iterations: 3000,
    seed: 5,
  });

  it('does not hand a top-heavy side the match on the strength of a blind opponent', () => {
    const win = advice.lineups.winProbability!;
    expect(win.winProbability).toBeLessThan(0.75);
    // Every map has a verdict, and a map the passengers play together is expected to be lost.
    expect(Object.keys(win.perMap).sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'tb']);
    const passengers = Object.entries(win.lineups).find(([, g]) => [...g].sort().join() === 'alex,wat');
    if (passengers) expect(win.perMap[passengers[0]]!.winProbability).toBeLessThan(0.2);
    expect(Object.keys(win.opponentLineups).length).toBe(5);
  });
});

describe('answering a partial opponent card', () => {
  const acc: Record<string, number> = {
    wyn: 0.985, corn: 0.975, wat: 0.9, alex: 0.88,
    ls: 0.965, treyo: 0.96, ohmy: 0.955, zol: 0.955, mia: 0.955, pretzel: 0.95,
  };
  const ours = ['wyn', 'corn', 'wat', 'alex'];
  const theirs = ['ls', 'treyo', 'ohmy', 'zol', 'mia', 'pretzel'];
  const maps: SimMap[] = ['m1', 'm2', 'm3', 'm4', 'tb'].map((id) => ({ id, leaderboardId: id, maxScore: 1_000_000, isTiebreaker: id === 'tb' }));
  const input = {
    format: MSU_DUOS_FORMAT,
    playedMaps: maps,
    ourRoster: ours,
    theirRoster: theirs,
    predictions: Object.fromEntries(
      [...ours, ...theirs].map((p) => [p, Object.fromEntries(maps.map((m) => [m.id, { acc: acc[p]!, sigmaLogit: 0.12, failProbability: 0 }]))]),
    ),
    iterations: 2000,
    seed: 3,
  };

  it('holds what was set and infers the rest as a captain would, not as a rotation', () => {
    const result = answerOpponentCard({ ...input, opponentLineups: { m1: ['pretzel', 'mia'] } });
    const card = result.winProbability!.opponentLineups;
    expect([...card.m1!].sort()).toEqual(['mia', 'pretzel']);
    expect(result.pinnedMapIds).toEqual(['m1']);
    // Every map filled, legally: nobody more than twice on the four regular
    // maps, and no pairing used twice - the pinned one included.
    const regular = ['m1', 'm2', 'm3', 'm4'];
    const counts = new Map<string, number>();
    for (const id of regular) for (const p of card[id]!) counts.set(p, (counts.get(p) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    const duos = regular.map((id) => [...card[id]!].sort().join());
    expect(new Set(duos).size).toBe(regular.length);
    // The inferred maps are not the blind rotation, which around a pinned m1
    // would read ohmy+zol, mia+pretzel, ls+treyo on m2-m4 (and repeat the pin).
    const rotation = ['ohmy,zol', 'mia,pretzel', 'ls,treyo'];
    const inferred = ['m2', 'm3', 'm4'].map((id) => [...card[id]!].sort().join());
    expect(inferred).not.toEqual(rotation);
  });

  it('says so when a side cannot fill a map, instead of a 0% built from nothing', () => {
    const result = answerOpponentCard({ ...input, theirRoster: ['ls'], opponentLineups: {} });
    expect(result.winProbability).toBeNull();
    expect(result.infeasible).toMatch(/Their team has 1 available player/);
  });

  it('refuses pins no legal card fits around rather than scoring a rotation', () => {
    // Two pins that repeat a pairing: no card for their roster honours both.
    const result = answerOpponentCard({ ...input, opponentLineups: { m1: ['ls', 'treyo'], m2: ['treyo', 'ls'] } });
    expect(result.winProbability).toBeNull();
    expect(result.infeasible).toBeTruthy();
  });

  it('with nothing set, gives the same kind of answer the lineup panel does', () => {
    const result = answerOpponentCard({ ...input, opponentLineups: {} });
    expect(result.pinnedMapIds).toEqual([]);
    expect(result.winProbability!.winProbability).toBeLessThan(0.8);
  });
});

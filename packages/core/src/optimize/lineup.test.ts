import { describe, it, expect } from 'vitest';
import { drawSamples, simulate, type SimMap } from './simulate.js';
import {
  optimizeLineups,
  enumerateLineups,
  combinations,
  recommendLineups,
} from './lineup.js';
import { matchFormatSchema, MSU_DUOS_FORMAT } from '../match/format.js';

const MAX = 1_000_000;

/**
 * A deliberately rigged match where conceding one map is the only way to win.
 *
 * Team A has three strong players and two weak ones. Map 1 is hopeless for
 * them - every A player scores far below every B player on it, so no lineup
 * wins it. The other three maps are close, and A takes one only by fielding
 * two of their stars.
 *
 * The duo rule is what makes this interesting: the three stars give exactly
 * three distinct pairs, so A can cover maps 2-4 with star duos *only* if the
 * weak players absorb map 1 between them. Spending a star on the lost map
 * leaves a weak pair somewhere that mattered.
 */
const STRONG = ['s1', 's2', 's3'];
const WEAK = ['w1', 'w2'];
const ROSTER_A = [...STRONG, ...WEAK];
const ROSTER_B = ['b1', 'b2', 'b3', 'b4'];

const MAPS: SimMap[] = [
  { id: 'lost', leaderboardId: 'lost', maxScore: MAX, isTiebreaker: false },
  { id: 'm2', leaderboardId: 'm2', maxScore: MAX, isTiebreaker: false },
  { id: 'm3', leaderboardId: 'm3', maxScore: MAX, isTiebreaker: false },
  { id: 'm4', leaderboardId: 'm4', maxScore: MAX, isTiebreaker: false },
];

function predict(playerId: string, leaderboardId: string) {
  const base = { sigmaLogit: 0.04, failProbability: 0 };
  if (leaderboardId === 'lost') {
    // Nobody on A can touch this map. The stars are a little less bad, which
    // is what tempts a margin-maximising lineup into wasting them here.
    if (ROSTER_B.includes(playerId)) return { ...base, acc: 0.95 };
    return { ...base, acc: STRONG.includes(playerId) ? 0.75 : 0.7 };
  }
  if (ROSTER_B.includes(playerId)) return { ...base, acc: 0.95 };
  return { ...base, acc: STRONG.includes(playerId) ? 0.96 : 0.925 };
}

/** Everyone plays at most twice; no minimum, so a weak pair can absorb a map. */
const FORMAT = matchFormatSchema.parse({
  playersPerMap: 2,
  rosterSize: 5,
  tiebreaker: 'NONE',
  winCondition: 'MAP_WINS',
  rules: {
    uniqueDuos: true,
    tiebreakerExemptFromDuos: true,
    minAppearances: null,
    maxAppearances: 2,
  },
});

const setup = {
  maps: MAPS,
  format: FORMAT,
  playerIds: [...ROSTER_A, ...ROSTER_B],
  predict,
  iterations: 20_000,
  seed: 20260920,
};

/** B spreads evenly - four players, two per map, no repeated pair. */
const OPPONENT = {
  lost: ['b1', 'b2'],
  m2: ['b3', 'b4'],
  m3: ['b1', 'b3'],
  m4: ['b2', 'b4'],
};

describe('sandbagging emerges from maximising win probability', () => {
  const samples = drawSamples(setup);

  it('concedes the unwinnable map and wins the other three', () => {
    const result = optimizeLineups({
      maps: MAPS,
      format: FORMAT,
      roster: ROSTER_A,
      opponentLineups: OPPONENT,
      samples,
      objective: 'WIN_PROBABILITY',
    });

    const best = result.best!;
    expect(best).toBeDefined();

    // The weak pair absorbs the lost map...
    expect([...best.lineups.lost!].sort()).toEqual(['w1', 'w2']);
    // ...which frees a star duo for each of the three contested maps.
    for (const mapId of ['m2', 'm3', 'm4']) {
      expect(best.lineups[mapId]!.every((p) => STRONG.includes(p))).toBe(true);
    }

    expect(best.winProbability).toBeGreaterThan(0.9);
    expect(best.concededMapIds).toContain('lost');
  });

  it('maximising margin instead spends stars on the lost map and wins less often', () => {
    const byWinProb = optimizeLineups({
      maps: MAPS, format: FORMAT, roster: ROSTER_A,
      opponentLineups: OPPONENT, samples, objective: 'WIN_PROBABILITY',
    }).best!;

    const byMargin = optimizeLineups({
      maps: MAPS, format: FORMAT, roster: ROSTER_A,
      opponentLineups: OPPONENT, samples, objective: 'EXPECTED_MARGIN',
    }).best!;

    // The margin-maximising lineup puts a star on the map it cannot win,
    // because a smaller defeat still adds points to the aggregate.
    expect(byMargin.lineups.lost!.some((p) => STRONG.includes(p))).toBe(true);

    // It scores more points overall and wins the match noticeably less often -
    // exactly the trade a captain is making when they decide whether to punt.
    expect(byMargin.expectedMargin).toBeGreaterThan(byWinProb.expectedMargin);
    expect(byMargin.winProbability).toBeLessThan(byWinProb.winProbability);
  });

  it('never wins the map it cannot win, whatever it fields there', () => {
    const result = optimizeLineups({
      maps: MAPS, format: FORMAT, roster: ROSTER_A,
      opponentLineups: OPPONENT, samples, objective: 'WIN_PROBABILITY',
    });
    for (const candidate of result.ranked) {
      expect(candidate.perMap.lost!.winProbability).toBeLessThan(0.01);
    }
  });
});

describe('enumeration respects the rules', () => {
  it('produces only legal lineups for the real MSU format', () => {
    const maps: SimMap[] = [
      { id: 'm1', leaderboardId: 'a', maxScore: MAX, isTiebreaker: false },
      { id: 'm2', leaderboardId: 'b', maxScore: MAX, isTiebreaker: false },
      { id: 'm3', leaderboardId: 'c', maxScore: MAX, isTiebreaker: false },
      { id: 'm4', leaderboardId: 'd', maxScore: MAX, isTiebreaker: false },
      { id: 'tb', leaderboardId: 'e', maxScore: MAX, isTiebreaker: true },
    ];
    const roster = ['erin', 'trey', 'mia', 'will'];

    const { lineups, truncated } = enumerateLineups(roster, maps, MSU_DUOS_FORMAT);
    expect(truncated).toBe(false);
    expect(lineups.length).toBeGreaterThan(0);

    for (const lineup of lineups) {
      // Every non-tiebreaker duo is distinct.
      const duos = maps
        .filter((m) => !m.isTiebreaker)
        .map((m) => [...lineup[m.id]!].sort().join('|'));
      expect(new Set(duos).size).toBe(duos.length);

      // Everyone plays exactly twice across the four scoring maps.
      const counts: Record<string, number> = {};
      for (const m of maps.filter((x) => !x.isTiebreaker)) {
        for (const p of lineup[m.id]!) counts[p] = (counts[p] ?? 0) + 1;
      }
      expect(Object.values(counts).sort()).toEqual([2, 2, 2, 2]);
    }
  });

  it("finds Maroon's real lineup among the legal options", () => {
    const maps: SimMap[] = [
      { id: 'm1', leaderboardId: 'a', maxScore: MAX, isTiebreaker: false },
      { id: 'm2', leaderboardId: 'b', maxScore: MAX, isTiebreaker: false },
      { id: 'm3', leaderboardId: 'c', maxScore: MAX, isTiebreaker: false },
      { id: 'm4', leaderboardId: 'd', maxScore: MAX, isTiebreaker: false },
      { id: 'tb', leaderboardId: 'e', maxScore: MAX, isTiebreaker: true },
    ];
    const { lineups } = enumerateLineups(
      ['erin', 'trey', 'mia', 'will'],
      maps,
      MSU_DUOS_FORMAT,
    );

    // Erin+Will, Erin+Trey, Will+Mia, Trey+Mia, then Erin+Mia on the decider.
    const asPlayed = lineups.some(
      (l) =>
        key(l.m1!) === 'erin|will' &&
        key(l.m2!) === 'erin|trey' &&
        key(l.m3!) === 'mia|will' &&
        key(l.m4!) === 'mia|trey' &&
        key(l.tb!) === 'erin|mia',
    );
    expect(asPlayed).toBe(true);
  });

  it('returns nothing when the roster is too small to be legal', () => {
    const maps: SimMap[] = [
      { id: 'm1', leaderboardId: 'a', maxScore: MAX, isTiebreaker: false },
      { id: 'm2', leaderboardId: 'b', maxScore: MAX, isTiebreaker: false },
      { id: 'm3', leaderboardId: 'c', maxScore: MAX, isTiebreaker: false },
      { id: 'm4', leaderboardId: 'd', maxScore: MAX, isTiebreaker: false },
    ];
    // Three players give only three distinct duos - four maps cannot be legal.
    // This is the exact bind team White was in during the real scrim.
    const { lineups } = enumerateLineups(
      ['kaiden', 'kadence', 'alex'],
      maps,
      MSU_DUOS_FORMAT,
    );
    expect(lineups).toHaveLength(0);
  });
});

describe('simulation basics', () => {
  it('is reproducible for a given seed', () => {
    const a = simulate(drawSamples(setup), { lost: ['w1', 'w2'], m2: ['s1', 's2'], m3: ['s1', 's3'], m4: ['s2', 's3'] }, OPPONENT, FORMAT);
    const b = simulate(drawSamples(setup), { lost: ['w1', 'w2'], m2: ['s1', 's2'], m3: ['s1', 's3'], m4: ['s2', 's3'] }, OPPONENT, FORMAT);
    expect(a.winProbability).toBe(b.winProbability);
  });

  it('models a fail as a discrete drop, not a wide spread', () => {
    const maps: SimMap[] = [{ id: 'm', leaderboardId: 'm', maxScore: MAX, isTiebreaker: false }];
    const samples = drawSamples({
      maps,
      format: FORMAT,
      playerIds: ['risky'],
      predict: () => ({ acc: 0.95, sigmaLogit: 0.05, failProbability: 0.25 }),
      iterations: 20_000,
      seed: 7,
    });
    const draws = Array.from(samples.byMapPlayer.m!.risky!);
    const failed = draws.filter((d) => d < MAX * 0.85).length;

    // About a quarter of runs should be fails, and the rest tightly clustered.
    expect(failed / draws.length).toBeGreaterThan(0.2);
    expect(failed / draws.length).toBeLessThan(0.3);
    const clean = draws.filter((d) => d >= MAX * 0.85);
    expect(Math.min(...clean) / MAX).toBeGreaterThan(0.9);
  });
});

describe('combinations', () => {
  it('produces every unordered pair once', () => {
    expect(combinations(['a', 'b', 'c', 'd'], 2)).toHaveLength(6);
    expect(combinations(['a', 'b'], 3)).toHaveLength(0);
  });
});

const key = (players: readonly string[]) => [...players].sort().join('|');

describe('strategy selection', () => {
  it('solves the real MSU format exactly and quickly', () => {
    const maps: SimMap[] = [
      ...['m1', 'm2', 'm3', 'm4'].map((id) => ({ id, leaderboardId: id, maxScore: MAX, isTiebreaker: false })),
      { id: 'tb', leaderboardId: 'tb', maxScore: MAX, isTiebreaker: true },
    ];
    const roster = ['erin', 'trey', 'mia', 'will'];
    const opponent = Object.fromEntries(maps.map((m) => [m.id, ['b1', 'b2']]));

    const started = performance.now();
    const result = recommendLineups(
      {
        maps,
        format: MSU_DUOS_FORMAT,
        playerIds: [...roster, 'b1', 'b2'],
        predict: (p: string) => ({
          acc: p === 'erin' ? 0.97 : p === 'will' ? 0.965 : p.startsWith('b') ? 0.955 : 0.95,
          sigmaLogit: 0.05,
          failProbability: 0.02,
        }),
        iterations: 20_000,
        seed: 5,
      },
      { maps, format: MSU_DUOS_FORMAT, roster, opponentLineups: opponent },
    );
    const elapsed = performance.now() - started;

    expect(result.strategy).toBe('EXHAUSTIVE');
    expect(result.best).not.toBeNull();
    // Live advice during pick/ban has to feel instant.
    expect(elapsed).toBeLessThan(3000);

    // Whatever it recommends must be legal.
    const duos = ['m1', 'm2', 'm3', 'm4'].map((id) => key(result.best!.lineups[id]!));
    expect(new Set(duos).size).toBe(4);
  });

  it('falls back to local search when the space is too large, and says so', () => {
    const maps: SimMap[] = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({
      id, leaderboardId: id, maxScore: MAX, isTiebreaker: false,
    }));
    const roster = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const format = matchFormatSchema.parse({
      playersPerMap: 3,
      rosterSize: 7,
      tiebreaker: 'NONE',
      rules: { uniqueDuos: true, minAppearances: null, maxAppearances: 3 },
    });
    const opponent = Object.fromEntries(maps.map((m) => [m.id, ['x1', 'x2', 'x3']]));

    const result = recommendLineups(
      {
        maps,
        format,
        playerIds: [...roster, 'x1', 'x2', 'x3'],
        predict: (p: string) => ({
          acc: p.startsWith('x') ? 0.95 : 0.93 + roster.indexOf(p) * 0.005,
          sigmaLogit: 0.05,
          failProbability: 0.02,
        }),
        iterations: 5000,
        seed: 11,
      },
      { maps, format, roster, opponentLineups: opponent },
    );

    expect(result.strategy).toBe('SEARCH');
    expect(result.truncated).toBe(true);
    expect(result.best).not.toBeNull();

    // A found lineup still has to be legal - the search rejects illegal moves
    // rather than repairing them, so this is the guarantee that matters.
    const groups = maps.map((m) => result.best!.lineups[m.id]!);
    expect(groups.every((g) => g.length === 3)).toBe(true);
    expect(new Set(groups.map(key)).size).toBe(5);
    const counts: Record<string, number> = {};
    for (const g of groups) for (const p of g) counts[p] = (counts[p] ?? 0) + 1;
    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(3);
  });
});

describe('when no legal lineup exists', () => {
  const maps: SimMap[] = ['m1', 'm2', 'm3', 'm4'].map((id) => ({
    id, leaderboardId: id, maxScore: MAX, isTiebreaker: false,
  }));
  const opponent = Object.fromEntries(maps.map((m) => [m.id, ['b1', 'b2']]));
  const setup = {
    maps, format: MSU_DUOS_FORMAT, playerIds: ['a', 'b', 'c', 'b1', 'b2'],
    predict: () => ({ acc: 0.95, sigmaLogit: 0.05, failProbability: 0 }),
    iterations: 1000, seed: 3,
  };

  it('says why, instead of returning an empty panel', () => {
    // Three players cannot legally fill four maps of two: the format caps each
    // player at two appearances, so they cover six of the eight slots. This is
    // the exact bind team White was in during the real scrim.
    const result = recommendLineups(setup, {
      maps, format: MSU_DUOS_FORMAT, roster: ['a', 'b', 'c'], opponentLineups: opponent,
    });

    expect(result.best).toBeNull();
    expect(result.infeasible).toMatch(/only cover 6 of the 8 slots/i);
    // The message has to be actionable, not just a diagnosis.
    expect(result.infeasible).toMatch(/Add 1 more player\./);
  });

  it('fits the appearance minimum to an oversized roster rather than giving up', () => {
    // Six players cannot each play twice - that is twelve slots and four duo
    // maps provide eight. The minimum drops to what the slots allow: everyone
    // plays, nobody more than twice.
    const roster = ['a', 'b', 'c', 'd', 'e', 'f'];
    const result = recommendLineups(
      { ...setup, playerIds: [...roster, 'b1', 'b2'] },
      { maps, format: MSU_DUOS_FORMAT, roster, opponentLineups: opponent },
    );

    expect(result.infeasible).toBeUndefined();
    expect(result.best).not.toBeNull();

    const appearances = new Map<string, number>();
    for (const map of maps.filter((m) => !m.isTiebreaker)) {
      for (const id of result.best!.lineups[map.id] ?? []) {
        appearances.set(id, (appearances.get(id) ?? 0) + 1);
      }
    }
    for (const id of roster) {
      expect(appearances.get(id) ?? 0).toBeGreaterThanOrEqual(1);
      expect(appearances.get(id) ?? 0).toBeLessThanOrEqual(2);
    }
  });

  it('is satisfiable for the roster the format was designed around', () => {
    const result = recommendLineups(setup, {
      maps, format: MSU_DUOS_FORMAT, roster: ['a', 'b', 'c', 'd'], opponentLineups: opponent,
    });
    expect(result.infeasible).toBeUndefined();
    expect(result.best).not.toBeNull();
  });
});

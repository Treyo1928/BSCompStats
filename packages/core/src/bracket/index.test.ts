import { describe, expect, it } from 'vitest';
import {
  champion,
  doubleElimination,
  makeDuos,
  placings,
  resolveBracket,
  roundRobin,
  seedOrder,
  singleElimination,
  standings,
  type BracketNodeSpec,
} from './index.js';

const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

/** Play a bracket out with the lower seed number always winning, returning the results. */
function playOut(nodes: BracketNodeSpec[], seeds: string[], pick = (a: string, b: string) => (a < b ? a : b)) {
  const results: Record<string, string> = {};
  for (let i = 0; i < nodes.length * 2; i++) {
    const ready = resolveBracket(nodes, seeds, results).filter((n) => n.state === 'READY');
    if (ready.length === 0) break;
    for (const node of ready) {
      const a = Number(node.teamA!.slice(1));
      const b = Number(node.teamB!.slice(1));
      results[node.key] = pick(`${String(a).padStart(3, '0')}`, `${String(b).padStart(3, '0')}`) === String(a).padStart(3, '0') ? node.teamA! : node.teamB!;
    }
  }
  return results;
}

describe('round robin', () => {
  it('has everyone meet everyone once', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      const nodes = roundRobin(n);
      expect(nodes).toHaveLength((n * (n - 1)) / 2);
      const pairs = new Set(nodes.map((m) => `${'seed' in m.a && m.a.seed}-${'seed' in m.b && m.b.seed}`));
      expect(pairs.size).toBe(nodes.length);
      // Nobody plays twice in a round.
      for (const round of new Set(nodes.map((m) => m.round))) {
        const seen = nodes.filter((m) => m.round === round).flatMap((m) => ['seed' in m.a && m.a.seed, 'seed' in m.b && m.b.seed]);
        expect(new Set(seen).size).toBe(seen.length);
      }
    }
  });

  it('ranks by wins, then map difference', () => {
    const nodes = roundRobin(3);
    const seeds = teams(3);
    const results: Record<string, string> = {};
    const resolved0 = resolveBracket(nodes, seeds, {});
    for (const node of resolved0) results[node.key] = node.teamA === 't3' || node.teamB === 't3' ? 't3' : 't2';
    const resolved = resolveBracket(nodes, seeds, results);
    const table = standings(resolved, seeds);
    expect(table.map((s) => [s.teamId, s.wins])).toEqual([
      ['t3', 2],
      ['t2', 1],
      ['t1', 0],
    ]);
  });
});

describe('single elimination', () => {
  it('seeds 1 and 2 apart, with 1 against the lowest seed', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('gives the top seeds the byes and plays out to a champion', () => {
    const nodes = singleElimination(6);
    const seeds = teams(6);
    const first = resolveBracket(nodes, seeds, {});
    const byes = first.filter((n) => n.state === 'BYE').map((n) => n.winner);
    expect(byes.sort()).toEqual(['t1', 't2']);
    const results = playOut(nodes, seeds);
    const final = resolveBracket(nodes, seeds, results);
    expect(champion('SINGLE_ELIM', final)).toBe('t1');
    expect(placings('SINGLE_ELIM', final, seeds).slice(0, 2)).toEqual([
      { teamId: 't1', place: 1 },
      { teamId: 't2', place: 2 },
    ]);
  });

  it('forgets everything downstream of a result that is taken back', () => {
    const nodes = singleElimination(4);
    const seeds = teams(4);
    const results = playOut(nodes, seeds);
    // The first semi-final is reopened: its winner is now unknown.
    const { ['W1-1']: _gone, ...rest } = results;
    const after = resolveBracket(nodes, seeds, rest);
    expect(after.find((n) => n.key === 'W2-1')!.state).toBe('PENDING');
    expect(champion('SINGLE_ELIM', after)).toBeNull();
  });
});

describe('double elimination', () => {
  it('drops every winners-bracket loser into the losers bracket', () => {
    for (const n of [4, 5, 8, 13, 16]) {
      const nodes = doubleElimination(n);
      const drops = nodes.flatMap((m) => [m.a, m.b]).filter((s) => 'loserOf' in s).map((s) => ('loserOf' in s ? s.loserOf : ''));
      const winnersMatches = nodes.filter((m) => m.section === 'W').map((m) => m.key);
      expect(new Set(drops)).toEqual(new Set(winnersMatches));
    }
  });

  it('needs a team to lose twice to be out, and crowns the unbeaten top seed', () => {
    const nodes = doubleElimination(8);
    const seeds = teams(8);
    const results = playOut(nodes, seeds);
    const final = resolveBracket(nodes, seeds, results);
    expect(final.every((n) => n.state === 'DONE' || n.state === 'BYE')).toBe(true);
    const gf = final.find((n) => n.section === 'GF')!;
    expect([gf.teamA, gf.teamB]).toEqual(['t1', 't2']);
    expect(champion('DOUBLE_ELIM', final)).toBe('t1');
    // Every team but the champion lost exactly twice, or once and then lost the grand final.
    const losses = new Map<string, number>();
    for (const n of final) if (n.loser) losses.set(n.loser, (losses.get(n.loser) ?? 0) + 1);
    expect(losses.get('t1')).toBeUndefined();
    for (const t of seeds.slice(2)) expect(losses.get(t)).toBe(2);
  });

  it('marks a losers match with nobody to face as one that is not played, before and after', () => {
    // 6 teams: seeds 1 and 2 skip round 1, so its first losers match has an empty side.
    const nodes = doubleElimination(6);
    const seeds = teams(6);
    const before = resolveBracket(nodes, seeds, {});
    const l1 = before.find((n) => n.key === 'L1-1')!;
    expect(l1.passThrough).toBe(true);
    expect(l1.state).toBe('PENDING');
    const w12 = before.find((n) => n.key === 'W1-2')!;
    const after = resolveBracket(nodes, seeds, { 'W1-2': w12.teamB! });
    const l1After = after.find((n) => n.key === 'L1-1')!;
    expect(l1After.state).toBe('BYE');
    // The loser goes straight to losers round 2.
    expect(after.find((n) => n.key === 'L2-1')!.teamA).toBe(w12.teamA);
    expect(before.find((n) => n.key === 'W2-1')!.passThrough).toBe(false);
  });

  it('handles byes in both brackets', () => {
    const nodes = doubleElimination(5);
    const seeds = teams(5);
    const results = playOut(nodes, seeds);
    const final = resolveBracket(nodes, seeds, results);
    expect(champion('DOUBLE_ELIM', final)).toBe('t1');
    expect(final.some((n) => n.state === 'READY' || n.state === 'PENDING')).toBe(false);
  });
});

describe('making duos', () => {
  it('pairs the top seed with the bottom one', () => {
    expect(makeDuos(['a', 'b', 'c', 'd'], 'SEEDED')).toEqual({ duos: [['a', 'd'], ['b', 'c']], left: [] });
  });

  it('leaves the middle seed out of an odd number', () => {
    expect(makeDuos(['a', 'b', 'c', 'd', 'e'], 'SEEDED')).toEqual({ duos: [['a', 'e'], ['b', 'd']], left: ['c'] });
  });

  it('pairs at random, using everyone', () => {
    let i = 0;
    const random = () => [0.1, 0.9, 0.4, 0.6, 0.3][i++ % 5]!;
    const { duos, left } = makeDuos(['a', 'b', 'c', 'd', 'e', 'f'], 'RANDOM', random);
    expect(duos).toHaveLength(3);
    expect(left).toEqual([]);
    expect(new Set(duos.flat())).toEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f']));
  });
});

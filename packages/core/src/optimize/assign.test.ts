import { describe, expect, it } from 'vitest';
import { assignSpread } from './assign.js';
import { mulberry32 } from './random.js';

type Option = { playerIds: string[]; value: number };
const duos = (players: string[]) =>
  players.flatMap((a, i) => players.slice(i + 1).map((b) => [a, b]));

/** Every assignment, checked by hand: the most any set of choices can total under the same repeat rule. */
function bruteForce(perMap: Option[][]): number {
  const key = (o: Option) => [...o.playerIds].sort().join('|');
  const distinct = new Set(perMap.flat().map(key)).size;
  const allowed = Math.max(0, perMap.length - distinct);
  let best = -1;
  const walk = (i: number, total: number, used: Map<string, number>, repeats: number) => {
    if (i === perMap.length) return void (best = Math.max(best, total));
    for (const o of perMap[i]!) {
      const k = key(o);
      const count = used.get(k) ?? 0;
      if (count > 0 && repeats === allowed) continue;
      used.set(k, count + 1);
      walk(i + 1, total + o.value, used, repeats + (count > 0 ? 1 : 0));
      used.set(k, count);
    }
  };
  walk(0, 0, new Map(), 0);
  return best;
}

const total = (picks: Array<Option | null>) => picks.reduce((s, p) => s + (p?.value ?? 0), 0);
const repeats = (picks: Array<Option | null>) => {
  const keys = picks.filter((p) => p != null).map((p) => [...p!.playerIds].sort().join('|'));
  return keys.length - new Set(keys).size;
};

function instance(seed: number, maps: number, players: number): Option[][] {
  const random = mulberry32(seed);
  return Array.from({ length: maps }, () => duos(Array.from({ length: players }, (_, i) => `p${i}`)).map((playerIds) => ({ playerIds, value: random() })));
}

describe('assignSpread', () => {
  it('finds the best total, as a full search does', () => {
    for (let seed = 1; seed <= 40; seed++) {
      // Four players: six duos, so up to seven maps needs a repeat; five players: ten duos.
      const perMap = instance(seed, 3 + (seed % 5), seed % 2 ? 4 : 5);
      const picks = assignSpread(perMap);
      expect(picks.every((p) => p != null)).toBe(true);
      expect(total(picks)).toBeCloseTo(bruteForce(perMap), 10);
    }
  });

  it('repeats a group only as often as the numbers force', () => {
    const perMap = instance(7, 7, 4); // six duos, seven maps
    expect(repeats(assignSpread(perMap))).toBe(1);
    expect(repeats(assignSpread(instance(8, 6, 4)))).toBe(0);
  });

  it('spreads one dominant duo instead of fielding it everywhere', () => {
    const perMap = Array.from({ length: 3 }, () => [
      { playerIds: ['a', 'b'], value: 0.99 },
      { playerIds: ['a', 'c'], value: 0.6 },
      { playerIds: ['b', 'c'], value: 0.5 },
    ]);
    const picks = assignSpread(perMap);
    expect(repeats(picks)).toBe(0);
    expect(total(picks)).toBeCloseTo(0.99 + 0.6 + 0.5, 10);
  });

  it('settles the 18-map pool that froze the server, at once', () => {
    // The live case: eighteen maps, five players, ten duos - 10^18 branches for the old search.
    const perMap = instance(42, 18, 5);
    const started = performance.now();
    const picks = assignSpread(perMap);
    expect(performance.now() - started).toBeLessThan(250);
    expect(picks.every((p) => p != null)).toBe(true);
    expect(repeats(picks)).toBe(8);
  });

  it('leaves a map with no options empty rather than giving up on the rest', () => {
    const picks = assignSpread([[{ playerIds: ['a', 'b'], value: 0.7 }], [], [{ playerIds: ['a', 'c'], value: 0.4 }]]);
    expect(picks.map((p) => p?.value ?? null)).toEqual([0.7, null, 0.4]);
  });

  it('does not let a missing number switch the optimisation off', () => {
    const picks = assignSpread([
      [{ playerIds: ['a', 'b'], value: NaN }, { playerIds: ['a', 'c'], value: 0.8 }],
      [{ playerIds: ['a', 'b'], value: 0.9 }, { playerIds: ['a', 'c'], value: 0.1 }],
    ]);
    expect(picks.map((p) => p!.playerIds.join(''))).toEqual(['ac', 'ab']);
  });
});

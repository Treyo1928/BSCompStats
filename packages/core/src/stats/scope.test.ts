import { describe, it, expect } from 'vitest';
import {
  applyScope,
  statsScopeSchema,
  DEFAULT_STATS_SCOPE,
  FULL_HISTORY_PRESET,
  recencyWeight,
  describeScope,
  type ScopedScore,
} from './scope.js';

const NOW = 1_800_000_000;
const daysAgo = (d: number) => NOW - d * 86_400;

const score = (over: Partial<ScopedScore> & { playerId: string; leaderboardId: string }): ScopedScore => ({
  acc: 0.95,
  isDnf: false,
  timeset: daysAgo(10),
  inPool: true,
  ranked: false,
  ...over,
});

describe('the default scope', () => {
  it('uses pool maps only', () => {
    expect(DEFAULT_STATS_SCOPE.source).toBe('POOL_ONLY');

    const result = applyScope(
      [
        score({ playerId: 'a', leaderboardId: 'pool1' }),
        score({ playerId: 'b', leaderboardId: 'pool1' }),
        score({ playerId: 'a', leaderboardId: 'elsewhere', inPool: false }),
      ],
      DEFAULT_STATS_SCOPE,
      NOW,
    );

    expect(result.observations).toHaveLength(2);
    expect(result.excluded['not in a tournament pool']).toBe(1);
  });

  it('keeps every score at full weight when no half-life is set', () => {
    const result = applyScope(
      [
        score({ playerId: 'a', leaderboardId: 'm', timeset: daysAgo(900) }),
        score({ playerId: 'b', leaderboardId: 'm' }),
      ],
      DEFAULT_STATS_SCOPE,
      NOW,
    );
    expect(result.observations.every((o) => o.weight === 1)).toBe(true);
  });
});

describe('full history with filters', () => {
  it('lets outside scores in', () => {
    const result = applyScope(
      [
        score({ playerId: 'a', leaderboardId: 'pool1' }),
        score({ playerId: 'b', leaderboardId: 'pool1' }),
        score({ playerId: 'a', leaderboardId: 'elsewhere', inPool: false }),
        score({ playerId: 'b', leaderboardId: 'elsewhere', inPool: false }),
      ],
      statsScopeSchema.parse({ source: 'FULL_HISTORY' }),
      NOW,
    );
    expect(result.observations).toHaveLength(4);
    expect(result.mapCount).toBe(2);
  });

  it('drops scores past the age limit', () => {
    const result = applyScope(
      [
        score({ playerId: 'a', leaderboardId: 'm', timeset: daysAgo(30) }),
        score({ playerId: 'b', leaderboardId: 'm', timeset: daysAgo(30) }),
        score({ playerId: 'a', leaderboardId: 'm2', timeset: daysAgo(500) }),
        score({ playerId: 'b', leaderboardId: 'm2', timeset: daysAgo(500) }),
      ],
      statsScopeSchema.parse({ source: 'FULL_HISTORY', maxAgeDays: 365 }),
      NOW,
    );
    expect(result.observations).toHaveLength(2);
    expect(result.excluded['older than the age limit']).toBe(2);
  });

  it('weights recent scores more heavily', () => {
    const result = applyScope(
      [
        score({ playerId: 'a', leaderboardId: 'm', timeset: NOW }),
        score({ playerId: 'b', leaderboardId: 'm', timeset: daysAgo(120) }),
      ],
      statsScopeSchema.parse({ source: 'FULL_HISTORY', halfLifeDays: 120 }),
      NOW,
    );
    const [fresh, old] = result.observations;
    expect(fresh!.weight).toBeCloseTo(1, 3);
    expect(old!.weight).toBeCloseTo(0.5, 3); // exactly one half-life
  });

  it('keeps only ranked maps under RANKED_ONLY', () => {
    const result = applyScope(
      [
        score({ playerId: 'a', leaderboardId: 'ranked', ranked: true, inPool: false }),
        score({ playerId: 'b', leaderboardId: 'ranked', ranked: true, inPool: false }),
        score({ playerId: 'a', leaderboardId: 'unranked' }),
        score({ playerId: 'b', leaderboardId: 'unranked' }),
      ],
      statsScopeSchema.parse({ source: 'RANKED_ONLY' }),
      NOW,
    );
    expect(result.mapCount).toBe(1);
    expect(result.excluded['map is not ranked']).toBe(2);
  });
});

describe('outlier removal', () => {
  it('trims a disaster without touching a career best', () => {
    // Six normal scores, one terrible, one excellent.
    const scores: ScopedScore[] = [
      ...[0.95, 0.955, 0.96, 0.952, 0.958, 0.954].map((acc, i) =>
        score({ playerId: 'a', leaderboardId: `m${i}`, acc }),
      ),
      score({ playerId: 'a', leaderboardId: 'disaster', acc: 0.4 }),
      score({ playerId: 'a', leaderboardId: 'best', acc: 0.99 }),
      // A second player so no map falls below the per-map floor.
      ...['m0','m1','m2','m3','m4','m5','disaster','best'].map((m) =>
        score({ playerId: 'b', leaderboardId: m, acc: 0.94 }),
      ),
    ];

    const result = applyScope(
      scores,
      statsScopeSchema.parse({ source: 'FULL_HISTORY', outlierSigmas: 3 }),
      NOW,
    );

    const aMaps = result.observations.filter((o) => o.playerId === 'a').map((o) => o.leaderboardId);
    expect(aMaps).not.toContain('disaster');
    // An unusually good run is real evidence and must survive.
    expect(aMaps).toContain('best');
  });
});

describe('the per-map floor', () => {
  it('drops a map only one player has touched', () => {
    const result = applyScope(
      [
        score({ playerId: 'a', leaderboardId: 'shared' }),
        score({ playerId: 'b', leaderboardId: 'shared' }),
        score({ playerId: 'a', leaderboardId: 'lonely' }),
      ],
      DEFAULT_STATS_SCOPE,
      NOW,
    );
    expect(result.mapCount).toBe(1);
    expect(result.excluded['too few players on this map']).toBe(1);
  });
});

describe('helpers', () => {
  it('halves the weight every half-life', () => {
    expect(recencyWeight(NOW, NOW, 100)).toBeCloseTo(1);
    expect(recencyWeight(daysAgo(100), NOW, 100)).toBeCloseTo(0.5);
    expect(recencyWeight(daysAgo(200), NOW, 100)).toBeCloseTo(0.25);
    expect(recencyWeight(daysAgo(999), NOW, null)).toBe(1);
  });

  it('describes a scope in one line', () => {
    expect(describeScope(DEFAULT_STATS_SCOPE)).toBe('pool maps only');
    const described = describeScope(FULL_HISTORY_PRESET);
    expect(described).toContain('full BeatLeader history');
    expect(described).toContain('365 days');
  });
});

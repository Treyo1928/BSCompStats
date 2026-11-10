import { describe, expect, it } from 'vitest';
import { rankTiers } from './rank-tiers.js';

const row = (playerName: string, played: number, meanAcc: number | null) => ({ playerName, played, meanAcc });

describe('rankTiers', () => {
  it('puts players with more maps played above a better average over fewer', () => {
    const tiers = rankTiers([row('Few', 2, 0.99), row('AllLow', 4, 0.9), row('AllHigh', 4, 0.95), row('Most', 3, 0.97)], 4);
    expect(tiers.map((t) => t.label)).toEqual(['Played all 4 maps', 'Played 3 of 4 maps', 'Played 2 of 4 maps']);
    expect(tiers.flatMap((t) => t.rows.map((r) => `${r.place} ${r.row.playerName}`))).toEqual([
      '1 AllHigh',
      '2 AllLow',
      '3 Most',
      '4 Few',
    ]);
  });

  it('lists players with nothing played last, without a place', () => {
    const tiers = rankTiers([row('None', 0, null), row('One', 1, 0.8)], 3);
    expect(tiers.at(-1)).toMatchObject({ played: 0, label: 'No maps played', rows: [{ place: null }] });
    expect(tiers[0]!.rows[0]!.place).toBe(1);
  });

  it('breaks an equal average by name, and is empty for no rows', () => {
    expect(rankTiers([row('B', 1, 0.9), row('A', 1, 0.9)], 1)[0]!.rows.map((r) => r.row.playerName)).toEqual(['A', 'B']);
    expect(rankTiers([], 5)).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePlaylist, resolvePlaylistEntries, toResolvedMap } from './playlist.js';
import { BeatLeaderClient } from './client.js';
import type { BLSong } from './types.js';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/playlist-110086.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;

describe('parsePlaylist', () => {
  it('reads the real BeatLeader playlist 110086', () => {
    const result = parsePlaylist(fixture);

    expect(result.title).toBe('Fall 2026 Week 1 Song Pool');
    expect(result.entries).toHaveLength(7);
    expect(result.skipped).toHaveLength(0);

    // Spot-check the first entry against the raw response.
    expect(result.entries[0]).toMatchObject({
      hash: '1de420e30b629a33bd12899c33de98157287e6aa',
      difficultyValue: 9, // "expertPlus"
      mode: 1, // "Standard"
      songNameHint: 'BREAKME',
    });

    // The pool spans several difficulties - make sure each is read, not just
    // the first, since a pool silently collapsing to one difficulty would be
    // both wrong and hard to notice.
    const diffs = result.entries.map((e) => e.difficultyValue).sort();
    expect(diffs).toEqual([1, 1, 3, 7, 7, 7, 9]);
  });

  it('never carries the embedded base64 cover through', () => {
    // The live response is 2.23 MB, essentially all of it this one field.
    expect(typeof fixture.image).toBe('string');
    expect((fixture.image as string).length).toBeGreaterThan(0);

    const result = parsePlaylist(fixture);
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain('data:image');
    expect(serialised).not.toContain('UklGR'); // webp base64 magic
    expect(serialised.length).toBeLessThan(4000);
  });

  it('reports unusable songs instead of dropping them', () => {
    const result = parsePlaylist({
      playlistTitle: 'Broken',
      songs: [
        { songName: 'No hash' },
        { songName: 'No difficulties', hash: 'a'.repeat(40) },
        {
          songName: 'Bad difficulty',
          hash: 'b'.repeat(40),
          difficulties: [{ name: 'impossible', characteristic: 'Standard' }],
        },
        {
          songName: 'Fine',
          hash: 'c'.repeat(40),
          difficulties: [{ name: 'expert', characteristic: 'Standard' }],
        },
      ],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped.map((s) => s.songName)).toEqual([
      'No hash',
      'No difficulties',
      'Bad difficulty',
    ]);
  });

  it('deduplicates a difficulty listed twice', () => {
    const result = parsePlaylist({
      songs: [
        {
          hash: 'd'.repeat(40),
          difficulties: [
            { name: 'expertPlus', characteristic: 'Standard' },
            { name: 'ExpertPlus', characteristic: 'Standard' },
          ],
        },
      ],
    });
    expect(result.entries).toHaveLength(1);
  });

  it('rejects something that is not a playlist at all', () => {
    expect(() => parsePlaylist({ nope: true })).not.toThrow(); // songs defaults to []
    expect(() => parsePlaylist('a string')).toThrow(/not a valid playlist/i);
  });
});

describe('toResolvedMap', () => {
  // Fields as returned by /map/hash for the unranked map "Madeleine", which is
  // representative: tournament pools are usually unranked, so there is no
  // rating vector at all - only maxScore and chart shape.
  const song: BLSong = {
    id: '3185d',
    hash: '3185D0FAKEHASH',
    name: 'Madeleine',
    author: 'Good Kid',
    mapper: 'someone',
    bpm: 150,
    duration: 175,
    difficulties: [
      {
        id: 1,
        value: 1,
        mode: 1,
        difficultyName: 'Easy',
        modeName: 'Standard',
        status: 0,
        maxScore: 98555,
        stars: null,
        accRating: null,
        passRating: null,
        techRating: null,
        predictedAcc: 0.9953476,
        njs: 10,
        nps: 0.694,
        notes: 115,
        walls: 104,
      },
    ],
  };

  it('derives the leaderboard id and keeps maxScore for an unranked map', () => {
    const resolved = toResolvedMap(song, song.difficulties![0]!);

    expect(resolved.leaderboard.id).toBe('3185d11');
    expect(resolved.leaderboard.maxScore).toBe(98555);
    expect(resolved.leaderboard.ranked).toBe(false);
    // Unranked maps genuinely have no ratings; they must read 0, not NaN.
    expect(resolved.leaderboard.accRating).toBe(0);
    expect(resolved.leaderboard.stars).toBe(0);
    expect(resolved.leaderboard.nps).toBeCloseTo(0.694);
    expect(resolved.map.hash).toBe('3185d0fakehash');
  });
});

describe('resolvePlaylistEntries', () => {
  it('fetches one request per song, not per difficulty', async () => {
    const calls: string[] = [];
    const client = new BeatLeaderClient({
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            id: 'abc12',
            hash: 'e'.repeat(40),
            name: 'Test',
            difficulties: [
              { id: 1, value: 7, mode: 1, difficultyName: 'Expert', modeName: 'Standard', status: 0, maxScore: 1000 },
              { id: 2, value: 9, mode: 1, difficultyName: 'ExpertPlus', modeName: 'Standard', status: 0, maxScore: 2000 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    const result = await resolvePlaylistEntries(client, [
      { hash: 'e'.repeat(40), difficultyValue: 7, mode: 1 },
      { hash: 'e'.repeat(40), difficultyValue: 9, mode: 1 },
    ]);

    expect(calls).toHaveLength(1);
    expect(result.resolved.map((r) => r.leaderboard.id)).toEqual(['abc1271', 'abc1291']);
    expect(result.failed).toHaveLength(0);
  });

  it('reports a difficulty the map does not actually have', async () => {
    const client = new BeatLeaderClient({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 'abc12',
            hash: 'f'.repeat(40),
            name: 'Test',
            difficulties: [
              { id: 1, value: 7, mode: 1, difficultyName: 'Expert', modeName: 'Standard', status: 0 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });

    const result = await resolvePlaylistEntries(client, [
      { hash: 'f'.repeat(40), difficultyValue: 9, mode: 1, songNameHint: 'Test' },
    ]);

    expect(result.resolved).toHaveLength(0);
    expect(result.failed[0]?.reason).toMatch(/no 9\/1 difficulty/);
  });
});

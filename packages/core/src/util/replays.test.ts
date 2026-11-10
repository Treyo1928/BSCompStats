import { describe, expect, it } from 'vitest';
import { parseReplayRef, parseShowcaseReplays } from './replays.js';

describe('parseReplayRef', () => {
  it('reads BeatLeader links and ids as one score', () => {
    const want = { kind: 'beatleader', scoreId: '12345678', ref: 'https://replay.beatleader.com/?scoreId=12345678' };
    for (const raw of [
      '12345678',
      'bl:12345678',
      ' https://replay.beatleader.com/?scoreId=12345678 ',
      'https://replay.beatleader.xyz/?scoreId=12345678&time=3',
      'https://beatleader.com/score/12345678',
      'https://www.beatleader.xyz/score/12345678/',
      'http://127.0.0.1:4000/?scoreIdBL=12345678',
    ]) {
      expect(parseReplayRef(raw), raw).toEqual(want);
    }
  });

  it('takes a .bsor file over https', () => {
    expect(parseReplayRef('https://cdn.replays.beatleader.xyz/123-ExpertPlus-Standard-ABC.bsor')).toEqual({
      kind: 'file',
      ref: 'https://cdn.replays.beatleader.xyz/123-ExpertPlus-Standard-ABC.bsor',
    });
    expect(parseReplayRef('http://example.com/a.bsor')).toBeNull();
  });

  it('refuses anything else', () => {
    for (const raw of ['', 'hello', 'https://example.com/', 'https://beatleader.com/u/123', 'javascript:alert(1)', '1'.repeat(13)]) {
      expect(parseReplayRef(raw), raw).toBeNull();
    }
  });
});

describe('parseShowcaseReplays', () => {
  it('keeps replays and drops the rest', () => {
    expect(
      parseShowcaseReplays([
        { ref: 'https://replay.beatleader.com/?scoreId=5', scoreId: '5', song: 'Song', accuracy: 0.97, junk: 1 },
        { ref: 'nope' },
        null,
        'text',
      ]),
    ).toEqual([{ ref: 'https://replay.beatleader.com/?scoreId=5', scoreId: '5', song: 'Song', accuracy: 0.97 }]);
    expect(parseShowcaseReplays('x')).toEqual([]);
  });
});

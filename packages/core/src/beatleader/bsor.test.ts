import { describe, expect, it } from 'vitest';
import { readReplayInfo } from './bsor.js';

/** The start of a replay, laid out as BeatLeader writes it, followed by some frame data. */
function replayStart(fields: { modifiers: string; score: number; failTime?: number; difficulty?: string }): Uint8Array {
  const parts: number[] = [];
  const int = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    parts.push(...b);
  };
  const float = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    parts.push(...b);
  };
  const str = (s: string) => {
    const b = new TextEncoder().encode(s);
    int(b.length);
    parts.push(...b);
  };
  int(0x442d3d69);
  parts.push(1, 0);
  str('0.9.27');
  str('1.39.1_1715');
  str('1794464301');
  str('76561190000000000');
  str('Somebody');
  str('steam');
  str('Oculus');
  str('Quest 2');
  str('Oculus Touch');
  str('37A1693BAD0BC7F75D2602029BDED6E6BD0B73C9');
  str('Some Song');
  str('Some Mapper');
  str(fields.difficulty ?? 'Expert');
  int(fields.score);
  str('Standard');
  str('TheFirst');
  str(fields.modifiers);
  float(18);
  parts.push(0);
  float(1.7);
  float(0);
  float(fields.failTime ?? 0);
  float(0);
  parts.push(...new Array(64).fill(7));
  return new Uint8Array(parts);
}

describe('readReplayInfo', () => {
  it('reads what the run was played with', () => {
    const info = readReplayInfo(replayStart({ modifiers: '', score: 363787, difficulty: 'Normal' }));
    expect(info).toMatchObject({ playerId: '76561190000000000', difficulty: 'Normal', mode: 'Standard', score: 363787, modifiers: '', failTime: 0 });
  });

  it('carries No Fail where it kicked in, and other modifiers', () => {
    expect(readReplayInfo(replayStart({ modifiers: 'NF', score: 753138 }))?.modifiers).toBe('NF');
    expect(readReplayInfo(replayStart({ modifiers: 'PM,BE', score: 1 }))?.modifiers).toBe('PM,BE');
    expect(readReplayInfo(replayStart({ modifiers: '', score: 1, failTime: 41.5 }))?.failTime).toBeCloseTo(41.5);
  });

  it('wants the whole info section', () => {
    const full = replayStart({ modifiers: 'NF', score: 1 });
    expect(readReplayInfo(full.subarray(0, 120))).toBeNull();
    expect(readReplayInfo(full.subarray(0, 0))).toBeNull();
  });

  it('is not fooled by something that is not a replay', () => {
    expect(readReplayInfo(new TextEncoder().encode('<html>Not found</html>'))).toBeNull();
  });
});

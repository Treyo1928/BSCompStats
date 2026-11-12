/**
 * The start of a BeatLeader replay (.bsor): its info section, which says what
 * the run was played with.
 *
 * BeatLeader's record of a run (`/map/scorestats`) leaves the modifiers out
 * entirely - No Fail kicking in included - and only a run that beat the
 * player's best became a score that has them. The replay always has them: it
 * is what BeatLeader reads a score's modifiers from in the first place, so
 * "NF" is there only where No Fail actually kicked in.
 *
 * Layout: int32 magic, a version byte, a section byte (0 = info), then the info
 * fields in order. Strings are an int32 byte length and UTF-8. All of it sits in
 * the first few hundred bytes.
 */

const MAGIC = 0x442d3d69;

export interface ReplayInfo {
  playerId: string;
  /** BeatLeader's difficulty name: "Expert", "ExpertPlus", ... */
  difficulty: string;
  mode: string;
  score: number;
  /** Comma-separated, as on a score: "NF" where No Fail kicked in. Empty for none. */
  modifiers: string;
  /** Seconds into the song where it was started (practice), else 0. */
  startTime: number;
  /** Seconds into the song where it was failed, else 0. */
  failTime: number;
  /** Practice speed, else 0. */
  speed: number;
}

/**
 * Reads the info section from the start of a replay. Null when the bytes are
 * not a replay, or end before the section does - pass more of the file.
 */
export function readReplayInfo(bytes: Uint8Array): ReplayInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.byteLength) throw new RangeError('short');
  };
  const int = () => {
    need(4);
    const v = view.getInt32(at, true);
    at += 4;
    return v;
  };
  const float = () => {
    need(4);
    const v = view.getFloat32(at, true);
    at += 4;
    return v;
  };
  const byte = () => {
    need(1);
    return bytes[at++]!;
  };
  const str = () => {
    const length = int();
    if (length < 0 || length > 1 << 16) throw new RangeError('not a string');
    need(length);
    const v = text.decode(bytes.subarray(at, at + length));
    at += length;
    return v;
  };

  try {
    if (int() !== MAGIC) return null;
    byte(); // format version
    if (byte() !== 0) return null; // the info section comes first
    str(); // mod version
    str(); // game version
    str(); // timestamp
    const playerId = str();
    str(); // player name
    str(); // platform
    str(); // tracking system
    str(); // headset
    str(); // controller
    str(); // song hash
    str(); // song name
    str(); // mapper
    const difficulty = str();
    const score = int();
    const mode = str();
    str(); // environment
    const modifiers = str();
    float(); // jump distance
    byte(); // left handed
    float(); // height
    const startTime = float();
    const failTime = float();
    const speed = float();
    return { playerId, difficulty, mode, score, modifiers, startTime, failTime, speed };
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

import { parseReplayRef, type ShowcaseReplay } from '@bscs/core';
import { beatLeader } from './pools';

/**
 * Read a pasted list of replays (one link per line) into what is stored: for a player's profile, or for a player in
 * one tournament. Replays already known (`known`: by link) are kept as they are; new ones are looked up on
 * BeatLeader, for the list shown here and so that a player's replays are their own.
 *
 * `anyones`: an organiser or site admin is pasting, who may add a replay played by someone else, a plain replay
 * file, and may go on when BeatLeader cannot be reached. Otherwise every replay must be a BeatLeader score of this
 * player's. Answers the list, or `error`: the sentence to show.
 */
export async function readReplayList(
  lines: string[],
  opts: { anyones: boolean; player: { name: string; beatLeaderId: string }; known: ShowcaseReplay[] },
): Promise<{ replays: ShowcaseReplay[] } | { error: string }> {
  const known = new Map(opts.known.map((r) => [r.ref, r]));
  const replays: ShowcaseReplay[] = [];
  for (const line of lines) {
    const parsed = parseReplayRef(line);
    if (!parsed) {
      return { error: `"${line.slice(0, 80)}" is not a replay link. Paste a BeatLeader replay link (replay.beatleader.com/?scoreId=...), a BeatLeader score id, or the address of a .bsor file.` };
    }
    if (replays.some((r) => r.ref === parsed.ref)) continue;
    const kept = known.get(parsed.ref);
    if (kept) {
      replays.push(kept);
      continue;
    }
    if (parsed.kind === 'file') {
      if (!opts.anyones) return { error: 'Paste a BeatLeader replay link, so the site can tell whose replay it is.' };
      replays.push({ ref: parsed.ref });
      continue;
    }
    const score = await beatLeader.getScore(parsed.scoreId).catch(() => undefined);
    if (score === null) return { error: `BeatLeader has no score ${parsed.scoreId}.` };
    if (score === undefined && !opts.anyones) return { error: 'BeatLeader could not be reached to check that replay. Try again in a moment.' };
    if (score && !score.replay) return { error: `BeatLeader no longer has the replay file for score ${parsed.scoreId} (${score.song?.name ?? 'unknown song'}).` };
    if (score && !opts.anyones && String(score.playerId) !== opts.player.beatLeaderId) {
      return { error: `Score ${parsed.scoreId} was played by ${score.player?.name ?? 'someone else'}, not ${opts.player.name}.` };
    }
    replays.push({
      ref: parsed.ref,
      scoreId: parsed.scoreId,
      ...(score
        ? {
            song: score.song?.name ?? undefined,
            mapper: score.song?.mapper ?? undefined,
            difficulty: score.difficulty?.difficultyName ?? undefined,
            accuracy: typeof score.accuracy === 'number' ? score.accuracy : undefined,
            player: score.player?.name ?? undefined,
          }
        : {}),
    });
  }
  return { replays };
}

/** The lines of a pasted list, blank ones dropped. */
export const pastedLines = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** "#rrggbb" from a form, or null. */
export const hexColour = (value: FormDataEntryValue | null) => {
  const text = String(value ?? '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : null;
};

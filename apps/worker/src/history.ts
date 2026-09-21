import { prisma } from '@bscs/db';
import { toResolvedMap } from '@bscs/core/beatleader';
import { statsScopeSchema } from '@bscs/core/stats';
import { client, upsertScore } from './sync.js';
import { log } from './log.js';

/**
 * Players' wider BeatLeader history, for tournaments that ask for it.
 *
 * The ordinary sync only follows the maps in a pool. That is all the default
 * "pool only" scope needs, but it means the model knows nothing about a player
 * beyond the handful of maps they chose to practise - and people practise what
 * they are good at. A scope that reaches past the pool needs the scores to
 * exist first, and this is what fetches them.
 *
 * Scores are read newest first. The first run for a player walks all the way
 * back to the scope's age limit and records that it got there; only after that
 * do later runs stop at the first page with nothing new, which makes them one
 * request. The record matters: "a page with nothing new means the rest is
 * stored" is only true once a backfill has finished. Before this was tracked,
 * a backfill cut short by a restart left page one fully stored, so every later
 * run stopped there and the player kept a fraction of their history for good.
 */

const PAGE_SIZE = 100;
/** 6,000 scores. Reaching it counts as done: re-walking sixty pages every poll would never get further. */
const MAX_PAGES = 60;

export async function syncHistories(): Promise<{ players: number; written: number }> {
  const tournaments = await prisma.tournament.findMany({
    select: {
      statsScope: true,
      divisions: {
        select: {
          teams: {
            select: {
              members: {
                select: { player: { select: { id: true, beatLeaderId: true, name: true, historyBackfilledTo: true } } },
              },
            },
          },
        },
      },
    },
  });

  // Player -> how far back to fetch (unix seconds; 0 = everything, which is what every tournament asks for now).
  const wanted = new Map<string, { beatLeaderId: string; name: string; since: number; backfilledTo: number | null }>();
  const now = Math.floor(Date.now() / 1000);

  for (const tournament of tournaments) {
    const parsed = statsScopeSchema.safeParse(tournament.statsScope ?? {});
    if (!parsed.success) continue;
    if (parsed.data.source === 'POOL_ONLY' && !parsed.data.keepHistory) continue;
    // Everything, however old. What the *model* learns from has an age limit,
    // and applies it itself when it reads the scores. The download must not:
    // the stats pages compare players on maps they have both played, a
    // leaderboard score is a personal best that does not go stale, and a year's
    // cutoff left three coaches with 729, 358 and 278 ranked scores sharing
    // 8, 2 and 0 ranked maps between them instead of 79, 62 and 34.
    const since = 0;

    for (const division of tournament.divisions) {
      for (const team of division.teams) {
        for (const { player } of team.members) {
          const existing = wanted.get(player.id);
          wanted.set(player.id, {
            beatLeaderId: player.beatLeaderId,
            name: player.name,
            since: existing ? Math.min(existing.since, since) : since,
            backfilledTo: player.historyBackfilledTo,
          });
        }
      }
    }
  }

  let written = 0;
  for (const [playerId, player] of wanted) {
    try {
      // Complete only if an earlier walk reached at least as far back as is wanted now.
      const complete = player.backfilledTo != null && player.backfilledTo <= player.since;
      const result = await syncPlayerHistory(playerId, player.beatLeaderId, player.since, complete);
      written += result.written;
      if (!complete) {
        log.info(
          `history: backfilled ${player.name} - ${result.written} new scores over ${result.pages} pages` +
            (result.hitPageLimit ? ` (stopped at the ${MAX_PAGES}-page limit; anything older is left out)` : ''),
        );
        if (result.finished) {
          await prisma.player.update({ where: { id: playerId }, data: { historyBackfilledTo: player.since } });
        }
      }
    } catch (err) {
      log.warn(`history sync failed for ${player.name}`, err);
    }
  }
  return { players: wanted.size, written };
}

async function syncPlayerHistory(
  playerId: string,
  beatLeaderId: string,
  since: number,
  /** The history is already complete back to `since`, so only what is new needs fetching. */
  complete: boolean,
): Promise<{ written: number; pages: number; finished: boolean; hitPageLimit: boolean }> {
  let written = 0;
  let pages = 0;
  let finished = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    pages = page;
    const { data } = await client.getPlayerScores(beatLeaderId, {
      page,
      count: PAGE_SIZE,
      sortBy: 'date',
      order: 'desc',
    });
    if (data.length === 0) {
      finished = true;
      break;
    }

    let pageWrites = 0;
    let reachedCutoff = false;

    for (const score of data) {
      if (Number(score.timeset ?? 0) < since) {
        reachedCutoff = true;
        break;
      }
      // A modified run (no-fail, slower song and so on) is not evidence of what
      // the player scores in a match.
      if (score.modifiers) continue;

      const info = score.leaderboard;
      if (!info?.song || !info.difficulty) continue;

      const resolved = toResolvedMap(info.song, info.difficulty);
      await prisma.beatMap.upsert({
        where: { id: resolved.map.id },
        create: resolved.map,
        update: {},
      });
      // Never overwrite a leaderboard the pool import already stored: that came
      // from the map endpoint and carries ratings the score feed leaves out.
      await prisma.leaderboard.upsert({
        where: { id: resolved.leaderboard.id },
        create: resolved.leaderboard,
        update: {},
      });

      const result = await upsertScore(playerId, resolved.leaderboard.id, score);
      if (result.written) pageWrites++;
    }

    written += pageWrites;
    if (reachedCutoff || data.length < PAGE_SIZE) {
      finished = true;
      break;
    }
    // A page with nothing new means everything older is already stored - but
    // only once a backfill has been all the way back. Until then, keep walking.
    if (complete && pageWrites === 0) {
      finished = true;
      break;
    }
  }

  // Ran out of pages rather than history: as far as this is ever going to get.
  const hitPageLimit = !finished;
  return { written, pages, finished: true, hitPageLimit };
}

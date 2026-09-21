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
 * Scores are read newest first and paging stops at the scope's age limit, or
 * as soon as a whole page is already stored - so the first run for a player is
 * a few dozen requests and later ones are usually one.
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

export async function syncHistories(): Promise<{ players: number; written: number }> {
  const tournaments = await prisma.tournament.findMany({
    select: {
      statsScope: true,
      divisions: {
        select: {
          teams: {
            select: { members: { select: { player: { select: { id: true, beatLeaderId: true, name: true } } } } },
          },
        },
      },
    },
  });

  // Player -> the oldest score any of their tournaments wants (unix seconds; 0 = everything).
  const wanted = new Map<string, { beatLeaderId: string; name: string; since: number }>();
  const now = Math.floor(Date.now() / 1000);

  for (const tournament of tournaments) {
    const parsed = statsScopeSchema.safeParse(tournament.statsScope ?? {});
    if (!parsed.success || parsed.data.source === 'POOL_ONLY') continue;
    const since = parsed.data.maxAgeDays ? now - parsed.data.maxAgeDays * 86_400 : 0;

    for (const division of tournament.divisions) {
      for (const team of division.teams) {
        for (const { player } of team.members) {
          const existing = wanted.get(player.id);
          wanted.set(player.id, {
            beatLeaderId: player.beatLeaderId,
            name: player.name,
            since: existing ? Math.min(existing.since, since) : since,
          });
        }
      }
    }
  }

  let written = 0;
  for (const [playerId, player] of wanted) {
    try {
      written += await syncPlayerHistory(playerId, player.beatLeaderId, player.since);
    } catch (err) {
      log.warn(`history sync failed for ${player.name}`, err);
    }
  }
  return { players: wanted.size, written };
}

async function syncPlayerHistory(playerId: string, beatLeaderId: string, since: number): Promise<number> {
  let written = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await client.getPlayerScores(beatLeaderId, {
      page,
      count: PAGE_SIZE,
      sortBy: 'date',
      order: 'desc',
    });
    if (data.length === 0) break;

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
    // A page with nothing new means everything older is already stored.
    if (reachedCutoff || pageWrites === 0 || data.length < PAGE_SIZE) break;
  }

  return written;
}

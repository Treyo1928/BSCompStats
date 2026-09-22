import { prisma } from '@bscs/db';
import { looksLikeSteamId, ScoreSaberClient, type SSPlayerScore } from '@bscs/core/scoresaber';
import { log } from './log.js';

/**
 * ScoreSaber, for everyone on a roster.
 *
 *  1. Find the link. A Steam player has the same id on both sites, so theirs is
 *     looked up rather than asked for. Anyone else links it themselves.
 *  2. Keep their ScoreSaber pp and rank current.
 *  3. Keep their scores. The first sync walks every page and records that it
 *     finished; only then do later ones stop at the first page with nothing
 *     new. (The BeatLeader history download stopped early without that record,
 *     and a backfill interrupted once was never resumed.)
 */

const client = new ScoreSaberClient();
const HOUR = 60 * 60 * 1000;
const PROFILE_EVERY = 6 * HOUR;
const LOOKUP_EVERY = 7 * 24 * HOUR;
/** 100 scores a page: 10,000 scores. Nobody here is near it. */
const MAX_PAGES = 100;

export async function syncScoreSaber(): Promise<{ linked: number; synced: number; written: number }> {
  const players = await prisma.player.findMany({
    where: { teamMembers: { some: {} } },
    select: {
      id: true,
      name: true,
      beatLeaderId: true,
      scoreSaberId: true,
      ssSyncedAt: true,
      ssCheckedAt: true,
      ssBackfilledAt: true,
      ssOptOut: true,
    },
  });

  let linked = 0;
  let synced = 0;
  let written = 0;
  const now = Date.now();

  for (const player of players) {
    try {
      let scoreSaberId = player.scoreSaberId;

      if (!scoreSaberId) {
        const due = !player.ssCheckedAt || now - player.ssCheckedAt.getTime() > LOOKUP_EVERY;
        if (player.ssOptOut || !due || !looksLikeSteamId(player.beatLeaderId)) continue;

        const found = await client.getPlayer(player.beatLeaderId);
        // Someone else may already hold this id - a duplicate player row - and the link is unique.
        const taken = found
          ? await prisma.player.findUnique({ where: { scoreSaberId: player.beatLeaderId }, select: { id: true } })
          : null;
        await prisma.player.update({
          where: { id: player.id },
          data: { ssCheckedAt: new Date(), ...(found && !taken ? { scoreSaberId: player.beatLeaderId } : {}) },
        });
        if (!found || taken) continue;
        scoreSaberId = player.beatLeaderId;
        linked++;
        log.info(`scoresaber: linked ${player.name} by their Steam id`);
      }

      const fresh = player.ssSyncedAt && now - player.ssSyncedAt.getTime() < PROFILE_EVERY;
      if (fresh && player.ssBackfilledAt) continue;

      const profile = await client.getPlayer(scoreSaberId);
      if (!profile) continue;

      const result = await syncScores(player.id, scoreSaberId, player.ssBackfilledAt != null);
      written += result.written;
      synced++;

      await prisma.player.update({
        where: { id: player.id },
        data: {
          ssPp: profile.pp ?? 0,
          ssRank: profile.rank ?? 0,
          ssCountryRank: profile.countryRank ?? 0,
          ssRankedPlayCount: profile.scoreStats?.rankedPlayCount ?? 0,
          ssAvgRankedAcc: (profile.scoreStats?.averageRankedAccuracy ?? 0) / 100,
          ssSyncedAt: new Date(),
          ...(result.finished && !player.ssBackfilledAt ? { ssBackfilledAt: new Date() } : {}),
        },
      });
      if (!player.ssBackfilledAt) {
        log.info(`scoresaber: backfilled ${player.name} - ${result.written} scores over ${result.pages} pages`);
      }
      if (result.hitPageLimit) {
        log.warn(`scoresaber: ${player.name} has more than ${MAX_PAGES * 100} scores; anything older was not fetched`);
      }
    } catch (err) {
      log.warn(`scoresaber sync failed for ${player.name}`, err);
    }
  }

  return { linked, synced, written };
}

async function syncScores(
  playerId: string,
  scoreSaberId: string,
  /** Every page has been walked before, so only what is new needs fetching. */
  complete: boolean,
): Promise<{ written: number; pages: number; finished: boolean; hitPageLimit?: boolean }> {
  let written = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { scores } = await client.getScores(scoreSaberId, page);
    if (scores.length === 0) return { written, pages: page, finished: true };

    let pageWrites = 0;
    for (const entry of scores) {
      if (await upsert(playerId, entry)) pageWrites++;
    }
    written += pageWrites;

    if (scores.length < 100) return { written, pages: page, finished: true };
    // Nothing new on a page means the rest is stored - once, and only once, a walk has reached the end.
    if (complete && pageWrites === 0) return { written, pages: page, finished: true };
  }
  // Ran out of pages rather than history. Recorded as complete all the same,
  // as the BeatLeader walk does, or every poll would re-walk ten thousand
  // scores from page one; but said out loud, because from here on anything
  // older is never fetched.
  return { written, pages: MAX_PAGES, finished: true, hitPageLimit: true };
}

/** True when something was stored or changed. */
async function upsert(playerId: string, { score, leaderboard }: SSPlayerScore): Promise<boolean> {
  const key = { playerId_ssLeaderboardId: { playerId, ssLeaderboardId: leaderboard.id } };
  const existing = await prisma.scoreSaberScore.findUnique({ where: key, select: { baseScore: true, pp: true } });
  // pp moves when ScoreSaber reweights a map, without the score changing.
  if (existing && existing.baseScore === score.baseScore && Math.abs(existing.pp - score.pp) < 0.01) return false;

  const data = {
    songHash: leaderboard.songHash.toLowerCase(),
    difficultyValue: leaderboard.difficulty.difficulty,
    gameMode: leaderboard.difficulty.gameMode,
    songName: leaderboard.songName,
    stars: leaderboard.stars ?? 0,
    ranked: leaderboard.ranked === true,
    maxScore: leaderboard.maxScore ?? 0,
    baseScore: score.baseScore,
    accuracy: leaderboard.maxScore > 0 ? score.baseScore / leaderboard.maxScore : 0,
    pp: score.pp ?? 0,
    modifiers: score.modifiers ?? '',
    fullCombo: score.fullCombo === true,
    missedNotes: score.missedNotes ?? 0,
    badCuts: score.badCuts ?? 0,
    timeset: Math.floor(new Date(score.timeSet).getTime() / 1000) || 0,
    fetchedAt: new Date(),
  };
  await prisma.scoreSaberScore.upsert({
    where: key,
    create: { playerId, ssLeaderboardId: leaderboard.id, ...data },
    update: data,
  });
  return true;
}

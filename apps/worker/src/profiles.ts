import { prisma } from '@bscs/db';
import { client } from './sync.js';
import { log } from './log.js';

/**
 * Keep players' BeatLeader name, avatar, rank and skill triangle current.
 *
 * A Player created by signing in knows only an id and a name - BeatLeader's
 * identity endpoint gives nothing else - so without this they have no picture
 * anywhere. Runs for anyone never synced or not synced in the last day.
 *
 * It also fills in an account's picture from its linked profile when the
 * account has none of its own, which is the case for anyone who signed in with
 * BeatLeader rather than Discord.
 */
export async function syncProfiles(): Promise<number> {
  const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const players = await prisma.player.findMany({
    where: {
      OR: [
        { lastSyncedAt: null },
        { lastSyncedAt: { lt: stale } },
        { avatar: null },
        // Ranked, but synced before the skill triangle was kept: fetch it now rather than tomorrow.
        { pp: { gt: 0 }, accPp: 0, techPp: 0, passPp: 0 },
      ],
    },
    select: { id: true, beatLeaderId: true },
    take: 200,
  });

  let updated = 0;
  for (const player of players) {
    try {
      const profile = await client.getPlayer(player.beatLeaderId);
      if (!profile) continue;
      await prisma.player.update({
        where: { id: player.id },
        data: {
          name: profile.name || undefined,
          avatar: profile.avatar || undefined,
          country: profile.country || undefined,
          pp: profile.pp ?? undefined,
          rank: profile.rank ?? undefined,
          countryRank: profile.countryRank ?? undefined,
          accPp: profile.accPp ?? undefined,
          techPp: profile.techPp ?? undefined,
          passPp: profile.passPp ?? undefined,
          rankedPlayCount: profile.scoreStats?.rankedPlayCount ?? undefined,
          lastSyncedAt: new Date(),
        },
      });
      updated++;
    } catch (err) {
      log.warn(`profile sync failed for ${player.beatLeaderId}`, err);
    }
  }

  const faceless = await prisma.user.findMany({
    where: { image: null, players: { some: { avatar: { not: null } } } },
    select: { id: true, players: { where: { avatar: { not: null } }, select: { avatar: true }, take: 1 } },
  });
  for (const user of faceless) {
    await prisma.user.update({ where: { id: user.id }, data: { image: user.players[0]!.avatar } });
  }

  return updated;
}

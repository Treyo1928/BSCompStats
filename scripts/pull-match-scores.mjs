/**
 * Fills a match's results from scores already ingested, for every match that
 * has lineups set.
 *
 *   node scripts/pull-match-scores.mjs
 *
 * The match room has a "Pull scores" button that does the same thing; this is
 * the version you can run without signing in, for development and seeding.
 */
import { prisma } from '@bscs/db';

const matches = await prisma.match.findMany({
  select: {
    id: true,
    name: true,
    maps: {
      orderBy: { order: 'asc' },
      select: {
        id: true,
        order: true,
        isTiebreaker: true,
        poolMap: { select: { leaderboardId: true, leaderboard: { select: { map: { select: { name: true } } } } } },
        lineups: { select: { teamId: true, team: { select: { name: true } }, slots: { select: { playerId: true } } } },
      },
    },
  },
});

for (const match of matches) {
  console.log(`\n${match.name}`);
  for (const matchMap of match.maps) {
    const totals = {};
    for (const lineup of matchMap.lineups) {
      let total = 0;
      for (const slot of lineup.slots) {
        const score = await prisma.score.findUnique({
          where: {
            playerId_leaderboardId: {
              playerId: slot.playerId,
              leaderboardId: matchMap.poolMap.leaderboardId,
            },
          },
        });
        if (!score) continue;

        await prisma.matchMapAttempt.upsert({
          where: { matchMapId_playerId_attempt: { matchMapId: matchMap.id, playerId: slot.playerId, attempt: 1 } },
          create: {
            matchMapId: matchMap.id,
            teamId: lineup.teamId,
            playerId: slot.playerId,
            attempt: 1,
            score: score.baseScore,
            accuracy: score.accuracy,
            source: 'AUTO',
            beatLeaderScoreId: score.beatLeaderScoreId,
            replayUrl: score.replayUrl,
          },
          update: { score: score.baseScore, accuracy: score.accuracy },
        });
        total += score.baseScore;
      }
      totals[lineup.team.name] = total;
    }

    const [a, b] = Object.entries(totals);
    const label = matchMap.isTiebreaker ? 'TB' : `Map ${matchMap.order}`;
    console.log(
      `  ${label.padEnd(6)} ${matchMap.poolMap.leaderboard.map.name.padEnd(22)}` +
        (a && b
          ? `${a[0]} ${a[1].toLocaleString().padStart(9)}  vs  ${b[0]} ${b[1].toLocaleString().padStart(9)}   Δ ${Math.abs(a[1] - b[1]).toLocaleString()}`
          : 'no scores'),
    );
  }
}

await prisma.$disconnect();

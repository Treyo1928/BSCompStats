/**
 * Seeds the real MSU Beat Saber setup.
 *
 * Everything here is transcribed from the two spreadsheets this app replaces:
 * the player BeatLeader IDs from the season sheet's Config tab, the map pool
 * from its MapID column, and the rosters from the scrim sheet.
 *
 * Note the leaderboard IDs carrying runs of `x`. Those are not typos - an `x`
 * marks a re-uploaded map version, and they resolve to different maps with
 * different max scores than the plain ids. `44b4dxxxxxxxxxxx51` has a max of
 * 488,635, matching the sheet's SONGINFO row, while `44b4d51` is 487,715 and
 * would quietly skew every accuracy on that column.
 *
 *   npm run db:seed
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const API = process.env.BEATLEADER_API_URL ?? 'https://api.beatleader.com';

const PLAYERS: Array<{ key: string; name: string; beatLeaderId: string }> = [
  { key: 'cat', name: 'Cat', beatLeaderId: '76561198298341411' },
  { key: 'treyo', name: 'Treyo', beatLeaderId: '76561199059725097' },
  { key: 'mitchell', name: 'Mitchell', beatLeaderId: '3452375511494900' },
  { key: 'will', name: 'Will', beatLeaderId: '76561198866184325' },
  { key: 'corn', name: 'Corn', beatLeaderId: '76561198251130654' },
  { key: 'wynttter', name: 'Wynttter', beatLeaderId: '76561199056552757' },
  { key: 'mia', name: 'Mia', beatLeaderId: '350045' },
  { key: 'kaiden', name: 'Kaiden', beatLeaderId: '76561199477983135' },
  { key: 'kadence', name: 'Kadence', beatLeaderId: '76561199490617703' },
  { key: 'wyatt', name: 'Wyatt', beatLeaderId: '76561199183566307' },
  { key: 'alex', name: 'Alex', beatLeaderId: '356860' },
];

/** leaderboardId -> the organiser's play-style tag, as the sheets recorded it. */
const POOL: Array<{ id: string; category: string }> = [
  { id: '3185d11', category: 'True Acc' },
  { id: '49436x51', category: 'Acc' },
  { id: '4c7cf51', category: 'Acc' },
  { id: '47ace51', category: 'Tech Acc' },
  { id: '3cafbxx91', category: 'Balanced' },
  { id: '44b4dxxxxxxxxxxx51', category: 'Tech' },
  { id: '197ba71', category: 'Speed' },
];

const TEAMS = [
  { name: 'Maroon', color: '#8B1A3A', colorSecondary: '#C97A94', players: ['cat', 'treyo', 'mia', 'will'] },
  { name: 'White', color: '#E8E8E8', colorSecondary: '#FFFFFF', players: ['kaiden', 'kadence', 'wyatt', 'alex'] },
];

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  console.log('Seeding the MSU Beat Saber setup...\n');

  // The owner is a placeholder until a real person signs in and is promoted.
  const owner = await prisma.user.upsert({
    where: { email: 'seed@localhost' },
    create: { email: 'seed@localhost', name: 'Seed Owner', role: 'ADMIN' },
    update: {},
  });

  const tournament = await prisma.tournament.upsert({
    where: { slug: 'msu-fall-2026' },
    create: {
      slug: 'msu-fall-2026',
      name: 'MSU Beat Saber — Fall 2026',
      description: 'Seeded from the season and scrim spreadsheets.',
      ownerId: owner.id,
      isPublic: true,
      members: { create: { userId: owner.id, role: 'OWNER' } },
    },
    update: {},
  });
  console.log(`  tournament: ${tournament.name}`);

  const division = await prisma.division.upsert({
    where: { tournamentId_name: { tournamentId: tournament.id, name: 'Teams' } },
    create: { tournamentId: tournament.id, name: 'Teams', order: 0 },
    update: {},
  });

  // --- players --------------------------------------------------------------
  const playerIds = new Map<string, string>();
  for (const entry of PLAYERS) {
    const profile = await fetchJson<{ id: string; name?: string; avatar?: string; country?: string; pp?: number; rank?: number }>(
      `${API}/player/${encodeURIComponent(entry.beatLeaderId)}`,
    );

    const player = await prisma.player.upsert({
      where: { beatLeaderId: entry.beatLeaderId },
      create: {
        beatLeaderId: entry.beatLeaderId,
        // The league's own name for the player, not their current BeatLeader
        // display name - the spreadsheets and the people both use nicknames,
        // and a roster that suddenly reads "gayalex5" helps nobody.
        name: entry.name,
        avatar: profile?.avatar ?? null,
        country: profile?.country ?? null,
        pp: profile?.pp ?? 0,
        rank: profile?.rank ?? 0,
      },
      update: { name: entry.name, avatar: profile?.avatar ?? null },
    });
    playerIds.set(entry.key, player.id);
    console.log(
      `  player: ${player.name}` +
        (profile?.name && profile.name !== entry.name ? ` (BeatLeader: ${profile.name})` : '') +
        (profile ? '' : ' — BeatLeader lookup failed'),
    );
  }

  // --- teams ----------------------------------------------------------------
  for (const team of TEAMS) {
    const record = await prisma.team.upsert({
      where: { divisionId_name: { divisionId: division.id, name: team.name } },
      create: {
        divisionId: division.id,
        name: team.name,
        color: team.color,
        colorSecondary: team.colorSecondary,
      },
      update: { color: team.color, colorSecondary: team.colorSecondary },
    });

    const roster = team.players
      .map((key) => playerIds.get(key))
      .filter((id): id is string => Boolean(id));

    // Set the roster rather than merging into it - re-running the seed after
    // changing a lineup should not leave the previous player behind, and a
    // stray extra silently breaks the duo rule's appearance maths.
    await prisma.teamMember.deleteMany({
      where: { teamId: record.id, playerId: { notIn: roster } },
    });

    for (const [order, playerId] of roster.entries()) {
      await prisma.teamMember.upsert({
        where: { teamId_playerId: { teamId: record.id, playerId } },
        create: { teamId: record.id, playerId, order },
        update: { order },
      });
    }
    console.log(`  team: ${team.name} (${team.players.length} players)`);
  }

  // --- pool -----------------------------------------------------------------
  const pool = await prisma.mapPool.upsert({
    where: { tournamentId_name: { tournamentId: tournament.id, name: 'Pool 1' } },
    create: {
      tournamentId: tournament.id,
      name: 'Pool 1',
      sourceType: 'seed',
      sourceRef: 'season spreadsheet Config tab',
    },
    update: {},
  });

  let order = 0;
  for (const entry of POOL) {
    const board = await fetchJson<{
      id: string;
      song: { id: string; hash: string; name: string; subName?: string; author?: string; mapper?: string; bpm?: number; duration?: number; coverImage?: string; downloadUrl?: string; uploadTime?: number };
      difficulty: Record<string, unknown>;
    }>(`${API}/leaderboard/${entry.id}?count=1&page=1`);

    if (!board?.song) {
      console.log(`  ! could not resolve leaderboard ${entry.id}`);
      continue;
    }

    const song = board.song;
    const d = board.difficulty as Record<string, number | string | null>;

    await prisma.beatMap.upsert({
      where: { id: song.id },
      create: {
        id: song.id,
        hash: String(song.hash).toLowerCase(),
        name: song.name,
        subName: song.subName ?? null,
        author: song.author ?? null,
        mapper: song.mapper ?? null,
        bpm: song.bpm ?? 0,
        duration: song.duration ?? 0,
        coverImage: song.coverImage ?? null,
        downloadUrl: song.downloadUrl ?? null,
        uploadTime: song.uploadTime ?? 0,
      },
      update: { name: song.name, coverImage: song.coverImage ?? null },
    });

    const n = (key: string): number => {
      const value = d[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };

    await prisma.leaderboard.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        mapId: song.id,
        difficultyValue: n('value'),
        difficultyName: String(d.difficultyName ?? ''),
        mode: n('mode') || 1,
        modeName: String(d.modeName ?? 'Standard'),
        customName: (d.customDifficultyName as string | null) ?? null,
        maxScore: n('maxScore'),
        status: n('status'),
        ranked: n('status') === 3,
        stars: n('stars'),
        accRating: n('accRating'),
        passRating: n('passRating'),
        techRating: n('techRating'),
        predictedAcc: n('predictedAcc'),
        njs: n('njs'),
        nps: n('nps'),
        notes: n('notes'),
        bombs: n('bombs'),
        walls: n('walls'),
        chains: n('chains'),
        sliders: n('sliders'),
        duration: n('duration'),
        peakEBPM: n('peakSustainedEBPM'),
      },
      update: { maxScore: n('maxScore'), stars: n('stars') },
    });

    // Once, not in both branches: both are evaluated when the argument is built.
    const position = order++;
    await prisma.poolMap.upsert({
      where: { poolId_leaderboardId: { poolId: pool.id, leaderboardId: entry.id } },
      create: {
        poolId: pool.id,
        leaderboardId: entry.id,
        order: position,
        category: entry.category,
        // Girls' Night was the decider in the real scrim.
        isTiebreaker: entry.id === '3cafbxx91',
      },
      update: { category: entry.category, order: position },
    });

    console.log(`  map: ${song.name} [${d.difficultyName}] max ${n('maxScore').toLocaleString()} — ${entry.category}`);
  }

  // --- the real WK3 scrim ---------------------------------------------------
  // Reproduced move for move from the match spreadsheet: Maroon won the coin
  // flip, and the pick/ban order left Girls' Night untouched as the decider.
  const teams = await prisma.team.findMany({
    where: { divisionId: division.id },
    select: { id: true, name: true },
  });
  const maroon = teams.find((t) => t.name === 'Maroon');
  const white = teams.find((t) => t.name === 'White');

  if (maroon && white) {
    const existing = await prisma.match.findFirst({
      where: { tournamentId: tournament.id, name: 'MSU BS Fall WK3 Scrim' },
    });

    if (existing) {
      console.log('\n  match already seeded, leaving it alone');
    } else {
      const match = await prisma.match.create({
        data: {
          tournamentId: tournament.id,
          poolId: pool.id,
          teamAId: maroon.id,
          teamBId: white.id,
          coinFlipWinnerId: maroon.id,
          name: 'MSU BS Fall WK3 Scrim',
          state: 'PLAYING',
          startedAt: new Date(),
        },
      });

      const poolMaps = await prisma.poolMap.findMany({
        where: { poolId: pool.id },
        select: { id: true, leaderboardId: true },
      });
      const byLeaderboard = new Map(poolMaps.map((pm) => [pm.leaderboardId, pm.id]));

      // Maroon pick, White pick, White ban, Maroon ban, White pick, Maroon pick.
      const sequence: Array<[string, 'PICK' | 'BAN', string]> = [
        [maroon.id, 'PICK', '3185d11'],            // Madeleine
        [white.id, 'PICK', '49436x51'],            // CASINO RAVE
        [white.id, 'BAN', '197ba71'],              // Spin Eternally
        [maroon.id, 'BAN', '47ace51'],             // Electric Love
        [white.id, 'PICK', '4c7cf51'],             // Sentiment
        [maroon.id, 'PICK', '44b4dxxxxxxxxxxx51'], // Konpeito Extremists
      ];

      for (const [seq, [teamId, type, leaderboardId]] of sequence.entries()) {
        const poolMapId = byLeaderboard.get(leaderboardId);
        if (!poolMapId) continue;
        await prisma.matchAction.create({
          data: { matchId: match.id, seq, type, teamId, poolMapId },
        });
      }

      // Girls' Night is what is left, so it becomes the tiebreaker.
      const playOrder = ['3185d11', '49436x51', '4c7cf51', '44b4dxxxxxxxxxxx51', '3cafbxx91'];
      const pickedBy: Record<string, string | null> = {
        '3185d11': maroon.id,
        '49436x51': white.id,
        '4c7cf51': white.id,
        '44b4dxxxxxxxxxxx51': maroon.id,
        '3cafbxx91': null,
      };

      const matchMapIds = new Map<string, string>();
      for (const [index, leaderboardId] of playOrder.entries()) {
        const poolMapId = byLeaderboard.get(leaderboardId);
        if (!poolMapId) continue;
        const matchMap = await prisma.matchMap.create({
          data: {
            matchId: match.id,
            order: index + 1,
            poolMapId,
            isTiebreaker: leaderboardId === '3cafbxx91',
            pickedById: pickedBy[leaderboardId] ?? null,
          },
        });
        matchMapIds.set(leaderboardId, matchMap.id);
      }

      // Maroon's duos, in the pattern the sheet records: every pair used once,
      // and the tiebreaker reusing two players who are already at their cap.
      const lineups: Record<string, Record<string, string[]>> = {
        '3185d11': { maroon: ['cat', 'will'], white: ['kaiden', 'kadence'] },
        '49436x51': { maroon: ['cat', 'treyo'], white: ['kadence', 'alex'] },
        '4c7cf51': { maroon: ['will', 'mia'], white: ['kaiden', 'alex'] },
        // White repeats Kaiden+Kadence here, exactly as the real scrim did -
        // they only fielded three players, so no legal set of four distinct
        // duos existed. The lineup validator flags it, which is the point.
        '44b4dxxxxxxxxxxx51': { maroon: ['treyo', 'mia'], white: ['kaiden', 'kadence'] },
        '3cafbxx91': { maroon: ['cat', 'mia'], white: ['kaiden', 'kadence'] },
      };

      for (const [leaderboardId, sides] of Object.entries(lineups)) {
        const matchMapId = matchMapIds.get(leaderboardId);
        if (!matchMapId) continue;

        for (const [side, keys] of Object.entries(sides)) {
          const teamId = side === 'maroon' ? maroon.id : white.id;
          const lineup = await prisma.lineup.create({ data: { matchMapId, teamId } });

          for (const [slot, key] of keys.entries()) {
            const playerId = playerIds.get(key);
            if (!playerId) continue;
            await prisma.lineupSlot.create({ data: { lineupId: lineup.id, playerId, slot } });
          }
        }
      }

      console.log(`\n  match: ${match.name} (pick/ban replayed, lineups set)`);
      console.log('  press "Pull scores" in the match room to fill in results');
    }
  }

  console.log(`\nDone. Open /t/${tournament.slug}`);
  console.log('Scores fill in once the worker runs, or press "Refresh scores".');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

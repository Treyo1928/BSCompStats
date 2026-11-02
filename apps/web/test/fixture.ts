/**
 * The test tournament: a realistic MSU-style setup the integration tests (and
 * anyone trying the overlay) can run real matches on, without BeatLeader.
 *
 *   node --experimental-strip-types apps/web/test/fixture.ts <out.json>
 *
 * Needs DATABASE_URL pointing at an EMPTY test database (see scripts/test-integration.sh).
 * Writes the ids and API keys the tests use to <out.json>.
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { generateBracket, hashApiKey, MSU_DUOS_FORMAT } from '@bscs/core';

const prisma = new PrismaClient();

/** Fixed, recognisable keys so a failing test can be replayed by hand with curl. */
export const fixedKey = (name: string) => `bscs_${(name.replace(/[^a-z0-9]/gi, '') + '0'.repeat(40)).slice(0, 40)}`;

const TEAMS = [
  { name: 'Maroon', color: '#7a0019', colorSecondary: '#d9c79f', players: ['Erin', 'Trey', 'Mia', 'Will'] },
  { name: 'White', color: '#e8e8e8', colorSecondary: '#7a0019', players: ['Kaiden', 'Kadence', 'Alex', 'Wyatt'] },
  { name: 'Cowbell', color: '#c9a227', colorSecondary: '#3b2a00', players: ['Cat', 'Jordan', 'Riley', 'Sam'] },
  { name: 'Bulldogs', color: '#2b4c7e', colorSecondary: '#aac4ff', players: ['Noah', 'Ivy', 'Leo', 'Maya'] },
];

// Fake BeatLeader songs: ids and hashes that can never collide with real ones.
const SONGS = [
  'Madeleine', 'CASINO RAVE', 'Sentiment', 'Electric', "Girls' Night", 'Konpeito', 'Spin Eternally',
  'Helianthus', 'Raised by Bats', 'Osmosis', 'Danger', 'MOSHI', 'gigolo', 'Slash Inferno',
  'Always in a Nightmare', 'Preserved Vampire', 'Sakura Zensen', 'Tera I/O', 'Ghost', 'Lunar Abyss', 'Kanade',
];

/** Popular ranked Standard Expert+ maps from BeatLeader, saved as BeatMap + Leaderboard rows. [] if offline. */
async function realLeaderboards(count: number): Promise<string[]> {
  try {
    const r = await fetch(`https://api.beatleader.com/leaderboards?page=1&count=60&type=ranked&sortBy=playcount&order=desc&mode=Standard`);
    if (!r.ok) throw new Error(`BeatLeader ${r.status}`);
    const list = ((await r.json()).data ?? []) as Array<{ id: string; song: any; difficulty: any }>;
    const picked = list.filter((l) => l.difficulty?.value === 9 && l.difficulty?.modeName === 'Standard').slice(0, count);
    const ids: string[] = [];
    for (const l of picked) {
      const song = l.song, d = l.difficulty;
      await prisma.beatMap.upsert({
        where: { id: song.id },
        update: {},
        create: {
          id: song.id, hash: String(song.hash).toLowerCase(), name: song.name, subName: song.subName || null,
          author: song.author || null, mapper: song.mapper || null, bpm: song.bpm ?? 0, duration: Math.round(song.duration ?? 0),
          coverImage: song.coverImage || null, downloadUrl: song.downloadUrl || null,
        },
      });
      await prisma.leaderboard.create({
        data: {
          id: l.id, mapId: song.id, difficultyValue: d.value, difficultyName: d.difficultyName, mode: d.mode, modeName: d.modeName,
          maxScore: d.maxScore ?? 0, status: d.status ?? 0, ranked: true, stars: d.stars ?? 0, accRating: d.accRating ?? 0,
          passRating: d.passRating ?? 0, techRating: d.techRating ?? 0, predictedAcc: d.predictedAcc ?? 0,
          njs: d.njs ?? 0, nps: d.nps ?? 0, notes: d.notes ?? 0, bombs: d.bombs ?? 0, walls: d.walls ?? 0, duration: Math.round(d.duration ?? song.duration ?? 0),
        },
      });
      ids.push(l.id);
    }
    if (ids.length < count) throw new Error(`only ${ids.length} maps`);
    console.log(`fixture: ${ids.length} real BeatLeader maps`);
    return ids;
  } catch (e) {
    console.warn(`fixture: real maps unavailable (${(e as Error).message}), using fake ones`);
    return [];
  }
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: fixture.ts <out.json>');
  if ((await prisma.tournament.count()) > 0) throw new Error('The test database is not empty; refusing to seed it.');

  // ---------------------------------------------------------------- people
  const user = (name: string, role: 'ADMIN' | 'USER' = 'USER') =>
    prisma.user.create({ data: { name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@test.invalid`, role } });
  const admin = await user('Site Admin', 'ADMIN');
  const organiser = await user('Org Anizer');
  const captainMaroon = await user('Erin');
  const captainWhite = await user('Kaiden');
  const viewer = await user('Vee Ewer');
  const outsider = await user('Out Sider');

  // ---------------------------------------------------------------- tournament
  const tournament = await prisma.tournament.create({
    data: {
      slug: 'msu-test',
      name: 'MSU Winter Test Cup',
      ownerId: organiser.id,
      isPublic: true,
      defaultFormat: MSU_DUOS_FORMAT,
      members: {
        create: [
          { userId: organiser.id, role: 'ORGANIZER' },
          { userId: viewer.id, role: 'VIEWER' },
        ],
      },
    },
  });
  const privateCup = await prisma.tournament.create({
    data: { slug: 'private-cup', name: 'Private Cup', ownerId: admin.id, isPublic: false },
  });
  const division = await prisma.division.create({ data: { tournamentId: tournament.id, name: 'Main' } });

  const teams: Record<string, { id: string; players: Record<string, string> }> = {};
  let bl = 76561190000000000n;
  for (const t of TEAMS) {
    const team = await prisma.team.create({ data: { divisionId: division.id, name: t.name, color: t.color, colorSecondary: t.colorSecondary } });
    const players: Record<string, string> = {};
    for (const [i, name] of t.players.entries()) {
      bl++;
      const linkedUser = name === 'Erin' ? captainMaroon.id : name === 'Kaiden' ? captainWhite.id : null;
      const p = await prisma.player.create({
        data: { beatLeaderId: String(bl), name, country: 'US', userId: linkedUser, pp: 9000 - i * 500 },
      });
      await prisma.teamMember.create({
        data: { teamId: team.id, playerId: p.id, order: i, role: i === 0 ? 'CAPTAIN' : 'PLAYER' },
      });
      players[name] = p.id;
    }
    teams[t.name] = { id: team.id, players };
  }

  // ---------------------------------------------------------------- maps and pools
  // FIXTURE_MAPS=beatleader (scripts/mock.sh): 21 real ranked maps, so covers show and the mock TA can play real
  // archival replays of them. Otherwise (the tests) fake maps that never touch the network.
  const leaderboards: string[] = process.env.FIXTURE_MAPS === 'beatleader' ? await realLeaderboards(21) : [];
  for (const [i, name] of (leaderboards.length ? [] : SONGS).entries()) {
    const id = `t${String(i + 1).padStart(4, '0')}`;
    await prisma.beatMap.create({
      data: { id, hash: `test${String(i + 1).padStart(36, '0')}`, name, mapper: 'Fixture Mapper', bpm: 150 + i * 7, duration: 150 + i * 9 },
    });
    const lb = await prisma.leaderboard.create({
      data: {
        id: `${id}91`, mapId: id, difficultyValue: 9, difficultyName: 'ExpertPlus', mode: 1, modeName: 'Standard',
        maxScore: 900_000 + i * 37_000, notes: 800 + i * 40, nps: 5 + (i % 5), njs: 18, duration: 150 + i * 9,
      },
    });
    leaderboards.push(lb.id);
  }
  const pool = async (name: string, lbs: string[]) => {
    const p = await prisma.mapPool.create({ data: { tournamentId: tournament.id, name } });
    const cats = ['Tech', 'Acc', 'Speed', 'Balanced', 'Midspeed', 'Extreme', 'Tiebreaker'];
    for (const [i, leaderboardId] of lbs.entries()) {
      await prisma.poolMap.create({ data: { poolId: p.id, leaderboardId, order: i, category: cats[i % cats.length] } });
    }
    return p.id;
  };
  const groupPool = await pool('Group Stage', leaderboards.slice(0, 7));
  const playoffPool = await pool('Playoffs', leaderboards.slice(7, 14));
  const finalsPool = await pool('Finals', leaderboards.slice(14, 21));

  // ---------------------------------------------------------------- bracket: 4 teams, finals on their own pool
  // FIXTURE_BRACKET=double (the mock tournament): double elimination like MSU's real events (winners and losers
  // brackets, grand final). The integration tests use the single-elimination one.
  const format = process.env.FIXTURE_BRACKET === 'double' ? 'DOUBLE_ELIM' : 'SINGLE_ELIM';
  const seeded = ['Maroon', 'White', 'Cowbell', 'Bulldogs'].map((n) => teams[n]!.id);
  const nodes = generateBracket(format, seeded.length);
  const finalNode = (n: (typeof nodes)[number]) =>
    format === 'DOUBLE_ELIM' ? n.section === 'GF' : n.round === Math.max(...nodes.map((x) => x.round));
  const bracket = await prisma.bracket.create({
    data: {
      tournamentId: tournament.id,
      name: 'Playoffs',
      format,
      poolId: playoffPool,
      entries: { create: seeded.map((teamId, i) => ({ teamId, seed: i + 1 })) },
      nodes: {
        create: nodes.map((n) => ({
          key: n.key, section: n.section, round: n.round, position: n.position, sources: { a: n.a, b: n.b },
          // the final (the grand final in double elimination) plays the Finals pool
          poolId: finalNode(n) ? finalsPool : null,
        })),
      },
    },
    include: { nodes: { select: { key: true, section: true, round: true } } },
  });

  // ---------------------------------------------------------------- API keys
  const keys = {
    organiser: fixedKey('organiserwrite'),
    organiserRead: fixedKey('organiserread'),
    organiserOtherTournament: fixedKey('organiserscopedelsewhere'),
    captainMaroon: fixedKey('captainmaroon'),
    captainWhite: fixedKey('captainwhite'),
    viewer: fixedKey('viewer'),
    outsider: fixedKey('outsider'),
    revoked: fixedKey('revoked'),
    expired: fixedKey('expired'),
  };
  const key = (name: string, userId: string, raw: string, extra: object = {}) =>
    prisma.apiKey.create({ data: { name, userId, prefix: raw.slice(0, 11), hash: hashApiKey(raw), tournamentId: tournament.id, ...extra } });
  await key('organiser', organiser.id, keys.organiser);
  await key('organiser read-only', organiser.id, keys.organiserRead, { canWrite: false });
  await key('organiser, other tournament', organiser.id, keys.organiserOtherTournament, { tournamentId: privateCup.id });
  await key('captain Maroon', captainMaroon.id, keys.captainMaroon);
  await key('captain White', captainWhite.id, keys.captainWhite);
  await key('viewer', viewer.id, keys.viewer);
  await key('outsider', outsider.id, keys.outsider, { tournamentId: null });
  await key('revoked', organiser.id, keys.revoked, { revokedAt: new Date() });
  await key('expired', organiser.id, keys.expired, { expiresAt: new Date(Date.now() - 86_400_000) });

  const summary = {
    tournament: { id: tournament.id, slug: tournament.slug },
    privateTournament: { id: privateCup.id, slug: privateCup.slug },
    users: { admin: admin.id, organiser: organiser.id, captainMaroon: captainMaroon.id, captainWhite: captainWhite.id, viewer: viewer.id, outsider: outsider.id },
    teams,
    pools: { group: groupPool, playoffs: playoffPool, finals: finalsPool },
    bracket: { id: bracket.id, nodes: bracket.nodes },
    keys,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`fixture: ${TEAMS.length} teams, 3 pools, bracket ${bracket.nodes.length} slots, ${Object.keys(keys).length} keys -> ${out}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

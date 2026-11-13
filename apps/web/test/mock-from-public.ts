/**
 * The mock tournament, copied from a real one on a public BSCompStats site: its teams and real players (with their
 * BeatLeader ids), its pools (real BeatLeader maps), and its brackets with the same seeds, but no results, so the
 * bracket can be run again as a rehearsal. The players' own replays of the pool maps (the links on the pool board)
 * go into the summary file for the mock TA and the overlay's replay playlist.
 *
 *   MOCK_FROM=https://bs.treyo.dev/t/msu-october-2026-beat-saber-tourney \
 *     node --experimental-strip-types apps/web/test/mock-from-public.ts <out.json>
 *
 * Reads only public pages (what anyone with the link sees). Needs DATABASE_URL pointing at an EMPTY database
 * (scripts/mock.sh sets that up). The summary has the same shape as fixture.ts's, plus `captains`, `players`,
 * `replays` and `playlist`.
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { FINALS_PICK_BAN_SEQUENCE, generateBracket, hashApiKey, MSU_DUOS_LIVE_FORMAT } from '@bscs/core';

const prisma = new PrismaClient();
const fixedKey = (name: string) => `bscs_${(name.replace(/[^a-z0-9]/gi, '') + '0'.repeat(40)).slice(0, 40)}`;

// ---------------------------------------------------------------- reading the public pages
async function page(url: string): Promise<{ html: string; rsc: string }> {
  const r = await fetch(url, { headers: { 'user-agent': 'BSCompStats mock-from-public' } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const html = await r.text();
  // the page's React Server Components payload: the data the page was rendered from
  const parts: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g)) parts.push(JSON.parse(m[1]!));
  return { html, rsc: parts.join('') };
}

/** The JSON value (array or object) that starts at `from` in `text`. */
function jsonAt(text: string, from: number): unknown {
  const open = text[from], close = open === '[' ? ']' : '}';
  let depth = 0, inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(text.slice(from, i + 1));
  }
  throw new Error('unterminated JSON');
}
const title = (html: string) => (/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'");

interface PublicMap { leaderboardId: string; name: string; isTiebreaker: boolean }
interface PublicCell { leaderboardId: string; replayUrl: string | null; acc: number | null; score?: number | null; fullCombo?: boolean; misses?: number }
interface PublicRow { playerName: string; avatar: string | null; beatLeaderId: string; cells: PublicCell[] }
interface PublicTeam { teamName: string; color: string; teamColorSecondary?: string; rows: PublicRow[] }

async function readPublic(base: string) {
  const home = await page(base);
  const name = title(home.html).replace(/\s*·\s*BSCompStats$/, '');
  const links = [...new Set([...home.html.matchAll(/href="(\/t\/[^"/]+\/(pool|bracket)\/[a-z0-9]+)"/g)].map((m) => m[1]!))];
  const origin = new URL(base).origin;

  const pools: { name: string; maps: PublicMap[] }[] = [];
  const teams = new Map<string, PublicTeam>();
  for (const href of links.filter((l) => l.includes('/pool/'))) {
    const p = await page(origin + href);
    const at = p.rsc.indexOf('"maps":[{"poolMapId"');
    const tAt = p.rsc.indexOf('"teams":[{"teamId"', at);
    if (at < 0 || tAt < 0) throw new Error(`${href}: no pool board data (has the site's page changed?)`);
    pools.push({ name: title(p.html).split(' - ')[0]!, maps: jsonAt(p.rsc, at + 7) as PublicMap[] });
    for (const t of jsonAt(p.rsc, tAt + 8) as Array<PublicTeam & { rows: Array<PublicRow & { teamColorSecondary?: string }> }>) {
      const known = teams.get(t.teamName);
      if (!known) teams.set(t.teamName, { ...t, teamColorSecondary: t.rows[0]?.teamColorSecondary });
      else known.rows.push(...t.rows.filter((r) => !known.rows.some((k) => k.beatLeaderId === r.beatLeaderId)));
    }
  }

  const brackets: { name: string; format: 'SINGLE_ELIM' | 'DOUBLE_ELIM' | 'ROUND_ROBIN'; seeds: string[] }[] = [];
  for (const href of links.filter((l) => l.includes('/bracket/'))) {
    const b = await page(origin + href);
    const text = b.html.replace(/<[^>]+>/g, ' ');
    const format = /Double elimination/i.test(text) ? 'DOUBLE_ELIM' : /Round robin/i.test(text) ? 'ROUND_ROBIN' : 'SINGLE_ELIM';
    // each slot draws "<seed> <team colour> <team name>"
    const seedOf = new Map<string, number>();
    for (const m of b.rsc.matchAll(/"children":(\d+)\}\],\["\$","span",null,\{(?:"className":"[^"]*",)?"children":\[\["\$","span",null,\{(?:"className":"[^"]*",)?"style":\{"background":"[^"]+"\}\}\],\["\$","span",null,\{(?:"className":"[^"]*",)?"style":\{"color":"[^"]+"\},"children":"((?:[^"\\]|\\.)*)"/g)) {
      const team = JSON.parse(`"${m[2]}"`) as string;
      if (!seedOf.has(team)) seedOf.set(team, Number(m[1]));
    }
    const seeds = [...seedOf.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
    brackets.push({ name: title(b.html).split(' - ')[0]!, format, seeds: seeds.length ? seeds : [...teams.keys()] });
  }
  return { name, pools, teams: [...teams.values()], brackets };
}

// ---------------------------------------------------------------- BeatLeader maps
async function saveLeaderboard(id: string) {
  const r = await fetch(`https://api.beatleader.com/leaderboard/${encodeURIComponent(id)}?page=1&count=1`);
  if (!r.ok) throw new Error(`BeatLeader leaderboard ${id}: ${r.status}`);
  const { song, difficulty: d } = await r.json();
  await prisma.beatMap.upsert({
    where: { id: song.id },
    update: {},
    create: {
      id: song.id, hash: String(song.hash).toLowerCase(), name: song.name, subName: song.subName || null,
      author: song.author || null, mapper: song.mapper || null, bpm: song.bpm ?? 0, duration: Math.round(song.duration ?? 0),
      coverImage: song.coverImage || null, downloadUrl: song.downloadUrl || null,
    },
  });
  await prisma.leaderboard.upsert({
    where: { id },
    update: {},
    create: {
      id, mapId: song.id, difficultyValue: d.value, difficultyName: d.difficultyName, mode: d.mode, modeName: d.modeName,
      maxScore: d.maxScore ?? 0, status: d.status ?? 0, ranked: (d.status ?? 0) === 3, stars: d.stars ?? 0, accRating: d.accRating ?? 0,
      passRating: d.passRating ?? 0, techRating: d.techRating ?? 0, predictedAcc: d.predictedAcc ?? 0,
      njs: d.njs ?? 0, nps: d.nps ?? 0, notes: d.notes ?? 0, bombs: d.bombs ?? 0, walls: d.walls ?? 0, duration: Math.round(d.duration ?? song.duration ?? 0),
    },
  });
}

/** Popular ranked Standard Expert+ maps that are not in `have`: the extra maps of the rehearsal's finals pool. */
async function extraLeaderboards(count: number, have: Set<string>): Promise<string[]> {
  const r = await fetch('https://api.beatleader.com/leaderboards?page=1&count=60&type=ranked&sortBy=playcount&order=desc&mode=Standard');
  if (!r.ok) throw new Error(`BeatLeader leaderboards: ${r.status}`);
  const list = ((await r.json()).data ?? []) as Array<{ id: string; song: { id: string }; difficulty: { value: number; modeName: string } }>;
  const songs = new Set<string>();
  return list
    .filter((l) => l.difficulty?.value === 9 && l.difficulty?.modeName === 'Standard' && !have.has(l.id))
    .filter((l) => !songs.has(l.song.id) && !!songs.add(l.song.id))
    .slice(0, count)
    .map((l) => l.id);
}

// Map types for the rehearsal's pools (a real pool's are typed in by the organisers on the pool page).
const TYPES = ['True Acc', 'Tech Acc', 'Standard Acc', 'Midspeed', 'Tech', 'Low Tech', 'Speed', 'Speed Tech', 'Extreme', 'Burst', 'Stamina'];

async function main() {
  const out = process.argv[2];
  const base = (process.env.MOCK_FROM ?? '').replace(/\/+$/, '');
  if (!out || !base) throw new Error('usage: MOCK_FROM=https://<site>/t/<slug> mock-from-public.ts <out.json>');
  if ((await prisma.tournament.count()) > 0) throw new Error('The database is not empty; refusing to seed it.');
  const src = await readPublic(base);
  if (!src.teams.length) throw new Error(`${base}: no teams found`);

  const user = (name: string, role: 'ADMIN' | 'USER' = 'USER') =>
    prisma.user.create({ data: { name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@mock.invalid`, role } });
  const admin = await user('Site Admin', 'ADMIN');
  const organiser = await user('Org Anizer');

  const tournament = await prisma.tournament.create({
    data: {
      slug: process.env.MOCK_SLUG || 'msu-test',
      name: `${src.name} (rehearsal)`,
      description: `A copy of ${base} with real players and maps and no results, for running the bracket again.`,
      ownerId: organiser.id,
      isPublic: true,
      // MSU's match day: play each map as it is picked, run through TournamentAssistant
      defaultFormat: MSU_DUOS_LIVE_FORMAT,
      taModeDefault: true,
      members: { create: [{ userId: organiser.id, role: 'ORGANIZER' }] },
    },
  });

  // A TournamentAssistant link for the local test stack (scripts/mock.sh sets these when a test TA server runs).
  if (process.env.MOCK_TA_HOST && process.env.MOCK_TA_TOKEN) {
    await prisma.taLink.create({
      data: {
        tournamentId: tournament.id,
        host: process.env.MOCK_TA_HOST,
        port: Number(process.env.MOCK_TA_PORT || 8676),
        token: process.env.MOCK_TA_TOKEN,
        tokenName: 'Local test organiser',
        tokenUserId: process.env.MOCK_TA_USER_ID || null,
        taTournamentName: process.env.MOCK_TA_TOURNAMENT || tournament.name,
      },
    });
  }
  const division = await prisma.division.create({ data: { tournamentId: tournament.id, name: 'Main' } });

  // ---------------------------------------------------------------- teams and their real players
  const teams: Record<string, { id: string; players: Record<string, string> }> = {};
  const players: Record<string, string> = {};                     // player id -> BeatLeader id
  const captains: { team: string; userId: string; player: string }[] = [];
  const replays: Record<string, Record<string, number>> = {};     // BeatLeader player id -> leaderboard id -> score id
  const playlist: string[] = [];
  // the scores behind those replays, saved once the maps are: the pool board then shows them and their replays open
  const scores: { playerId: string; leaderboardId: string; scoreId: number; acc: number; score: number | null; fullCombo: boolean; misses: number }[] = [];
  for (const t of src.teams) {
    const team = await prisma.team.create({
      data: { divisionId: division.id, name: t.teamName, color: t.color, colorSecondary: t.teamColorSecondary ?? t.color },
    });
    teams[t.teamName] = { id: team.id, players: {} };
    for (const [i, r] of t.rows.entries()) {
      // the first player listed captains the team; each captain gets a sign-in so both sides can be played
      const captain = i === 0 ? await user(`${r.playerName} (captain)`) : null;
      const p = await prisma.player.create({
        data: { beatLeaderId: r.beatLeaderId, name: r.playerName, avatar: r.avatar, userId: captain?.id ?? null },
      });
      await prisma.teamMember.create({ data: { teamId: team.id, playerId: p.id, order: i, role: i === 0 ? 'CAPTAIN' : 'PLAYER' } });
      teams[t.teamName]!.players[r.playerName] = p.id;
      players[p.id] = r.beatLeaderId;
      if (captain) captains.push({ team: t.teamName, userId: captain.id, player: r.playerName });
      for (const c of r.cells) {
        const id = Number(/scoreId(?:BL)?=(\d+)/.exec(c.replayUrl ?? '')?.[1]);   // BeatLeader's viewer, or our own
        if (!id) continue;
        (replays[r.beatLeaderId] ??= {})[c.leaderboardId] = id;
        if (c.acc != null) scores.push({ playerId: p.id, leaderboardId: c.leaderboardId, scoreId: id, acc: c.acc, score: c.score ?? null, fullCombo: !!c.fullCombo, misses: c.misses ?? 0 });
        playlist.push(`https://replay.beatleader.com/?scoreId=${id}`);
      }
    }
  }

  // ---------------------------------------------------------------- pools (real BeatLeader maps)
  const pools: Record<string, string> = {};
  for (const p of src.pools) {
    const pool = await prisma.mapPool.create({ data: { tournamentId: tournament.id, name: p.name } });
    for (const [i, m] of p.maps.entries()) {
      await saveLeaderboard(m.leaderboardId);
      await prisma.poolMap.create({ data: { poolId: pool.id, leaderboardId: m.leaderboardId, order: i, category: TYPES[i % TYPES.length] } });
    }
    pools[p.name] = pool.id;
  }
  const firstPool = Object.values(pools)[0] ?? null;
  for (const sc of scores) {
    const board = await prisma.leaderboard.findUnique({ where: { id: sc.leaderboardId }, select: { maxScore: true } });
    if (!board) continue;
    const baseScore = sc.score ?? Math.round(sc.acc * board.maxScore);
    await prisma.score.upsert({
      where: { playerId_leaderboardId: { playerId: sc.playerId, leaderboardId: sc.leaderboardId } },
      update: {},
      create: {
        playerId: sc.playerId, leaderboardId: sc.leaderboardId, beatLeaderScoreId: sc.scoreId, baseScore, modifiedScore: baseScore,
        accuracy: sc.acc, fullCombo: sc.fullCombo, missedNotes: sc.misses,
      },
    });
  }

  // A second, 11-map pool with its own pick/ban order (6 picks, 4 bans), played from the second round on: the
  // first pool's maps (the players have replays of those) filled up with popular ranked ones.
  let finalsPool: string | null = null;
  try {
    const own = (src.pools[0]?.maps ?? []).map((m) => m.leaderboardId).slice(0, 11);
    const ids = [...own, ...(await extraLeaderboards(11 - own.length, new Set(own)))];
    if (ids.length < 11) throw new Error(`only ${ids.length} maps found`);
    const name = pools['Finals'] ? 'Finals (11 maps)' : 'Finals';
    const pool = await prisma.mapPool.create({ data: { tournamentId: tournament.id, name, pickBanSequence: FINALS_PICK_BAN_SEQUENCE } });
    for (const [i, leaderboardId] of ids.entries()) {
      await saveLeaderboard(leaderboardId);
      await prisma.poolMap.create({ data: { poolId: pool.id, leaderboardId, order: i, category: TYPES[(i + 3) % TYPES.length] } });
    }
    pools[name] = finalsPool = pool.id;
  } catch (e) {
    console.warn(`mock: no 11-map finals pool (${(e as Error).message})`);
  }

  // ---------------------------------------------------------------- brackets: same seeds, no results
  const brackets: { id: string; name: string; format: string; nodes: { key: string; section: string; round: number }[] }[] = [];
  for (const [order, b] of src.brackets.entries()) {
    const seeded = b.seeds.map((n) => teams[n]?.id).filter((x): x is string => !!x);
    const nodes = generateBracket(b.format, seeded.length);
    const made = await prisma.bracket.create({
      data: {
        tournamentId: tournament.id, name: b.name, format: b.format, poolId: firstPool, order,
        entries: { create: seeded.map((teamId, i) => ({ teamId, seed: i + 1 })) },
        nodes: {
          create: nodes.map((n) => ({
            key: n.key, section: n.section, round: n.round, position: n.position, sources: { a: n.a, b: n.b },
            // everything after the first round of each side plays the finals pool
            poolId: finalsPool && (n.section === 'GF' || ((n.section === 'W' || n.section === 'L') && n.round >= 2)) ? finalsPool : null,
          })),
        },
      },
      include: { nodes: { select: { key: true, section: true, round: true } } },
    });
    brackets.push({ id: made.id, name: b.name, format: b.format, nodes: made.nodes });
  }

  // ---------------------------------------------------------------- API keys (same fixed keys as fixture.ts)
  const keys = { organiser: fixedKey('organiserwrite'), organiserRead: fixedKey('organiserread') };
  const key = (name: string, userId: string, raw: string, extra: object = {}) =>
    prisma.apiKey.create({ data: { name, userId, prefix: raw.slice(0, 11), hash: hashApiKey(raw), tournamentId: tournament.id, ...extra } });
  await key('organiser', organiser.id, keys.organiser);
  await key('organiser read-only', organiser.id, keys.organiserRead, { canWrite: false });

  const summary = {
    source: base,
    tournament: { id: tournament.id, slug: tournament.slug, name: tournament.name },
    users: { admin: admin.id, organiser: organiser.id },
    captains, teams, players, pools, finalsPool, keys, replays, playlist,
    bracket: brackets[0] ?? null,
    brackets,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`mock: "${src.name}" copied: ${src.teams.length} teams, ${Object.keys(players).length} players, ` +
    `${src.pools.reduce((n, p) => n + p.maps.length, 0)} maps, ${brackets.map((b) => `${b.name} (${b.format}, ${b.nodes.length} slots)`).join(', ')}, ` +
    `${playlist.length} replays -> ${out}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

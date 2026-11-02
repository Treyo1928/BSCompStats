/**
 * Integration tests: a real app (next dev), a real database seeded with the
 * fixture tournament, and only the public API - exactly what an overlay or a
 * control app does. Run with scripts/test-integration.sh.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

// Not BASE_URL: Vite sets that one itself (to "/").
const BASE = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3110';
const F = JSON.parse(readFileSync(process.env.FIXTURE_FILE ?? 'apps/web/test/.fixture.json', 'utf8'));
const K = F.keys as Record<string, string>;
const prisma = new PrismaClient();

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(key: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}
const act = (key: string, matchId: string, body: Record<string, unknown>) => api(key, 'POST', `/api/v1/matches/${matchId}/actions`, body);
const get = async (key: string, matchId: string) => (await api(key, 'GET', `/api/v1/matches/${matchId}`)).json.match;

const team = (name: string) => F.teams[name] as { id: string; players: Record<string, string> };
const players = (name: string) => Object.values(team(name).players) as string[];

/** Make a pending pick/ban for whichever team is due, choosing the first available map. */
async function takeStep(match: Json, keyFor: (teamId: string) => string) {
  const step = match.pending;
  const res = await act(keyFor(step.teamId), match.id, { action: step.type.toLowerCase(), teamId: step.teamId, poolMapId: step.availableMapIds[0] });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.match;
}

/** Lineups, scores and closing for one planned map: side A wins it. */
async function playMap(key: string, match: Json, order: number, lineupA: string[], lineupB: string[]) {
  const pm = match.plannedMaps.find((p: Json) => p.order === order);
  expect(pm?.matchMapId, `map ${order} should exist`).toBeTruthy();
  for (const [teamId, ids] of [[match.teamA.id, lineupA], [match.teamB.id, lineupB]] as const) {
    const l = await act(key, match.id, { action: 'lineup', matchMapId: pm.matchMapId, teamId, playerIds: ids });
    expect(l.status, JSON.stringify(l.json)).toBe(200);
  }
  const maxScore = pm.map.maxScore ?? 900_000;
  for (const [teamId, ids, score] of [[match.teamA.id, lineupA, 0.98], [match.teamB.id, lineupB, 0.95]] as const) {
    const s = await act(key, match.id, {
      action: 'scores', matchMapId: pm.matchMapId, teamId,
      scores: ids.map((playerId) => ({ playerId, score: Math.floor(maxScore * score) })),
    });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
  }
  const c = await act(key, match.id, { action: 'closeMap', matchMapId: pm.matchMapId });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return c.json.match;
}

beforeAll(async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  expect(health.ok).toBe(true);
});

// ===========================================================================
describe('API keys', () => {
  it('refuses requests without a working key', async () => {
    expect((await api(null, 'GET', '/api/v1/me')).status).toBe(401);
    expect((await api('bscs_' + 'x'.repeat(40), 'GET', '/api/v1/me')).status).toBe(401);
    expect((await api(K.revoked!, 'GET', '/api/v1/me')).status).toBe(401);
    expect((await api(K.expired!, 'GET', '/api/v1/me')).status).toBe(401);
  });

  it('says who a key acts as', async () => {
    const me = await api(K.organiser!, 'GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.json.user.id).toBe(F.users.organiser);
    expect(me.json.key).toMatchObject({ canWrite: true, tournamentId: F.tournament.id });
  });

  it('lists the tournament for a key limited to it, and hides it from a key limited elsewhere', async () => {
    const t = await api(K.organiser!, 'GET', `/api/v1/tournaments/${F.tournament.slug}`);
    expect(t.status).toBe(200);
    expect(t.json.pools).toHaveLength(3);
    expect(t.json.brackets).toHaveLength(1);
    expect((await api(K.organiserOtherTournament!, 'GET', `/api/v1/tournaments/${F.tournament.slug}`)).status).toBe(404);
  });

  it('keeps a read-only key read-only', async () => {
    const res = await api(K.organiserRead!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.group, teamAId: team('Maroon').id, teamBId: team('White').id,
    });
    expect(res.status).toBe(403);
  });

  it('does not let someone with no role in the tournament set up matches', async () => {
    const res = await api(K.outsider!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.group, teamAId: team('Maroon').id, teamBId: team('White').id,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.match.count()).toBe(0);
  });
});

// ===========================================================================
describe('a full match, picks first', () => {
  let match: Json;
  const keyFor = (teamId: string) => (teamId === team('Maroon').id ? K.captainMaroon! : K.captainWhite!);

  it('is set up by an organiser', async () => {
    const res = await api(K.organiser!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.group, teamAId: team('Maroon').id, teamBId: team('White').id, coinFlip: 'A', name: 'Maroon vs White',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    match = res.json.match;
    expect(match.format.playOrder).toBe('PICKS_FIRST');
    expect(match.pending).toMatchObject({ type: 'PICK', teamId: team('Maroon').id, waitingForPoolMapId: null });
  });

  it('refuses a step out of turn, and the wrong kind of step', async () => {
    const wrongTeam = await act(K.captainWhite!, match.id, { action: 'pick', teamId: team('White').id, poolMapId: match.pending.availableMapIds[0] });
    expect(wrongTeam.status).toBe(409);
    const wrongKind = await act(K.captainMaroon!, match.id, { action: 'ban', teamId: team('Maroon').id, poolMapId: match.pending.availableMapIds[0] });
    expect(wrongKind.status).toBe(409);
    const notTheirTeam = await act(K.captainWhite!, match.id, { action: 'pick', teamId: team('Maroon').id, poolMapId: match.pending.availableMapIds[0] });
    expect(notTheirTeam.status).toBeGreaterThanOrEqual(400);
  });

  it('runs the whole pick/ban sequence with each captain acting for their own team', async () => {
    for (let i = 0; i < 6; i++) match = await takeStep(match, keyFor);
    expect(match.pending).toBeNull();
    expect(match.state).toBe('PLAYING');
    expect(match.plannedMaps).toHaveLength(5);
    expect(match.plannedMaps.at(-1).isTiebreaker).toBe(true);
  });

  it('accepts the same duo on every map: pairings are the referee’s call', async () => {
    const [a1, a2] = players('Maroon');
    const [b1, b2] = players('White');
    for (let order = 1; order <= 5; order++) match = await playMap(K.organiser!, match, order, [a1!, a2!], [b1!, b2!]);
    expect(match.plannedMaps.every((p: Json) => p.scoresClosed)).toBe(true);
    expect(match.plannedMaps.every((p: Json) => Object.keys(p.ruleBreaks).length === 0)).toBe(true);
  });

  it('counts the maps for the right side and completes', async () => {
    expect(match.scoreboard.a).toBeGreaterThan(match.scoreboard.b);
    const done = await act(K.organiser!, match.id, { action: 'complete' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.match.state).toBe('COMPLETE');
    expect(done.json.match.winnerId).toBe(team('Maroon').id);
  });
});

// ===========================================================================
describe('play each map as it is picked', () => {
  let match: Json;
  const order: string[] = [];

  it('is chosen for one match, overriding the tournament default', async () => {
    const res = await api(K.organiser!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.group, teamAId: team('Cowbell').id, teamBId: team('Bulldogs').id, coinFlip: 'A', playOrder: 'PLAY_EACH_PICK',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    match = res.json.match;
    expect(match.format.playOrder).toBe('PLAY_EACH_PICK');
  });

  it('holds the next step until the picked map is played, then runs pick, play, pick, play, ban, ban, …', async () => {
    const [a1, a2] = players('Cowbell');
    const [b1, b2] = players('Bulldogs');
    let played = 0;
    while (match.pending) {
      const type = match.pending.type;
      match = await takeStep(match, () => K.organiser!);
      order.push(type.toLowerCase());
      if (type === 'PICK') {
        // the next step exists but is on hold
        if (match.pending) {
          expect(match.pending.waitingForPoolMapId).toBeTruthy();
          const early = await act(K.organiser!, match.id, {
            action: match.pending.type.toLowerCase(), teamId: match.pending.teamId, poolMapId: match.pending.availableMapIds[0],
          });
          expect(early.status).toBe(409);
        }
        played++;
        match = await playMap(K.organiser!, match, played, [a1!, a2!], [b1!, b2!]);
        order.push('play');
        if (match.pending) expect(match.pending.waitingForPoolMapId).toBeNull();
      }
    }
    // the tiebreaker
    match = await playMap(K.organiser!, match, played + 1, [a1!, a2!], [b1!, b2!]);
    order.push('play');
    expect(order.join(', ')).toBe('pick, play, pick, play, ban, ban, pick, play, pick, play, play');
  });
});

// ===========================================================================
describe('blind lineups', () => {
  it('hide one team’s lineup from the other team, even through the API', async () => {
    const res = await api(K.organiser!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.playoffs, teamAId: team('Maroon').id, teamBId: team('White').id, coinFlip: 'A', blindLineups: true,
    });
    let match = res.json.match;
    match = await takeStep(match, () => K.organiser!);
    const map1 = match.plannedMaps[0];
    const [a1, a2] = players('Maroon');
    const set = await act(K.captainMaroon!, match.id, { action: 'lineup', matchMapId: map1.matchMapId, teamId: team('Maroon').id, playerIds: [a1, a2] });
    expect(set.status, JSON.stringify(set.json)).toBe(200);

    const asWhite = await get(K.captainWhite!, match.id);
    expect(asWhite.plannedMaps[0].lineups[team('Maroon').id]).toBeUndefined();
    const asMaroon = await get(K.captainMaroon!, match.id);
    expect(asMaroon.plannedMaps[0].lineups[team('Maroon').id]).toEqual([a1, a2]);
    const asOrganiser = await get(K.organiser!, match.id);
    expect(asOrganiser.plannedMaps[0].lineups[team('Maroon').id]).toEqual([a1, a2]);
  });
});

// ===========================================================================
describe('bracket pools', () => {
  it('starts a first-round match on the bracket’s pool', async () => {
    const first = F.bracket.nodes.find((n: Json) => n.round === 1);
    const res = await api(K.organiser!, 'POST', `/api/v1/brackets/${F.bracket.id}/start`, { key: first.key, coinFlip: 'A' });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.match.pool.id).toBe(F.pools.playoffs);
  });

  it('starts the final on the pool set for that round', async () => {
    const lastRound = Math.max(...F.bracket.nodes.map((n: Json) => n.round));
    const semis = await prisma.bracketNode.findMany({ where: { bracketId: F.bracket.id, round: 1 }, select: { id: true, sources: true } });
    // Decide the semis directly: what matters here is which pool the final gets.
    const entries = await prisma.bracketEntry.findMany({ where: { bracketId: F.bracket.id }, select: { teamId: true, seed: true } });
    const bySeed = new Map(entries.map((e) => [e.seed, e.teamId]));
    for (const node of semis) {
      const seed = (node.sources as Json).a.seed as number;
      await prisma.bracketNode.update({ where: { id: node.id }, data: { winnerId: bySeed.get(seed) } });
    }
    const final = F.bracket.nodes.find((n: Json) => n.round === lastRound);
    const res = await api(K.organiser!, 'POST', `/api/v1/brackets/${F.bracket.id}/start`, { key: final.key, coinFlip: 'A' });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.match.pool.id).toBe(F.pools.finals);
  });
});

// ===========================================================================
describe('live events', () => {
  it('push the whole match on connect and again after every change', async () => {
    const res = await api(K.organiser!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.finals, teamAId: team('Cowbell').id, teamBId: team('Bulldogs').id, coinFlip: 'A',
    });
    const match = res.json.match;
    const controller = new AbortController();
    const stream = await fetch(`${BASE}/api/v1/matches/${match.id}/events`, {
      headers: { authorization: `Bearer ${K.organiserRead}` },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextMatch = async (): Promise<Json> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith('event: match')) return JSON.parse(block.split('\ndata: ')[1]!);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    const first = await nextMatch();
    expect(first.actions).toHaveLength(0);
    await takeStep(match, () => K.organiser!);
    const second = await nextMatch();
    expect(second.actions).toHaveLength(1);
    controller.abort();
  });
});

// ===========================================================================
/** Follow a match's events stream; `next()` resolves with the match from the next `match` event. */
async function followMatch(key: string, matchId: string) {
  const controller = new AbortController();
  const stream = await fetch(`${BASE}/api/v1/matches/${matchId}/events`, {
    headers: { authorization: `Bearer ${key}` },
    signal: controller.signal,
  });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<Json> => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith('event: match')) return JSON.parse(block.split('\ndata: ')[1]!);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return { next, close: () => controller.abort() };
}

describe('TournamentAssistant mode', () => {
  let match: Json;
  let map1: Json;
  const maroon = () => team('Maroon').id;
  const white = () => team('White').id;
  const [a1, a2, a3] = players('Maroon');
  const [b1, b2] = players('White');

  it('is chosen when the match is set up, and shown on it', async () => {
    const res = await api(K.organiser!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.group, teamAId: maroon(), teamBId: white(), coinFlip: 'A', taMode: true, name: 'TA: Maroon vs White',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    match = res.json.match;
    expect(match.taMode).toBe(true);
    const bad = await api(K.organiser!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.group, teamAId: maroon(), teamBId: white(), taMode: 'yes',
    });
    expect(bad.status).toBe(400);
    expect((await api(K.organiser!, 'POST', `/api/v1/brackets/${F.bracket.id}/start`, { key: 'x', taMode: 1 })).status).toBe(400);
  });

  it('gives every player their BeatLeader id, and the TA id where one is set', async () => {
    const player = match.teamA.players[0];
    expect(player.beatLeaderId).toBeTruthy();
    expect(player.taPlatformId).toBeNull();
  });

  it('leaves pick and ban to the organisers, even on a captain’s own turn', async () => {
    const refused = await act(K.captainMaroon!, match.id, { action: 'pick', teamId: maroon(), poolMapId: match.pending.availableMapIds[0] });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/TournamentAssistant/);
    for (let i = 0; i < 6; i++) match = await takeStep(match, () => K.organiser!);
    expect(match.state).toBe('PLAYING');
    expect(match.plannedMaps).toHaveLength(5);
    expect(match.plannedMaps.every((pm: Json) => pm.start === null)).toBe(true);
    map1 = match.plannedMaps.find((pm: Json) => pm.order === 1);
  });

  it('starts a map only once both lineups are set, and only the next one', async () => {
    const early = await act(K.organiser!, match.id, { action: 'startMap', matchMapId: map1.matchMapId });
    expect(early.status).toBe(409);
    // Captains still set their own lineups.
    for (const [key, teamId, ids] of [[K.captainMaroon!, maroon(), [a1, a2]], [K.captainWhite!, white(), [b1, b2]]] as const) {
      const l = await act(key, match.id, { action: 'lineup', matchMapId: map1.matchMapId, teamId, playerIds: ids });
      expect(l.status, JSON.stringify(l.json)).toBe(200);
    }
    const map2 = match.plannedMaps.find((pm: Json) => pm.order === 2);
    expect((await act(K.organiser!, match.id, { action: 'startMap', matchMapId: map2.matchMapId })).status).toBe(409);
    expect((await act(K.captainMaroon!, match.id, { action: 'startMap', matchMapId: map1.matchMapId })).status).toBe(403);
  });

  it('records the start request, tells the events stream, and refuses a second one', async () => {
    const events = await followMatch(K.organiserRead!, match.id);
    expect((await events.next()).plannedMaps[0].start).toBeNull();
    const res = await act(K.organiser!, match.id, { action: 'startMap', matchMapId: map1.matchMapId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const start = res.json.match.plannedMaps.find((pm: Json) => pm.order === 1).start;
    expect(Date.parse(start.requestedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(start.requestedBy.id).toBe(F.users.organiser);
    expect(start.status).toBeNull();
    const pushed = await events.next();
    expect(pushed.plannedMaps.find((pm: Json) => pm.order === 1).start?.requestedAt).toBe(start.requestedAt);
    events.close();
    expect((await act(K.organiser!, match.id, { action: 'startMap', matchMapId: map1.matchMapId })).status).toBe(409);
  });

  it('takes the bridge’s reports, checked, and hands them back', async () => {
    const before = (await get(K.organiser!, match.id)).plannedMaps[0].start;
    const status = {
      phase: 'loading',
      players: [
        { playerId: a1, state: 'ready' }, { playerId: a2, state: 'loading' },
        { playerId: b1, state: 'ready' }, { playerId: b2, state: 'missing' },
      ],
    };
    expect((await act(K.captainMaroon!, match.id, { action: 'taStatus', matchMapId: map1.matchMapId, status })).status).toBe(403);
    expect((await act(K.organiser!, match.id, { action: 'taStatus', matchMapId: map1.matchMapId, status: { phase: 'started' } })).status).toBe(400);
    const stranger = await act(K.organiser!, match.id, {
      action: 'taStatus', matchMapId: map1.matchMapId, status: { phase: 'loading', players: [{ playerId: a3, state: 'ready' }] },
    });
    expect(stranger.status).toBe(400);
    expect((await act(K.organiser!, match.id, {
      action: 'taStatus', matchMapId: map1.matchMapId, status, requestedAt: '2020-01-01T00:00:00Z',
    })).status).toBe(409);

    const ok = await act(K.organiser!, match.id, { action: 'taStatus', matchMapId: map1.matchMapId, status, requestedAt: before.requestedAt });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const seen = (await get(K.captainWhite!, match.id)).plannedMaps[0].start.status;
    expect(seen).toMatchObject(status);
    expect(seen.reportedAt).toBeTruthy();
    const playing = await act(K.organiser!, match.id, {
      action: 'taStatus', matchMapId: map1.matchMapId,
      status: { phase: 'error', message: 'Player b2 never loaded', startedAt: new Date().toISOString() },
    });
    expect(playing.json.match.plannedMaps[0].start.status).toMatchObject({ phase: 'error', message: 'Player b2 never loaded' });
  });

  it('restarts, and drops the request when a lineup changes', async () => {
    const before = (await get(K.organiser!, match.id)).plannedMaps[0].start;
    const again = await act(K.organiser!, match.id, { action: 'restartMap', matchMapId: map1.matchMapId });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    const restarted = again.json.match.plannedMaps[0].start;
    expect(Date.parse(restarted.requestedAt)).toBeGreaterThan(Date.parse(before.requestedAt));
    expect(restarted.status).toBeNull();

    // The same lineup saved again changes nothing; a different one cancels the start.
    await act(K.captainMaroon!, match.id, { action: 'lineup', matchMapId: map1.matchMapId, teamId: maroon(), playerIds: [a1, a2] });
    expect((await get(K.organiser!, match.id)).plannedMaps[0].start).not.toBeNull();
    await act(K.captainMaroon!, match.id, { action: 'lineup', matchMapId: map1.matchMapId, teamId: maroon(), playerIds: [a1, a3] });
    expect((await get(K.organiser!, match.id)).plannedMaps[0].start).toBeNull();
    expect((await act(K.organiser!, match.id, { action: 'restartMap', matchMapId: map1.matchMapId })).status).toBe(409);
  });

  it('cancels a start', async () => {
    expect((await act(K.organiser!, match.id, { action: 'startMap', matchMapId: map1.matchMapId })).status).toBe(200);
    const cancelled = await act(K.organiser!, match.id, { action: 'cancelStart', matchMapId: map1.matchMapId });
    expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200);
    expect(cancelled.json.match.plannedMaps[0].start).toBeNull();
    expect((await act(K.organiser!, match.id, { action: 'cancelStart', matchMapId: map1.matchMapId })).status).toBe(200);
    expect((await act(K.organiser!, match.id, { action: 'taStatus', matchMapId: map1.matchMapId, status: { phase: 'waiting' } })).status).toBe(409);
  });

  it('takes its scores from TA, not BeatLeader', async () => {
    expect((await act(K.organiser!, match.id, { action: 'startMap', matchMapId: map1.matchMapId })).status).toBe(200);
    const pull = await act(K.organiser!, match.id, { action: 'pullScores', matchMapId: map1.matchMapId });
    expect(pull.status).toBe(409);
    expect(pull.json.error).toMatch(/TournamentAssistant/);

    const maxScore = map1.map.maxScore || 900_000;
    const entry = (playerId: string, acc: number, misses: number) => ({ playerId, score: Math.floor(maxScore * acc), accuracy: acc, misses });
    expect((await act(K.captainMaroon!, match.id, {
      action: 'scores', source: 'TA', matchMapId: map1.matchMapId, teamId: maroon(), scores: [entry(a1!, 0.97, 1), entry(a3!, 0.95, 4)],
    })).status).toBe(403);
    expect((await act(K.organiser!, match.id, {
      action: 'scores', source: 'TA', matchMapId: map1.matchMapId, teamId: maroon(), scores: [{ ...entry(a1!, 0.97, 1), accuracy: 97 }],
    })).status).toBe(400);
    for (const [teamId, list] of [[maroon(), [entry(a1!, 0.97, 1), entry(a3!, 0.95, 4)]], [white(), [entry(b1!, 0.96, 2), entry(b2!, 0.94, 0)]]] as const) {
      const s = await act(K.organiser!, match.id, { action: 'scores', source: 'TA', matchMapId: map1.matchMapId, teamId, scores: list });
      expect(s.status, JSON.stringify(s.json)).toBe(200);
    }
    const shown = (await get(K.organiser!, match.id)).plannedMaps[0];
    const mine = shown.scores[maroon()].find((x: Json) => x.playerId === a1);
    expect(mine).toMatchObject({ source: 'TA', accuracy: 0.97, misses: 1 });
    expect(shown.result.winnerId).toBe(maroon());
    expect(await prisma.matchMapAttempt.count({ where: { matchMapId: map1.matchMapId, source: 'TA' } })).toBe(4);

    // Typed by an organiser, it is the manual fallback.
    const typed = await act(K.organiser!, match.id, {
      action: 'scores', matchMapId: map1.matchMapId, teamId: white(), scores: [entry(b1!, 0.96, 2), entry(b2!, 0.93, 3)],
    });
    expect(typed.status).toBe(200);
    expect(typed.json.match.plannedMaps[0].scores[white()].every((x: Json) => x.source === 'MANUAL')).toBe(true);

    const closed = await act(K.organiser!, match.id, { action: 'closeMap', matchMapId: map1.matchMapId });
    expect(closed.json.match.plannedMaps[0].scoresClosed).toBe(true);
    // The record of the start stays with the played map.
    expect(closed.json.match.plannedMaps[0].start).not.toBeNull();
  });

  it('is refused on a match not run through TA', async () => {
    const res = await api(K.organiser!, 'POST', `/api/v1/tournaments/${F.tournament.slug}/matches`, {
      poolId: F.pools.group, teamAId: team('Cowbell').id, teamBId: team('Bulldogs').id, coinFlip: 'A', taMode: false,
    });
    let plain = res.json.match;
    expect(plain.taMode).toBe(false);
    plain = await takeStep(plain, () => K.organiser!);
    const pm = plain.plannedMaps[0];
    expect((await act(K.organiser!, plain.id, { action: 'startMap', matchMapId: pm.matchMapId })).status).toBe(409);
    const [c1] = players('Cowbell');
    expect((await act(K.organiser!, plain.id, {
      action: 'scores', source: 'TA', matchMapId: pm.matchMapId, teamId: team('Cowbell').id, scores: [{ playerId: c1, score: 1 }],
    })).status).toBe(409);
  });
});

import { cache } from 'react';
import { prisma } from '@bscs/db';
import { nextDraftSlot, parseDraftSettings } from '@bscs/core/match';
import { classifyFails } from '@bscs/core/stats';
import { tallyMaps } from './match-summary';
import { buildTournamentStats, OVERALL } from './player-stats';
import { loadScores } from './score-sources';

/**
 * What a page says about itself in a link preview.
 *
 * Previews are fetched by crawlers - Discord's, Slack's - with no session, and
 * then shown to whoever is in the channel. So everything here describes public
 * tournaments only: for a private one these return null and the page falls back
 * to the site's generic card, exactly as if the link led nowhere.
 *
 * Wrapped in `cache` because a page's metadata and its image are built in the
 * same request and ask for the same thing.
 */

const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const getTournamentSummary = cache(async (slug: string) => {
  const t = await prisma.tournament.findUnique({
    where: { slug },
    select: {
      name: true,
      description: true,
      isPublic: true,
      pools: { select: { name: true, _count: { select: { maps: true } } } },
      divisions: {
        select: {
          teams: {
            where: { adHoc: false },
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              color: true,
              members: { orderBy: { order: 'asc' }, select: { role: true, player: { select: { id: true, name: true } } } },
            },
          },
        },
      },
      matches: {
        orderBy: { createdAt: 'desc' },
        select: {
          state: true,
          winnerId: true,
          teamAId: true,
          teamBId: true,
          teamA: { select: { name: true } },
          teamB: { select: { name: true } },
          maps: {
            select: { isTiebreaker: true, attempts: { select: { teamId: true, playerId: true, score: true } } },
          },
        },
      },
    },
  });
  if (!t || !t.isPublic) return null;

  const teams = t.divisions.flatMap((d) => d.teams);
  const players = new Set(teams.flatMap((team) => team.members.map((m) => m.player.id))).size;
  const live = t.matches.filter((m) => m.state !== 'COMPLETE');
  const finished = t.matches.filter((m) => m.state === 'COMPLETE');

  const results = finished.slice(0, 3).map((m) => {
    const tally = tallyMaps(m.maps, m.teamAId, m.teamBId);
    const aWon = m.winnerId === m.teamAId;
    const bWon = m.winnerId === m.teamBId;
    if (!aWon && !bWon) return `${m.teamA.name} ${tally.a}-${tally.b} ${m.teamB.name}`;
    const [winner, loser] = aWon ? [m.teamA.name, m.teamB.name] : [m.teamB.name, m.teamA.name];
    return `${winner} beat ${loser} ${Math.max(tally.a, tally.b)}-${Math.min(tally.a, tally.b)}`;
  });

  return {
    name: t.name,
    description: t.description,
    teams,
    players,
    pools: t.pools,
    liveCount: live.length,
    finishedCount: finished.length,
    results,
    facts: [
      plural(teams.length, 'team'),
      plural(players, 'player'),
      plural(t.pools.length, 'map pool'),
      plural(t.matches.length, 'match') + (live.length ? ` (${live.length} under way)` : ''),
    ].join(' · '),
  };
});

export const getPoolSummary = cache(async (slug: string, poolId: string) => {
  const pool = await prisma.mapPool.findUnique({
    where: { id: poolId },
    select: {
      name: true,
      tournamentId: true,
      tournament: { select: { slug: true, name: true, isPublic: true } },
      maps: {
        orderBy: { order: 'asc' },
        select: {
          leaderboardId: true,
          leaderboard: { select: { map: { select: { name: true, coverImage: true } } } },
        },
      },
    },
  });
  if (!pool || pool.tournament.slug !== slug || !pool.tournament.isPublic) return null;

  const members = await prisma.teamMember.findMany({
    where: { team: { division: { tournamentId: pool.tournamentId } } },
    // Match-only sides first, so the team a player is entered with is the one kept.
    orderBy: { team: { adHoc: 'desc' } },
    select: { player: { select: { id: true, name: true } }, team: { select: { name: true, color: true } } },
  });
  const teamOf = new Map(members.map((m) => [m.player.id, m.team]));
  const nameOf = new Map(members.map((m) => [m.player.id, m.player.name]));

  // Through score-sources like the board, so a ScoreSaber-only leader is a
  // leader here too; and with abandoned runs set aside the way the board does.
  const scores = await loadScores([...nameOf.keys()], {
    source: 'both',
    leaderboardIds: pool.maps.map((m) => m.leaderboardId),
  });
  const fails = classifyFails(scores.map((s) => ({ playerId: s.playerId, leaderboardId: s.leaderboardId, acc: s.accuracy })));

  const byPlayer = new Map<string, number[]>();
  scores.forEach((s, i) => {
    if (fails[i]) return;
    byPlayer.set(s.playerId, [...(byPlayer.get(s.playerId) ?? []), s.accuracy]);
  });

  // Only people who have played most of the pool: one 99% on the easy map is
  // not the top of a leaderboard.
  const needed = Math.max(1, Math.ceil(pool.maps.length / 2));
  const leaders = [...byPlayer]
    .filter(([, accs]) => accs.length >= needed)
    .map(([playerId, accs]) => ({
      name: nameOf.get(playerId) ?? 'Player',
      team: teamOf.get(playerId)?.name ?? null,
      color: teamOf.get(playerId)?.color ?? '#8b7bff',
      average: accs.reduce((a, b) => a + b, 0) / accs.length,
      played: accs.length,
    }))
    .sort((a, b) => b.average - a.average)
    .slice(0, 5);

  return {
    name: pool.name,
    tournamentName: pool.tournament.name,
    maps: pool.maps.map((m) => ({ name: m.leaderboard.map.name, cover: m.leaderboard.map.coverImage })),
    playerCount: nameOf.size,
    scoreCount: scores.length,
    leaders,
    teamColors: [...new Set(members.map((m) => m.team.color))],
    facts: [
      plural(pool.maps.length, 'map'),
      plural(nameOf.size, 'player'),
      plural(scores.length, 'score'),
    ].join(' · '),
    leadersLine: leaders.length
      ? `Top averages: ${leaders.slice(0, 3).map((l) => `${l.name} ${pct(l.average)}`).join(', ')}`
      : 'No scores yet',
  };
});

export const getMatchSummary = cache(async (slug: string, matchId: string) => {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      name: true,
      state: true,
      winnerId: true,
      teamAId: true,
      teamBId: true,
      tournament: { select: { slug: true, name: true, isPublic: true } },
      pool: { select: { name: true } },
      teamA: { select: { name: true, color: true, members: { where: { available: true }, orderBy: { order: 'asc' }, select: { player: { select: { name: true } } } } } },
      teamB: { select: { name: true, color: true, members: { where: { available: true }, orderBy: { order: 'asc' }, select: { player: { select: { name: true } } } } } },
      maps: {
        orderBy: { order: 'asc' },
        select: {
          isTiebreaker: true,
          poolMap: { select: { leaderboard: { select: { map: { select: { name: true, coverImage: true } } } } } },
          attempts: { select: { teamId: true, playerId: true, score: true } },
        },
      },
    },
  });
  if (!m || m.tournament.slug !== slug || !m.tournament.isPublic) return null;

  const tally = tallyMaps(m.maps, m.teamAId, m.teamBId);
  const winner = m.winnerId === m.teamAId ? m.teamA : m.winnerId === m.teamBId ? m.teamB : null;

  const status =
    m.state === 'COMPLETE'
      ? winner
        ? `${winner.name} won ${Math.max(tally.a, tally.b)}-${Math.min(tally.a, tally.b)}`
        : `Drawn ${tally.a}-${tally.b}`
      : m.state === 'PLAYING'
        ? tally.a + tally.b > 0
          ? `In play, ${m.teamA.name} ${tally.a}-${tally.b} ${m.teamB.name}`
          : 'Maps picked, about to play'
        : 'Picking and banning maps';

  return {
    name: m.name,
    tournamentName: m.tournament.name,
    poolName: m.pool.name,
    state: m.state,
    status,
    tally,
    winnerName: winner?.name ?? null,
    teamA: { name: m.teamA.name, color: m.teamA.color, players: m.teamA.members.map((x) => x.player.name) },
    teamB: { name: m.teamB.name, color: m.teamB.color, players: m.teamB.members.map((x) => x.player.name) },
    maps: m.maps.map((x) => ({
      name: x.poolMap.leaderboard.map.name,
      cover: x.poolMap.leaderboard.map.coverImage,
      isTiebreaker: x.isTiebreaker,
    })),
  };
});

const points = (gap: number) => `${gap >= 0 ? '+' : '−'}${Math.abs(gap * 100).toFixed(1)}`;

/** The stats page: each team in ranked order, as the page itself shows it. */
export const getStatsSummary = cache(async (slug: string) => {
  const t = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, name: true, isPublic: true },
  });
  if (!t || !t.isPublic) return null;

  const stats = await buildTournamentStats(t.id);
  // The card is about the tournament's own teams; a side made up for one match is a footnote to it.
  const teams = stats.teams
    .filter((team) => !team.adHoc)
    .map((team) => ({
      name: team.name,
      color: team.color,
      players: [...team.players]
        .sort((a, b) => (a.standings[OVERALL]?.teamRank ?? Infinity) - (b.standings[OVERALL]?.teamRank ?? Infinity))
        .map((p) => ({
          name: p.name,
          rank: p.standings[OVERALL]?.teamRank ?? null,
          gap: p.standings[OVERALL]?.vsTeam.gap ?? null,
          style: p.profile && p.specialty.status === 'RANGE' ? p.specialty.label : null,
        })),
    }));

  return {
    tournamentName: t.name,
    teams,
    fieldSize: stats.fieldSize,
    mapCount: stats.mapCount,
    description:
      teams.length === 0
        ? 'No teams yet.'
        : `Ranked within each team, on the maps both players have actually played. ${teams
            .map((team) => `${team.name}: ${team.players.map((p) => p.name).join(', ') || 'no players yet'}`)
            .join(' | ')}`,
  };
});

/** One player: who they play for, where they rank, and how they play. */
export const getPlayerStatsSummary = cache(async (slug: string, playerId: string) => {
  const t = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, name: true, isPublic: true },
  });
  if (!t || !t.isPublic) return null;

  const stats = await buildTournamentStats(t.id);
  const spot = stats.teams
    .flatMap((team) => team.players.filter((p) => p.playerId === playerId).map((player) => ({ team, player })))
    // Entered teams are listed first, so that is the side the headline figures are against.
    .at(0);
  if (!spot) return null;

  const { team, player } = spot;
  const overall = player.standings[OVERALL]!;
  // The kinds they can actually be ranked on, best first - what is worth a line in a preview.
  const ranks = player.kinds
    .filter((k) => k.teamRank != null)
    .sort((a, b) => a.teamRank! - b.teamRank!)
    .map((k) => ({ label: k.kind, rank: k.teamRank, of: k.teamRanked }));

  const facts = [
    overall.teamRank ? `#${overall.teamRank} of ${overall.teamRanked} on ${team.name}` : null,
    overall.fieldRank ? `#${overall.fieldRank} of ${overall.fieldRanked} in the field` : null,
    player.profile && player.profile.meanAcc > 0
      ? `${pct(player.profile.meanAcc, 2)} average on ${player.played} of ${stats.mapCount} pool maps`
      : null,
  ].filter(Boolean);

  return {
    tournamentName: t.name,
    name: player.name,
    avatar: player.avatar,
    team: { name: team.name, color: team.color },
    style: player.profile ? { label: player.specialty.label, summary: player.specialty.summary } : null,
    meanAcc: player.profile && player.profile.meanAcc > 0 ? player.profile.meanAcc : null,
    played: player.played,
    mapCount: stats.mapCount,
    overall,
    ranks,
    description: [
      player.profile ? `${player.specialty.label}.` : null,
      facts.join(' · '),
      overall.vsTeam.gap != null ? `${points(overall.vsTeam.gap)} points vs teammates on the maps both have played.` : null,
    ]
      .filter(Boolean)
      .join(' '),
  };
});

/** A captains' draft: the two sides as they stand, and whose pick it is. */
export const getDraftSummary = cache(async (slug: string, draftId: string) => {
  const team = {
    name: true,
    color: true,
    members: { orderBy: { order: 'asc' }, select: { role: true, player: { select: { name: true } } } },
  } as const;
  const d = await prisma.draft.findUnique({
    where: { id: draftId },
    select: {
      name: true,
      order: true,
      firstPick: true,
      shareOdd: true,
      matchId: true,
      tournament: { select: { slug: true, name: true, isPublic: true } },
      teamA: { select: team },
      teamB: { select: team },
      players: { select: { pickNumber: true, player: { select: { name: true } } } },
    },
  });
  if (!d || d.tournament.slug !== slug || !d.tournament.isPublic) return null;

  const made = d.players.filter((p) => p.pickNumber != null).length;
  const slot = d.matchId ? null : nextDraftSlot(parseDraftSettings(d), d.players.length, made);
  const onTheClock = slot === 'A' ? d.teamA : slot === 'B' ? d.teamB : null;
  const captain = (side: typeof d.teamA) => side.members.find((m) => m.role === 'CAPTAIN')?.player.name ?? side.name;
  const available = d.players.filter((p) => p.pickNumber == null).map((p) => p.player.name);

  const status = d.matchId
    ? 'Draft complete - the match is under way'
    : onTheClock
      ? `Pick ${made + 1} of ${d.players.length}: ${captain(onTheClock)} to choose`
      : 'Draft complete';

  const side = (s: typeof d.teamA) => ({ name: s.name, color: s.color, players: s.members.map((m) => m.player.name) });
  return {
    name: d.name,
    tournamentName: d.tournament.name,
    status,
    complete: !onTheClock,
    onTheClockColor: onTheClock?.color ?? null,
    teamA: side(d.teamA),
    teamB: side(d.teamB),
    available,
    description: [
      status,
      `${d.teamA.name}: ${d.teamA.members.map((m) => m.player.name).join(', ')}`,
      `${d.teamB.name}: ${d.teamB.members.map((m) => m.player.name).join(', ')}`,
      available.length ? `Still available: ${available.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('. '),
  };
});

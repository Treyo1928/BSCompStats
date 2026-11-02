import { prisma } from '@bscs/db';
import { can, isCaptainOf, isStaff, type Actor } from '@bscs/core/match';
import { loadMatch, type MapStart, type MatchView } from './matches';
import { ApiError } from './api';

/**
 * A match as the API serves it: the same view the match page renders, with
 * the same things hidden. Blind lineups stay hidden from whoever the page would
 * hide them from, so an overlay key can never show a captain's choice early.
 */
export async function matchForApi(matchId: string, actor: Actor): Promise<MatchView> {
  const match = await loadMatch(matchId);
  if (!match || !can(actor, 'VIEW', { isPublic: match.tournament.isPublic })) throw new ApiError(404, 'Not found.');

  const sides = [match.teamA.id, match.teamB.id];
  const rosterSpots = actor.userId
    ? await prisma.teamMember.findMany({
        where: { teamId: { in: sides }, player: { userId: actor.userId } },
        select: { teamId: true },
      })
    : [];
  const mySides = new Set([...rosterSpots.map((s) => s.teamId), ...sides.filter((id) => isCaptainOf(actor, id))]);
  const everyLineupSet =
    !match.pending &&
    match.plannedMaps.length > 0 &&
    match.plannedMaps.every((pm) => sides.every((id) => (pm.lineups[id] ?? []).length >= match.format.playersPerMap));
  const revealed = !match.blindLineups || everyLineupSet || match.state === 'COMPLETE';
  const canSee = (teamId: string) => revealed || (mySides.size > 0 ? mySides.has(teamId) : isStaff(actor));

  const hidden = sides.filter((id) => !canSee(id));
  if (!hidden.length) return match;
  const strip = <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([teamId]) => !hidden.includes(teamId))) as Record<string, T>;
  return {
    ...match,
    plannedMaps: match.plannedMaps.map((pm) => ({
      ...pm,
      // TA's report names who is playing; it must not give a hidden lineup away either.
      start: pm.start && hideTaPlayers(pm.start, pm.lineups, hidden),
      lineups: strip(pm.lineups),
      scores: strip(pm.scores),
      goes: strip(pm.goes),
      runs: strip(pm.runs),
      ruleBreaks: strip(pm.ruleBreaks),
    })),
  };
}

/** Which tournament a match belongs to, for scoped keys (404 for unknown matches). */
export async function tournamentOfMatch(matchId: string): Promise<{ id: string; slug: string; unlisted: boolean }> {
  const m = await prisma.match.findUnique({ where: { id: matchId }, select: { tournamentId: true, unlisted: true, tournament: { select: { slug: true } } } });
  if (!m) throw new ApiError(404, 'Not found.');
  return { id: m.tournamentId, slug: m.tournament.slug, unlisted: m.unlisted };
}

/** A start's TA report without the players only a hidden lineup names. */
export function hideTaPlayers(start: MapStart, lineups: Record<string, string[]>, hidden: readonly string[]): MapStart {
  if (!start.status?.players || !hidden.length) return start;
  const shown = new Set(Object.entries(lineups).filter(([teamId]) => !hidden.includes(teamId)).flatMap(([, ids]) => ids));
  const secret = new Set(hidden.flatMap((teamId) => lineups[teamId] ?? []).filter((id) => !shown.has(id)));
  return { ...start, status: { ...start.status, players: start.status.players.filter((p) => !secret.has(p.playerId)) } };
}

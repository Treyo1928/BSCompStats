import { prisma } from '@bscs/db';
import { can, isStaff } from '@bscs/core/match';
import { ApiError, apiRoute, json } from '@/server/api';
import { getActorOrAnonymous } from '@/server/session';
import { shownAs, tournamentAliases } from '@/server/aliases';

export const dynamic = 'force-dynamic';

/**
 * A tournament's matches and brackets, so an overlay or control app can choose which match to follow, and its teams
 * as they are shown on stream: logo, players under their tournament names, and the replays they chose to show.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return apiRoute(request, {}, async ({ inTournament }) => {
    const t = await prisma.tournament.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, isPublic: true } });
    if (!t) throw new ApiError(404, 'Not found.');
    inTournament(t.id);
    const actor = await getActorOrAnonymous(t.id);
    if (!can(actor, 'VIEW', { isPublic: t.isPublic })) throw new ApiError(404, 'Not found.');
    const staff = isStaff(actor);
    const [matches, brackets, pools, teamRows, aliases] = await Promise.all([
      prisma.match.findMany({
        where: { tournamentId: t.id, ...(staff ? {} : { unlisted: false }) },
        orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true, name: true, state: true, scheduledAt: true, winnerId: true, poolId: true,
          teamA: { select: { id: true, name: true, color: true } },
          teamB: { select: { id: true, name: true, color: true } },
          bracketNode: { select: { key: true, bracketId: true } },
        },
      }),
      prisma.bracket.findMany({ where: { tournamentId: t.id }, orderBy: { order: 'asc' }, select: { id: true, name: true, format: true, poolId: true } }),
      prisma.mapPool.findMany({ where: { tournamentId: t.id }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } }),
      prisma.team.findMany({
        where: { division: { tournamentId: t.id }, adHoc: false, playerPool: false },
        orderBy: { name: 'asc' },
        select: {
          id: true, name: true, color: true, colorSecondary: true, logo: true,
          members: { orderBy: { order: 'asc' }, select: { player: { select: { id: true, name: true, avatar: true } } } },
        },
      }),
      tournamentAliases(t.id),
    ]);
    const teams = teamRows.map(({ members, ...team }) => ({
      ...team,
      players: members.map((m) => ({ ...shownAs(m.player, aliases), replays: (aliases.get(m.player.id)?.replays ?? []).map((r) => r.ref) })),
    }));
    return json({ tournament: { id: t.id, slug: t.slug, name: t.name }, matches, brackets, pools, teams });
  });
}

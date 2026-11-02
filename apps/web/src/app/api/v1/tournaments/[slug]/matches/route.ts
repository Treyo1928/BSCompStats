import { prisma } from '@bscs/db';
import { ApiError, apiRoute, json, runRedirectingAction } from '@/server/api';
import { matchForApi } from '@/server/api-match';
import { createMatch } from '@/server/match-actions';
import { getActorOrAnonymous } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Set up a match, as the "New match" form does.
 * Body: { poolId, teamAId, teamBId, coinFlip?: "A" | "B" | "RANDOM", blindLineups?, name?, scoring?, playOrder?, taMode? }
 * taMode: run it through TournamentAssistant; the tournament's default where left out.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return apiRoute(request, { write: true }, async ({ inTournament }) => {
    const t = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!t) throw new ApiError(404, 'Not found.');
    inTournament(t.id);
    const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const fd = new FormData();
    fd.set('tournamentId', t.id);
    for (const k of ['poolId', 'teamAId', 'teamBId', 'name', 'scoring', 'playOrder'] as const) {
      if (typeof b[k] === 'string') fd.set(k, b[k] as string);
    }
    fd.set('coinFlip', typeof b.coinFlip === 'string' ? (b.coinFlip as string) : 'A');
    if (b.blindLineups === true) fd.set('blindLineups', 'on');
    if (b.taMode !== undefined) {
      if (typeof b.taMode !== 'boolean') throw new ApiError(400, '"taMode" is true or false.');
      fd.set('taModeShown', '1');
      if (b.taMode) fd.set('taMode', 'on');
    }
    const path = await runRedirectingAction(() => createMatch(fd));
    const matchId = path?.match(/\/match\/([^/]+)$/)?.[1];
    if (!matchId) throw new ApiError(500, 'The match was not created.');
    return json({ ok: true, match: await matchForApi(matchId, await getActorOrAnonymous(t.id)) }, 201);
  });
}

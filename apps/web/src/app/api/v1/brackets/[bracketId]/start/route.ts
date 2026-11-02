import { prisma } from '@bscs/db';
import { ApiError, apiRoute, json, runRedirectingAction } from '@/server/api';
import { matchForApi } from '@/server/api-match';
import { startBracketMatch } from '@/server/bracket-actions';
import { getActorOrAnonymous } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Start the match for a bracket slot that is ready, on the slot's pool.
 * Body: { key: "W1-1", coinFlip?: "A" | "B" | "RANDOM", blindLineups?, playOrder?, scoring?, taMode? }
 * taMode: run it through TournamentAssistant; the tournament's default where left out.
 */
export async function POST(request: Request, { params }: { params: Promise<{ bracketId: string }> }) {
  const { bracketId } = await params;
  return apiRoute(request, { write: true }, async ({ inTournament }) => {
    const bracket = await prisma.bracket.findUnique({ where: { id: bracketId }, select: { tournamentId: true } });
    if (!bracket) throw new ApiError(404, 'Not found.');
    inTournament(bracket.tournamentId);
    const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (typeof b.key !== 'string') throw new ApiError(400, '"key" (the bracket slot, e.g. "W1-1") is required.');
    const fd = new FormData();
    fd.set('bracketId', bracketId);
    fd.set('key', b.key);
    fd.set('coinFlip', typeof b.coinFlip === 'string' ? (b.coinFlip as string) : 'A');
    for (const k of ['playOrder', 'scoring', 'name'] as const) if (typeof b[k] === 'string') fd.set(k, b[k] as string);
    if (b.blindLineups === true) fd.set('blindLineups', 'on');
    if (b.taMode !== undefined) {
      if (typeof b.taMode !== 'boolean') throw new ApiError(400, '"taMode" is true or false.');
      fd.set('taModeShown', '1');
      if (b.taMode) fd.set('taMode', 'on');
    }
    const path = await runRedirectingAction(() => startBracketMatch(fd));
    const matchId = path?.match(/\/match\/([^/]+)$/)?.[1];
    if (!matchId) throw new ApiError(500, 'The match was not started.');
    return json({ ok: true, match: await matchForApi(matchId, await getActorOrAnonymous(bracket.tournamentId)) }, 201);
  });
}

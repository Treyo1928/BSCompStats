import { apiRoute, json } from '@/server/api';
import { matchForApi, tournamentOfMatch } from '@/server/api-match';
import { getActorOrAnonymous } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Everything about one match: teams, pool, pick/ban log and next step, maps, lineups, scores, result. */
export async function GET(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return apiRoute(request, {}, async ({ inTournament }) => {
    const t = await tournamentOfMatch(matchId);
    inTournament(t.id);
    return json({ match: await matchForApi(matchId, await getActorOrAnonymous(t.id)) });
  });
}

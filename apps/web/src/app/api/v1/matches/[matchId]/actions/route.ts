import { prisma } from '@bscs/db';
import { ApiError, apiRoute, json, redirectOutcome } from '@/server/api';
import { matchForApi, tournamentOfMatch } from '@/server/api-match';
import { getActorOrAnonymous } from '@/server/session';
import { can } from '@bscs/core/match';
import {
  callReplay,
  cancelMapStart,
  cancelReplay,
  closeMapScores,
  completeMatch,
  pullMapScores,
  reopenMapScores,
  reopenMatch,
  playMapInTa,
  saveLineup,
  saveScores,
  startMapInTa,
  submitPickBan,
  undoLastAction,
  type TaOutcome,
} from '@/server/match-actions';

export const dynamic = 'force-dynamic';

/**
 * Move a match along, as the key's user. Body: `{ "action": "...", ...fields }`.
 * Each action is exactly the website's button for it, with the same permission
 * checks, so a key can do what its user can do on the match page and no more.
 *
 *   pick | ban       { teamId, poolMapId }           the pending pick/ban step
 *   undo             {}                              undo the last pick/ban (staff)
 *   lineup           { matchMapId, teamId, playerIds: [...] }
 *   scores           { matchMapId, teamId, source?: "TA", scores: [{ playerId, score, attempt?, failed?, accuracy?, misses? }] }
 *                                                    the results-screen scores, as typed on the match page;
 *                                                    source "TA" (staff, TA-mode matches) marks them as TA's
 *   pullScores       { matchMapId }                  fill the map's scores from BeatLeader (not in TA mode)
 *   closeMap         { matchMapId }                  scores are final (unlocks the next step in play-each-pick)
 *   reopenMap        { matchMapId }
 *   callReplay       { matchMapId, teamId }
 *   cancelReplay     { matchMapId }
 *   complete         {}                              finish the match
 *   reopen           {}
 *
 * TA mode (staff only; see docs/api.md):
 *   startMap         { matchMapId }                  load the next map in TournamentAssistant for its lineup players
 *   playMap          { matchMapId }                  start the song for all of them, once TA reports them ready
 *   restartMap       { matchMapId }                  load again after a failed or aborted start
 *   cancelStart      { matchMapId }                  take the request back; players return to the menu
 *
 * Answers `{ ok: true, match }` with the match as it now stands, or `{ error }`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return apiRoute(request, { write: true }, async ({ inTournament }) => {
    const t = await tournamentOfMatch(matchId);
    inTournament(t.id);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.action !== 'string') throw new ApiError(400, 'Send JSON like { "action": "pick", "teamId": "…", "poolMapId": "…" }.');
    const str = (k: string) => {
      const v = body[k];
      if (typeof v !== 'string' || !v) throw new ApiError(400, `"${k}" is required.`);
      return v;
    };
    const form = (fields: Record<string, string | string[]>) => {
      const fd = new FormData();
      fd.set('matchId', matchId);
      for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
      return fd;
    };
    // Site actions finish with a redirect or a revalidation; only a redirect carrying ?error= is a failure.
    const run = async (fn: () => Promise<unknown>) => {
      try {
        const out = await fn();
        if (out && typeof out === 'object' && 'error' in out && (out as { error?: string }).error) {
          throw new ApiError(400, (out as { error: string }).error);
        }
        return out;
      } catch (err) {
        const r = redirectOutcome(err);
        if (r && !r.error) return null;
        if (r?.error) throw new ApiError(400, r.error);
        throw err;
      }
    };

    // The TA steps answer with their own refusal and the status that goes with it.
    const ta = (outcome: TaOutcome) => {
      if ('error' in outcome) throw new ApiError(outcome.status, outcome.error);
    };
    const { taMode } = (await prisma.match.findUnique({ where: { id: matchId }, select: { taMode: true } })) ?? { taMode: false };

    let extra: Record<string, unknown> = {};
    switch (body.action) {
      case 'pick':
      case 'ban': {
        const actor = await getActorOrAnonymous(t.id);
        if (taMode && !can(actor, 'MAKE_PICK_BAN', { teamId: typeof body.teamId === 'string' ? body.teamId : null, taMode })) {
          throw new ApiError(403, 'This match runs through TournamentAssistant, so only an organiser picks and bans.');
        }
        const before = await matchForApi(matchId, actor);
        const step = before.pending;
        if (!step) throw new ApiError(409, 'Pick and ban is finished.');
        if (step.waitingForPoolMapId) throw new ApiError(409, 'The picked map has to be played (scores closed) before the next step.');
        if (step.type.toLowerCase() !== body.action) throw new ApiError(409, `The next step is a ${step.type.toLowerCase()}, not a ${body.action}.`);
        const taken = await prisma.matchAction.count({ where: { matchId, undoneAt: null } });
        await run(() => submitPickBan(form({ teamId: str('teamId'), poolMapId: str('poolMapId') })));
        // The site action ignores a stale or illegal step rather than failing; say so here.
        if ((await prisma.matchAction.count({ where: { matchId, undoneAt: null } })) === taken) {
          throw new ApiError(409, 'That step was not taken: not this team’s turn, the map is not available, or you may not act for this team.');
        }
        break;
      }
      case 'undo':
        await run(() => undoLastAction(form({})));
        break;
      case 'lineup': {
        const ids = body.playerIds;
        if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new ApiError(400, '"playerIds" must be a list of player ids.');
        await run(() => saveLineup(form({ matchMapId: str('matchMapId'), teamId: str('teamId'), playerId: ids as string[] })));
        break;
      }
      case 'scores': {
        const list = body.scores;
        if (!Array.isArray(list) || !list.length) throw new ApiError(400, '"scores" must be a list of { playerId, score }.');
        const fields: Record<string, string> = { matchMapId: str('matchMapId'), teamId: str('teamId') };
        if (body.source !== undefined && body.source !== 'TA' && body.source !== 'MANUAL') {
          throw new ApiError(400, '"source" may only be "TA" (or "MANUAL", the default).');
        }
        if (body.source === 'TA') {
          if (!taMode) throw new ApiError(409, 'This match does not run through TournamentAssistant, so its scores cannot come from TA.');
          if (!can(await getActorOrAnonymous(t.id), 'START_MAP')) throw new ApiError(403, 'Only an organiser can enter scores as TournamentAssistant\'s.');
          fields.source = 'TA';
        }
        for (const entry of list as Array<Record<string, unknown>>) {
          if (typeof entry.playerId !== 'string' || typeof entry.score !== 'number') throw new ApiError(400, 'Each score needs a playerId and a numeric score.');
          const attempt = typeof entry.attempt === 'number' ? entry.attempt : 1;
          fields[`score:${entry.playerId}:${attempt}`] = String(Math.round(entry.score));
          if (entry.failed === true) fields[`failed:${entry.playerId}:${attempt}`] = 'on';
          if (entry.accuracy !== undefined) {
            if (typeof entry.accuracy !== 'number' || !(entry.accuracy >= 0 && entry.accuracy <= 1)) {
              throw new ApiError(400, '"accuracy" is a fraction from 0 to 1 (0.9612 for 96.12%).');
            }
            fields[`accuracy:${entry.playerId}:${attempt}`] = String(entry.accuracy);
          }
          if (entry.misses !== undefined) {
            if (typeof entry.misses !== 'number' || !Number.isInteger(entry.misses) || entry.misses < 0) {
              throw new ApiError(400, '"misses" is a whole number of missed notes.');
            }
            fields[`misses:${entry.playerId}:${attempt}`] = String(entry.misses);
          }
        }
        await run(() => saveScores(form(fields)));
        break;
      }
      case 'pullScores': {
        if (taMode) throw new ApiError(409, 'This match runs through TournamentAssistant: its scores come from TA, not BeatLeader.');
        const outcome = await run(() => pullMapScores(matchId, str('matchMapId')));
        if (outcome && typeof outcome === 'object' && (outcome as { status?: string }).status === 'error') {
          throw new ApiError(400, (outcome as { error: string }).error);
        }
        extra = { pull: outcome };
        break;
      }
      case 'closeMap':
        await run(() => closeMapScores(form({ matchMapId: str('matchMapId') })));
        break;
      case 'reopenMap':
        await run(() => reopenMapScores(form({ matchMapId: str('matchMapId') })));
        break;
      case 'callReplay':
        await run(() => callReplay(form({ matchMapId: str('matchMapId'), teamId: str('teamId') })));
        break;
      case 'cancelReplay':
        await run(() => cancelReplay(form({ matchMapId: str('matchMapId') })));
        break;
      case 'complete':
        await run(() => completeMatch(form({})));
        break;
      case 'startMap':
      case 'restartMap':
        ta(await startMapInTa(matchId, str('matchMapId'), body.action === 'restartMap'));
        break;
      case 'cancelStart':
        ta(await cancelMapStart(matchId, str('matchMapId')));
        break;
      case 'playMap':
        ta(await playMapInTa(matchId, str('matchMapId')));
        break;
      case 'reopen':
        await run(() => reopenMatch(form({})));
        break;
      default:
        throw new ApiError(400, `Unknown action "${body.action}".`);
    }
    return json({ ok: true, ...extra, match: await matchForApi(matchId, await getActorOrAnonymous(t.id)) });
  });
}

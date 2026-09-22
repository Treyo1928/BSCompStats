'use server';

import { prisma } from '@bscs/db';
import type { AnswerCardInput, AnswerCardResult } from '@bscs/core/optimize';
import { can } from './match-helpers';
import { loadMatch } from './matches';
import { getActorOrAnonymous } from './session';
import { buildTournamentModel, predictorFor } from './stats';
import { runAnswerCard } from './advice-thread';

/**
 * Answers already worked out, by the exact question asked, and the questions
 * being worked out now. This is seconds of CPU on the one advice thread the
 * match pages share, and anyone who can view a public match can ask; the same
 * question asked twice - a second click, a second tab, a loop - costs nothing
 * the second time and never queues twice.
 */
const answerCache = new Map<string, Promise<AnswerCardResult>>();
const ANSWER_CACHE_LIMIT = 200;

function remember(key: string, work: () => Promise<AnswerCardResult>): Promise<AnswerCardResult> {
  const hit = answerCache.get(key);
  if (hit) return hit;
  const pending = work().catch((err) => {
    // A failure is not an answer to keep.
    answerCache.delete(key);
    throw err;
  });
  answerCache.set(key, pending);
  if (answerCache.size > ANSWER_CACHE_LIMIT) {
    const oldest = answerCache.keys().next().value;
    if (oldest !== undefined) answerCache.delete(oldest);
  }
  return pending;
}

/**
 * "If they field this, what should we field?" - the lineup optimiser against
 * a card the captain supplies rather than one the engine assumes.
 *
 * Anyone who can see the match can ask: it is the same public scores the page
 * is built from, and the answer for a team is only ever as good as the guess.
 */
export async function answerOpponentCardAction(
  matchId: string,
  forTeamId: string,
  opponentLineups: Record<string, string[]>,
): Promise<{ result?: AnswerCardResult; error?: string }> {
  const match = await loadMatch(matchId);
  if (!match) return { error: 'Match not found.' };
  const actor = await getActorOrAnonymous(match.tournament.id);
  if (!can(actor, 'VIEW', { isPublic: match.tournament.isPublic })) return { error: 'Match not found.' };
  if (forTeamId !== match.teamA.id && forTeamId !== match.teamB.id) return { error: 'That team is not in this match.' };
  if (match.pending) return { error: 'The card is not set until pick/ban is over.' };
  if (match.plannedMaps.length === 0) return { error: 'No maps have been picked yet.' };

  const ourTeam = forTeamId === match.teamA.id ? match.teamA : match.teamB;
  const theirTeam = forTeamId === match.teamA.id ? match.teamB : match.teamA;
  const ourRoster = ourTeam.players.map((p) => p.id);
  const theirRoster = new Set(theirTeam.players.map((p) => p.id));
  const mapIds = new Set(match.plannedMaps.map((pm) => pm.poolMapId));

  // Only their players, only these maps, only the right number each - the form is not trusted.
  const k = match.format.playersPerMap;
  // The same guard the panel has: a side that cannot fill a map has no card.
  for (const [team, size] of [[ourTeam, ourRoster.length], [theirTeam, theirRoster.size]] as const) {
    if (size < k) return { error: `${team.name} has ${size} available player${size === 1 ? '' : 's'}, but this format fields ${k} per map.` };
  }
  const cleaned: Record<string, string[]> = {};
  for (const [mapId, ids] of Object.entries(opponentLineups)) {
    if (!mapIds.has(mapId)) continue;
    const group = [...new Set(ids.filter((id) => theirRoster.has(id)))];
    if (group.length === k) cleaned[mapId] = group;
  }

  const model = await buildTournamentModel(match.tournament.id);
  const predict = predictorFor(model);
  const playedMaps = match.plannedMaps.map((pm) => ({
    id: pm.poolMapId,
    leaderboardId: pm.map.leaderboardId,
    maxScore: pm.map.maxScore,
    isTiebreaker: pm.isTiebreaker,
  }));
  const predictions: AnswerCardInput['predictions'] = {};
  for (const playerId of new Set([...ourRoster, ...theirRoster])) {
    const row: Record<string, ReturnType<typeof predict>> = {};
    for (const map of playedMaps) row[map.leaderboardId] = predict(playerId, map.leaderboardId);
    predictions[playerId] = row;
  }

  const input: AnswerCardInput = {
    format: match.format,
    playedMaps,
    ourRoster,
    theirRoster: [...theirRoster],
    predictions,
    opponentLineups: cleaned,
    iterations: 6_000,
    seed: 1,
  };
  try {
    // Keyed on everything the answer depends on, predictions included, so a
    // refit or a roster change is a new question and an old one is cheap.
    const result = await remember(JSON.stringify(input), () => runAnswerCard(input));
    return { result };
  } catch (err) {
    console.error('[answer-card] failed:', err);
    return { error: 'Could not work that out. Try again in a moment.' };
  }
}

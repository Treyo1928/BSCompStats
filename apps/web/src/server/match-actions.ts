'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@bscs/db';
import {
  assertCan,
  can,
  canOverrideViolations,
  parseFormat,
  prepareAction,
  PickBanError,
  resolveMapPlan,
  validateLineups,
  isCaptainOf,
  type LineupInput,
} from './match-helpers';
import { buildPickBanContext } from './matches';
import { getActor, realUser } from './session';
import { failBack } from './form-errors';
import { announceMatchChange } from '@/lib/redis';
import { cleanUpAdHocTeams, openMatch } from './custom-teams';
import { tallyMaps } from './match-summary';

/**
 * Match mutations.
 *
 * Every one of these re-derives the match state from the action log and
 * re-checks permission. The browser's idea of whose turn it is has no
 * authority here - two captains clicking at the same moment must not both
 * succeed, and a stale tab must not be able to pick a map that was already
 * banned.
 */

/** Every mutation ends here: refresh this viewer, and tell everyone else's page. */
async function matchChanged(slug: string, matchId: string): Promise<void> {
  revalidatePath(`/t/${slug}/match/${matchId}`);
  await announceMatchChange(matchId);
}

export async function createMatch(formData: FormData): Promise<void> {
  const tournamentId = String(formData.get('tournamentId'));
  const actor = await getActor(tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'CREATE_MATCH');

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { slug: true },
  });
  if (!tournament) throw new Error('Pool or tournament not found.');

  const back =
    formData.get('from') === 'teams' ? `/t/${tournament.slug}/teams` : `/t/${tournament.slug}`;

  const opened = await openMatch({
    tournamentId,
    poolId: String(formData.get('poolId')),
    teamAId: String(formData.get('teamAId')),
    teamBId: String(formData.get('teamBId')),
    coinFlip: formData.get('coinFlip') === 'B' ? 'B' : 'A',
    blindLineups: formData.get('blindLineups') === 'on',
    name: String(formData.get('name') ?? ''),
  });
  if ('error' in opened) failBack(back, opened.error);

  redirect(`/t/${tournament.slug}/match/${opened.matchId}`);
}

export async function submitPickBan(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const poolMapId = String(formData.get('poolMapId'));
  const teamId = String(formData.get('teamId'));

  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');

  // A captain may act for their own team; staff may act for either.
  if (!can(actor, 'MAKE_PICK_BAN', { teamId })) {
    throw new Error('It is not your place to make this pick.');
  }

  const format = parseFormat(match.format ?? match.tournament.defaultFormat);
  const ctx = buildPickBanContext(match, format);

  // Out of turn, already used, or finished. Almost always a tab that is a
  // step behind - the other captain just acted - so the honest response is to
  // show the match as it now stands, not an error page.
  let action: ReturnType<typeof prepareAction>;
  try {
    action = prepareAction(ctx, { teamId, poolMapId });
  } catch (err) {
    if (!(err instanceof PickBanError)) throw err;
    await matchChanged(match.tournament.slug, matchId);
    return;
  }

  const actingForSomeoneElse = !isCaptainOf(actor, teamId);
  const captainSeat = actingForSomeoneElse
    ? await prisma.teamMember.findFirst({
        where: { teamId, role: 'CAPTAIN', player: { userId: { not: null } } },
        orderBy: { order: 'asc' },
        select: { player: { select: { userId: true } } },
      })
    : null;

  // (matchId, seq) is unique - that is what stops two captains both taking
  // the same step. An undone action still holds its seq as a tombstone, so it
  // has to make way before the step can be retaken, or the insert collides.
  // While an admin is viewing as someone, the record should still say who was
  // really at the keyboard.
  const operator = (await realUser())?.id ?? actor.userId;

  try {
    await prisma.$transaction([
      prisma.matchAction.deleteMany({
        where: { matchId, seq: action.seq, undoneAt: { not: null } },
      }),
      prisma.matchAction.create({
        data: {
          matchId,
          seq: action.seq,
          type: action.type,
          teamId: action.teamId,
          poolMapId: action.poolMapId,
          actingUserId: operator,
          // Recorded so the timeline reads honestly when an organiser stands in.
          onBehalfOfUserId: captainSeat?.player.userId ?? actor.userId,
        },
      }),
    ]);
  } catch (err) {
    // The unique (matchId, seq) did its job: someone else took this step a
    // moment earlier. Same answer as a stale tab.
    if ((err as { code?: string }).code !== 'P2002') throw err;
    await matchChanged(match.tournament.slug, matchId);
    return;
  }

  await materializeMaps(matchId);
  await matchChanged(match.tournament.slug, matchId);
}

export async function undoLastAction(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'UNDO_ACTION');

  // Undoing under a final result would delete the maps that justify it while
  // leaving the winner in place. Reopen the match first.
  if (match.state === 'COMPLETE') return;

  const last = await prisma.matchAction.findFirst({
    where: { matchId, undoneAt: null },
    orderBy: { seq: 'desc' },
  });
  if (!last) return;

  // Tombstoned rather than deleted, so a step that was taken back stays on
  // record until someone retakes it (see submitPickBan).
  await prisma.matchAction.update({
    where: { id: last.id },
    data: { undoneAt: new Date() },
  });

  await materializeMaps(matchId);
  await matchChanged(match.tournament.slug, matchId);
}

/**
 * Rule violations come back as a value, not a throw: production builds replace
 * a thrown message with a generic one, and "which rule did I break" is the one
 * thing a captain needs to read here.
 */
export async function saveLineup(formData: FormData): Promise<{ error?: string }> {
  const matchId = String(formData.get('matchId'));
  const teamId = String(formData.get('teamId'));
  const matchMapId = String(formData.get('matchMapId'));
  const playerIds = formData
    .getAll('playerId')
    .map((v) => String(v))
    .filter(Boolean);

  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  if (!can(actor, 'SET_LINEUP', { teamId })) {
    throw new Error('You cannot set this team\'s lineup.');
  }
  // The scores are frozen against the lineups that earned them. Every other
  // change to a finished match is refused; this one was not, and rewrote who
  // "played" under a final result.
  if (match.state === 'COMPLETE') {
    return { error: 'This match is complete, so its lineups are frozen. Reopen it to change them.' };
  }
  if (teamId !== match.teamAId && teamId !== match.teamBId) {
    throw new Error('That team is not in this match.');
  }

  const format = parseFormat(match.format ?? match.tournament.defaultFormat);

  // Validate the whole card, not just this map: the duo rule is about how the
  // maps relate to each other, so one map in isolation cannot be checked.
  const existing = await prisma.matchMap.findMany({
    where: { matchId },
    orderBy: { order: 'asc' },
    include: {
      poolMap: { include: { leaderboard: { include: { map: true } } } },
      lineups: { include: { slots: true } },
    },
  });

  // Both ids arrive from the form. Unless they are tied to this match, the
  // submitted players never reach validation and get written to whatever
  // match map was named.
  if (!existing.some((mm) => mm.id === matchMapId)) {
    throw new Error('That map is not part of this match.');
  }

  // Hidden lineups: while either side has maps unset, someone on a team in
  // this match may only touch their own card - the same rule the page draws,
  // held here too, so an organiser who captains one side cannot post the
  // action for the other.
  if (match.blindLineups) {
    const everySet = existing.every((mm) =>
      [match.teamAId, match.teamBId].every(
        (id) => (mm.lineups.find((l) => l.teamId === id)?.slots.length ?? 0) >= format.playersPerMap,
      ),
    );
    if (!everySet && actor.userId) {
      const spots = await prisma.teamMember.findMany({
        where: { teamId: { in: [match.teamAId, match.teamBId] }, player: { userId: actor.userId } },
        select: { teamId: true },
      });
      const mySides = new Set([
        ...spots.map((s) => s.teamId),
        ...[match.teamAId, match.teamBId].filter((id) => isCaptainOf(actor, id)),
      ]);
      if (mySides.size > 0 && !mySides.has(teamId)) {
        return { error: 'Lineups are hidden until both teams have set every map. You can only set your own team\'s.' };
      }
    }
  }

  const lineups: LineupInput[] = existing.map((mm) => ({
    matchMapId: mm.id,
    mapLabel: `Map ${mm.order} - ${mm.poolMap.leaderboard.map.name}`,
    isTiebreaker: mm.isTiebreaker,
    playerIds:
      mm.id === matchMapId
        ? playerIds
        : (mm.lineups.find((l) => l.teamId === teamId)?.slots ?? []).map((s) => s.playerId),
  }));

  // Only players who can actually be fielded: not an absent one, not a sub who
  // has not been switched in.
  const roster = await prisma.teamMember.findMany({
    where: { teamId, available: true },
    select: { playerId: true, player: { select: { name: true } } },
  });
  const names = new Map(roster.map((r) => [r.playerId, r.player.name]));

  const result = validateLineups({
    format,
    lineups,
    roster: roster.map((r) => r.playerId),
    playerName: (id) => names.get(id) ?? id,
  });

  // Fielding someone who is not on the team is never a rules question an
  // organiser can wave through - the override exists for the duo rule.
  const strangers = playerIds.filter((id) => !names.has(id));
  if (strangers.length) throw new Error('Every player in a lineup must be on the team.');

  const blocking = result.violations.filter((v) => v.severity === 'ERROR');
  const override = formData.get('override') === 'on';

  if (blocking.length && !override) {
    return { error: blocking.map((v) => v.message).join(' ') };
  }
  if (blocking.length && override && !canOverrideViolations(actor, teamId)) {
    return { error: 'That lineup breaks the rules, and you cannot override them for this team.' };
  }
  // Kept on the lineup: whether an override was fair is the organisers' call,
  // and they can only make it if they can see that it happened.
  const ruleBreaks = blocking.length ? blocking.map((v) => v.message).join(' ') : null;

  // One transaction: two people saving the same map at once must not end up
  // with a mixture, and a failure must not leave the lineup empty.
  await prisma.$transaction(async (tx) => {
    const lineup = await tx.lineup.upsert({
      where: { matchMapId_teamId: { matchMapId, teamId } },
      create: { matchMapId, teamId, ruleBreaks },
      update: { ruleBreaks },
    });
    await tx.lineupSlot.deleteMany({ where: { lineupId: lineup.id } });
    await tx.lineupSlot.createMany({
      data: playerIds.map((playerId, slot) => ({ lineupId: lineup.id, playerId, slot })),
    });
  });

  await matchChanged(match.tournament.slug, matchId);
  return {};
}

/**
 * Record what was scored in the match.
 *
 * Typed in rather than pulled from BeatLeader, because BeatLeader only keeps a
 * player's best ever run on a map: someone who practised to a 96 and scores a
 * 93 on the night would be credited with the 96. The run that counts is the one
 * played here.
 *
 * One form per team per map. A blank field removes that run. Where a replay
 * has been called there are further runs, and each player's best one counts.
 */
export async function saveScores(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const matchMapId = String(formData.get('matchMapId'));
  const teamId = String(formData.get('teamId'));

  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  if (teamId !== match.teamAId && teamId !== match.teamBId) {
    throw new Error('That team is not in this match.');
  }
  assertCan(actor, 'ENTER_SCORE', {
    teamId,
    captainsEnterScores: match.tournament.captainsEnterScores,
  });

  const back = `/t/${match.tournament.slug}/match/${matchId}`;
  if (match.state === 'COMPLETE') {
    failBack(back, 'This match is complete, so its scores are frozen. Reopen it to correct them.');
  }

  const matchMap = await prisma.matchMap.findFirst({
    where: { id: matchMapId, matchId },
    select: {
      replayCalledByTeamIds: true,
      poolMap: { select: { leaderboard: { select: { maxScore: true } } } },
      lineups: { where: { teamId }, select: { slots: { select: { playerId: true } } } },
    },
  });
  if (!matchMap) throw new Error('That map is not part of this match.');

  const maxScore = matchMap.poolMap.leaderboard.maxScore;
  const runsAllowed = 1 + matchMap.replayCalledByTeamIds.length;
  const fielded = new Set(matchMap.lineups.flatMap((l) => l.slots.map((slot) => slot.playerId)));

  const writes = [];
  for (const playerId of fielded) {
    for (let attempt = 1; attempt <= runsAllowed; attempt++) {
      const raw = String(formData.get(`score:${playerId}:${attempt}`) ?? '').replace(/[\s,._]/g, '');
      const key = { matchMapId_teamId_playerId_attempt: { matchMapId, teamId, playerId, attempt } };

      if (raw === '') {
        writes.push(prisma.matchMapAttempt.deleteMany({ where: { matchMapId, teamId, playerId, attempt } }));
        continue;
      }

      const score = Number(raw);
      if (!Number.isInteger(score) || score < 0) {
        failBack(back, `"${raw}" is not a score. Enter the number shown on the results screen.`);
      }
      if (maxScore > 0 && score > maxScore) {
        failBack(back, `${score.toLocaleString('en-US')} is more than this map's maximum of ${maxScore.toLocaleString('en-US')}.`);
      }

      const accuracy = maxScore > 0 ? score / maxScore : 0;
      writes.push(
        prisma.matchMapAttempt.upsert({
          where: key,
          create: { matchMapId, teamId, playerId, attempt, score, accuracy, source: 'MANUAL' },
          update: { score, accuracy, source: 'MANUAL', beatLeaderScoreId: null, replayUrl: null },
        }),
      );
    }
  }
  await prisma.$transaction(writes);

  await matchChanged(match.tournament.slug, matchId);
}

/**
 * Spend a team's replay on a map. Both teams then play it again, and each
 * player's best run is the one that counts - so a replay can only help the
 * team that calls it if they actually do better.
 */
export async function callReplay(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const matchMapId = String(formData.get('matchMapId'));
  const teamId = String(formData.get('teamId'));

  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  if (teamId !== match.teamAId && teamId !== match.teamBId) {
    throw new Error('That team is not in this match.');
  }
  if (!can(actor, 'SET_LINEUP', { teamId })) throw new Error('You cannot call a replay for this team.');

  const back = `/t/${match.tournament.slug}/match/${matchId}`;
  if (match.state === 'COMPLETE') failBack(back, 'This match is complete.');

  const format = parseFormat(match.format ?? match.tournament.defaultFormat);
  const maps = await prisma.matchMap.findMany({
    where: { matchId },
    select: { id: true, replayCalledByTeamIds: true },
  });
  const target = maps.find((m) => m.id === matchMapId);
  if (!target) throw new Error('That map is not part of this match.');

  const used = maps.reduce(
    (count, m) => count + m.replayCalledByTeamIds.filter((id) => id === teamId).length,
    0,
  );
  if (used >= format.rules.replaysPerTeam) {
    failBack(
      back,
      format.rules.replaysPerTeam === 0
        ? 'This format does not allow replays.'
        : `This team has already used its ${format.rules.replaysPerTeam === 1 ? 'replay' : `${format.rules.replaysPerTeam} replays`}.`,
    );
  }

  await prisma.matchMap.update({
    where: { id: matchMapId },
    data: { replayCalledByTeamIds: { push: teamId } },
  });
  await matchChanged(match.tournament.slug, matchId);
}

/** Take back a replay call. Staff only; removes the extra run's scores too. */
export async function cancelReplay(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const matchMapId = String(formData.get('matchMapId'));

  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'UNDO_ACTION');
  if (match.state === 'COMPLETE') return;

  const target = await prisma.matchMap.findFirst({
    where: { id: matchMapId, matchId },
    select: { replayCalledByTeamIds: true },
  });
  if (!target || target.replayCalledByTeamIds.length === 0) return;

  const remaining = target.replayCalledByTeamIds.slice(0, -1);
  await prisma.$transaction([
    prisma.matchMap.update({ where: { id: matchMapId }, data: { replayCalledByTeamIds: remaining } }),
    prisma.matchMapAttempt.deleteMany({ where: { matchMapId, attempt: { gt: 1 + remaining.length } } }),
  ]);
  await matchChanged(match.tournament.slug, matchId);
}

/** Write the MatchMap rows implied by the current pick/ban state. */
async function materializeMaps(matchId: string): Promise<void> {
  const match = await loadForMutation(matchId);
  const format = parseFormat(match.format ?? match.tournament.defaultFormat);
  const plan = resolveMapPlan(buildPickBanContext(match, format));

  // An undo can shorten the plan, so anything no longer in it goes - along with
  // its lineups, which were chosen for a map that is not being played.
  await prisma.matchMap.deleteMany({
    where: { matchId, poolMapId: { notIn: plan.map((p) => p.poolMapId) } },
  });

  for (const entry of plan) {
    await prisma.matchMap.upsert({
      where: { matchId_order: { matchId, order: entry.order } },
      create: {
        matchId,
        order: entry.order,
        poolMapId: entry.poolMapId,
        isTiebreaker: entry.isTiebreaker,
        pickedById: entry.pickedByTeamId,
      },
      update: {
        poolMapId: entry.poolMapId,
        isTiebreaker: entry.isTiebreaker,
        pickedById: entry.pickedByTeamId,
      },
    });
  }

  const complete = plan.length >= format.pickBanSequence.filter((s) => s.action === 'PICK').length;
  // Both directions: an undo that reopens pick/ban has to say so.
  await prisma.match.updateMany({
    where: { id: matchId, state: complete ? 'PICKBAN' : 'PLAYING' },
    data: { state: complete ? 'PLAYING' : 'PICKBAN' },
  });
}

async function loadForMutation(matchId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      tournament: { select: { slug: true, defaultFormat: true, captainsEnterScores: true } },
      pool: { select: { maps: { orderBy: { order: 'asc' }, select: { id: true, isTiebreaker: true } } } },
      actions: {
        where: { undoneAt: null },
        orderBy: { seq: 'asc' },
        select: { seq: true, type: true, teamId: true, poolMapId: true },
      },
    },
  });
  if (!match) throw new Error('Match not found.');
  return match;
}

/**
 * Freeze a match. Its recorded attempts become the final result and stop
 * tracking whatever the players do on those maps afterwards.
 */
export async function completeMatch(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  const maps = await prisma.matchMap.findMany({
    where: { matchId },
    include: { attempts: true },
  });

  let { a, b } = tallyMaps(maps, match.teamAId, match.teamBId);

  // A format decided on aggregate counts points, not maps: winning three maps
  // narrowly and losing one badly can lose the match.
  const format = parseFormat(match.format ?? match.tournament.defaultFormat);
  if (format.winCondition === 'AGGREGATE_MARGIN') {
    // Best attempt per player, so a replayed map counts the higher run.
    const totalFor = (attempts: Array<{ teamId: string; playerId: string; score: number }>, teamId: string) => {
      const best = new Map<string, number>();
      for (const attempt of attempts.filter((x) => x.teamId === teamId)) {
        best.set(attempt.playerId, Math.max(best.get(attempt.playerId) ?? 0, attempt.score));
      }
      return [...best.values()].reduce((acc, v) => acc + v, 0);
    };
    a = maps.reduce((sum, m) => sum + totalFor(m.attempts, match.teamAId), 0);
    b = maps.reduce((sum, m) => sum + totalFor(m.attempts, match.teamBId), 0);
  }

  await prisma.match.update({
    where: { id: matchId },
    data: {
      state: 'COMPLETE',
      completedAt: new Date(),
      winnerId: a === b ? null : a > b ? match.teamAId : match.teamBId,
    },
  });

  await matchChanged(match.tournament.slug, matchId);
}

/** Remove a match and everything recorded in it. Staff only. */
export async function deleteMatch(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'CREATE_MATCH');

  // Picks, bans, maps, lineups and scores all cascade from the match.
  await prisma.match.delete({ where: { id: matchId } });
  // A side made up for this match has nothing left to exist for.
  await cleanUpAdHocTeams([match.teamAId, match.teamBId]);
  await announceMatchChange(matchId);
  revalidatePath(`/t/${match.tournament.slug}`);
  redirect(`/t/${match.tournament.slug}`);
}

/** Reopen a completed match so its scores can be corrected. */
export async function reopenMatch(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'MANAGE_TOURNAMENT');

  await prisma.match.update({
    where: { id: matchId },
    data: { state: 'PLAYING', completedAt: null, winnerId: null },
  });

  await matchChanged(match.tournament.slug, matchId);
}

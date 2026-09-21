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
  assertPoolIsBigEnough,
  isCaptainOf,
  type LineupInput,
} from './match-helpers';
import { buildPickBanContext } from './matches';
import { getActor, realUser } from './session';
import { failBack } from './form-errors';
import { announceMatchChange } from '@/lib/redis';

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

  const poolId = String(formData.get('poolId'));
  const teamAId = String(formData.get('teamAId'));
  const teamBId = String(formData.get('teamBId'));

  const [pool, tournament] = await Promise.all([
    prisma.mapPool.findUnique({
      where: { id: poolId },
      select: {
        id: true,
        tournamentId: true,
        maps: { select: { id: true, isTiebreaker: true } },
      },
    }),
    prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { slug: true, defaultFormat: true },
    }),
  ]);
  // Permission was checked against tournamentId, so everything else named in
  // the form has to belong to it - otherwise a match in your own tournament
  // becomes a window onto someone else's private pool and rosters.
  if (!pool || !tournament || pool.tournamentId !== tournamentId) {
    throw new Error('Pool or tournament not found.');
  }

  const back = `/t/${tournament.slug}/teams`;
  if (teamAId === teamBId) failBack(back, 'A team cannot play itself - choose two different teams.');

  const format = parseFormat(tournament.defaultFormat);

  // Catch a pool too small to finish pick/ban now, rather than stranding two
  // captains halfway through with nothing left to pick.
  try {
    assertPoolIsBigEnough({
    format,
    poolMapIds: pool.maps
      .filter((m) => !(format.tiebreaker === 'DESIGNATED' && m.isTiebreaker))
      .map((m) => m.id),
    coinWinnerTeamId: teamAId,
    coinLoserTeamId: teamBId,
    actions: [],
    });
  } catch (err) {
    if (!(err instanceof PickBanError)) throw err;
    failBack(back, err.message);
  }

  const teams = await prisma.team.findMany({
    where: { id: { in: [teamAId, teamBId] }, division: { tournamentId } },
    select: { id: true, name: true },
  });
  const teamA = teams.find((t) => t.id === teamAId);
  const teamB = teams.find((t) => t.id === teamBId);
  if (!teamA || !teamB) throw new Error('Both teams must belong to this tournament.');

  const requestedCoinWinner = String(formData.get('coinFlipWinnerId') ?? '');
  const coinFlipWinnerId = requestedCoinWinner === teamBId ? teamBId : teamAId;

  const match = await prisma.match.create({
    data: {
      tournamentId,
      poolId,
      teamAId,
      teamBId,
      coinFlipWinnerId,
      name:
        String(formData.get('name') ?? '').trim() ||
        `${teamA?.name ?? 'Team A'} vs ${teamB?.name ?? 'Team B'}`,
      state: 'PICKBAN',
      startedAt: new Date(),
    },
  });

  redirect(`/t/${tournament.slug}/match/${match.id}`);
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

  const format = parseFormat(match.format ?? match.tournament.defaultFormat);

  // Validate the whole card, not just this map: the duo rule is about how the
  // maps relate to each other, so one map in isolation cannot be checked.
  const existing = await prisma.matchMap.findMany({
    where: { matchId },
    orderBy: { order: 'asc' },
    include: {
      poolMap: { include: { leaderboard: { include: { map: true } } } },
      lineups: { where: { teamId }, include: { slots: true } },
    },
  });

  // Both ids arrive from the form. Unless they are tied to this match, the
  // submitted players never reach validation and get written to whatever
  // match map was named.
  if (!existing.some((mm) => mm.id === matchMapId)) {
    throw new Error('That map is not part of this match.');
  }
  if (teamId !== match.teamAId && teamId !== match.teamBId) {
    throw new Error('That team is not in this match.');
  }

  const lineups: LineupInput[] = existing.map((mm) => ({
    matchMapId: mm.id,
    mapLabel: `Map ${mm.order} - ${mm.poolMap.leaderboard.map.name}`,
    isTiebreaker: mm.isTiebreaker,
    playerIds:
      mm.id === matchMapId
        ? playerIds
        : (mm.lineups[0]?.slots ?? []).map((s) => s.playerId),
  }));

  const roster = await prisma.teamMember.findMany({
    where: { teamId },
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
  if (blocking.length && override && !canOverrideViolations(actor)) {
    // The real scrim needed this - a three-player team cannot field four legal
    // duos - but it has to be a deliberate act by somebody running the event.
    return {
      error: 'That lineup breaks the rules, and only an organiser or admin can override it.',
    };
  }

  // One transaction: two people saving the same map at once must not end up
  // with a mixture, and a failure must not leave the lineup empty.
  await prisma.$transaction(async (tx) => {
    const lineup = await tx.lineup.upsert({
      where: { matchMapId_teamId: { matchMapId, teamId } },
      create: { matchMapId, teamId },
      update: {},
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
 * Pull each lineup player's current score on their map into the match.
 *
 * Scores are matched from what the ingestion worker has already stored, rather
 * than fetched here, so this is instant and works the same whether the score
 * arrived over the live socket or a poll.
 */
export async function pullScores(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'ENTER_SCORE');

  // BeatLeader reports a player's *current* best, not what they scored on the
  // night. Re-pulling a finished match would quietly rewrite its result weeks
  // later as people improve on the same maps - so a completed match is frozen
  // and its recorded attempts stand.
  if (match.state === 'COMPLETE') {
    throw new Error(
      'This match is complete. Its scores are frozen so later practice cannot ' +
        'change the result. Reopen it first if you really need to re-pull.',
    );
  }

  const maps = await prisma.matchMap.findMany({
    where: { matchId },
    include: {
      poolMap: { select: { leaderboardId: true } },
      lineups: { include: { slots: true } },
    },
  });

  for (const matchMap of maps) {
    for (const lineup of matchMap.lineups) {
      for (const slot of lineup.slots) {
        const score = await prisma.score.findUnique({
          where: {
            playerId_leaderboardId: {
              playerId: slot.playerId,
              leaderboardId: matchMap.poolMap.leaderboardId,
            },
          },
        });
        if (!score) continue;

        await prisma.matchMapAttempt.upsert({
          where: {
            matchMapId_teamId_playerId_attempt: {
              matchMapId: matchMap.id,
              teamId: lineup.teamId,
              playerId: slot.playerId,
              attempt: 1,
            },
          },
          create: {
            matchMapId: matchMap.id,
            teamId: lineup.teamId,
            playerId: slot.playerId,
            attempt: 1,
            score: score.baseScore,
            accuracy: score.accuracy,
            source: 'AUTO',
            beatLeaderScoreId: score.beatLeaderScoreId,
            replayUrl: score.replayUrl,
          },
          update: {
            score: score.baseScore,
            accuracy: score.accuracy,
            beatLeaderScoreId: score.beatLeaderScoreId,
            replayUrl: score.replayUrl,
          },
        });
      }
    }
  }

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
      tournament: { select: { slug: true, defaultFormat: true } },
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

  let a = 0;
  let b = 0;
  const regular = maps.filter((m) => !m.isTiebreaker);

  const totalFor = (attempts: Array<{ teamId: string; playerId: string; score: number }>, teamId: string) => {
    // Best attempt per player, so a replayed map counts the higher run.
    const best = new Map<string, number>();
    for (const attempt of attempts.filter((x) => x.teamId === teamId)) {
      best.set(attempt.playerId, Math.max(best.get(attempt.playerId) ?? 0, attempt.score));
    }
    return [...best.values()].reduce((acc, v) => acc + v, 0);
  };

  for (const matchMap of regular) {
    const totalA = totalFor(matchMap.attempts, match.teamAId);
    const totalB = totalFor(matchMap.attempts, match.teamBId);
    if (!totalA && !totalB) continue;
    if (totalA > totalB) a++;
    else if (totalB > totalA) b++;
  }

  if (a === b) {
    const tb = maps.find((m) => m.isTiebreaker);
    if (tb) {
      const totalA = totalFor(tb.attempts, match.teamAId);
      const totalB = totalFor(tb.attempts, match.teamBId);
      if (totalA > totalB) a++;
      else if (totalB > totalA) b++;
    }
  }

  // A format decided on aggregate counts points, not maps: winning three maps
  // narrowly and losing one badly can lose the match.
  const format = parseFormat(match.format ?? match.tournament.defaultFormat);
  if (format.winCondition === 'AGGREGATE_MARGIN') {
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

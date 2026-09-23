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
  isStaff,
  type LineupInput,
} from './match-helpers';
import { buildPickBanContext } from './matches';
import { getActor, realUser } from './session';
import { failBack } from './form-errors';
import { announceMatchChange } from '@/lib/redis';
import { cleanUpAdHocTeams, openMatch } from './custom-teams';
import { perfectAccOf, scoringOf, tallyMaps } from './match-summary';
import { aggregateTotals } from '@bscs/core/match';
import { choose, fetchRuns, loadPullTarget, writeRuns } from './score-pull';

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

  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { slug: true, captainsCreateMatches: true },
  });
  if (!tournament) throw new Error('Pool or tournament not found.');

  const back =
    formData.get('from') === 'teams' ? `/t/${tournament.slug}/teams` : `/t/${tournament.slug}`;

  // Staff may set up any match; where the tournament allows it, a captain may
  // set up one their own team plays in.
  const sides = [String(formData.get('teamAId')), String(formData.get('teamBId'))];
  if (!sides.some((teamId) => can(actor, 'CREATE_MATCH', { teamId, captainsCreateMatches: tournament.captainsCreateMatches }))) {
    failBack(back, 'You can only set up a match your own team plays in.');
  }

  const opened = await openMatch({
    tournamentId,
    poolId: String(formData.get('poolId')),
    teamAId: String(formData.get('teamAId')),
    teamBId: String(formData.get('teamBId')),
    coinFlip: formData.get('coinFlip') === 'B' ? 'B' : 'A',
    blindLineups: formData.get('blindLineups') === 'on',
    name: String(formData.get('name') ?? ''),
    scoring: formData.get('scoring') ? String(formData.get('scoring')) : null,
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
    if (!everySet && actor.userId && !isStaff(actor)) {
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
 * Type in what was scored in the match - the override for when BeatLeader
 * cannot say: a player whose stats are private, a run that did not upload,
 * someone who started late.
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
      scoresClosedAt: true,
      replayCalledByTeamIds: true,
      poolMap: { select: { leaderboard: { select: { maxScore: true } } } },
      lineups: { where: { teamId }, select: { slots: { select: { playerId: true } } } },
    },
  });
  if (!matchMap) throw new Error('That map is not part of this match.');
  if (matchMap.scoresClosedAt) failBack(back, CLOSED);
  const outOfOrder = await earlierMapOpen(matchId, matchMapId, isStaff(actor));
  if (outOfOrder) failBack(back, outOfOrder);

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
          update: {
            score,
            accuracy,
            source: 'MANUAL',
            beatLeaderScoreId: null,
            beatLeaderAttemptId: null,
            endType: null,
            timeset: null,
            replayUrl: null,
          },
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

  // A replay is a new run: it opens now, and its scores are open until closed.
  await prisma.matchMap.update({
    where: { id: matchMapId },
    data: { replayCalledByTeamIds: { push: teamId }, runOpenedAt: new Date(), scoresClosedAt: null },
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

  const current = new Map(
    (await prisma.matchMap.findMany({ where: { matchId }, select: { order: true, poolMapId: true } })).map((m) => [
      m.order,
      m.poolMapId,
    ]),
  );
  for (const entry of plan) {
    // An undo and a different pick put another map in a slot: its run opens now.
    const replaced = current.has(entry.order) && current.get(entry.order) !== entry.poolMapId;
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
        ...(replaced ? { runOpenedAt: new Date(), scoresClosedAt: null } : {}),
      },
    });
  }

  await fillForcedLineups(matchId, [match.teamAId, match.teamBId], format.playersPerMap);

  const complete = plan.length >= format.pickBanSequence.filter((s) => s.action === 'PICK').length;
  // Both directions: an undo that reopens pick/ban has to say so.
  await prisma.match.updateMany({
    where: { id: matchId, state: complete ? 'PICKBAN' : 'PLAYING' },
    data: { state: complete ? 'PLAYING' : 'PICKBAN' },
  });
}

/**
 * A team with exactly as many players as a map needs has nothing to choose:
 * everyone plays every map. Their lineups are set as each map is picked, so
 * nobody has to click through a choice that is not one.
 */
async function fillForcedLineups(matchId: string, teamIds: string[], playersPerMap: number): Promise<void> {
  const [maps, rosters] = await Promise.all([
    prisma.matchMap.findMany({ where: { matchId }, select: { id: true, lineups: { select: { teamId: true } } } }),
    prisma.teamMember.findMany({
      where: { teamId: { in: teamIds }, available: true },
      orderBy: { order: 'asc' },
      select: { teamId: true, playerId: true },
    }),
  ]);
  for (const teamId of teamIds) {
    const players = rosters.filter((r) => r.teamId === teamId).map((r) => r.playerId);
    if (players.length !== playersPerMap) continue;
    for (const map of maps) {
      if (map.lineups.some((l) => l.teamId === teamId)) continue;
      await prisma.lineup.create({
        data: {
          matchMapId: map.id,
          teamId,
          slots: { create: players.map((playerId, slot) => ({ playerId, slot })) },
        },
      });
    }
  }
}

async function loadForMutation(matchId: string) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      tournament: {
        select: {
          slug: true,
          defaultFormat: true,
          captainsEnterScores: true,
          captainsPullScores: true,
          perfectFromBeatLeader: true,
        },
      },
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
    include: {
      attempts: true,
      poolMap: { select: { perfectAcc: true, leaderboard: { select: { predictedAcc: true } } } },
    },
  });

  let { a, b } = tallyMaps(maps, match.teamAId, match.teamBId, match);

  // A format decided on aggregate counts points, not maps: winning three maps
  // narrowly and losing one badly can lose the match.
  const format = parseFormat(match.format ?? match.tournament.defaultFormat);
  if (format.winCondition === 'AGGREGATE_MARGIN') {
    ({ a, b } = aggregateTotals(
      maps.map((m) => ({
        perfectAcc: perfectAccOf(m.poolMap, match.tournament.perfectFromBeatLeader).value,
        attempts: m.attempts,
      })),
      match.teamAId,
      match.teamBId,
      scoringOf(match),
    ));
  }

  await prisma.$transaction([
    prisma.match.update({
      where: { id: matchId },
      data: {
        state: 'COMPLETE',
        completedAt: new Date(),
        winnerId: a === b ? null : a > b ? match.teamAId : match.teamBId,
      },
    }),
    // A finished match's scores are final, map by map.
    prisma.matchMap.updateMany({ where: { matchId, scoresClosedAt: null }, data: { scoresClosedAt: new Date() } }),
    // A bracket match reports its winner to the bracket; a draw leaves the slot for an organiser.
    prisma.bracketNode.updateMany({ where: { matchId }, data: { winnerId: a === b ? null : a > b ? match.teamAId : match.teamBId } }),
  ]);

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

  await prisma.$transaction([
    prisma.match.update({
      where: { id: matchId },
      data: { state: 'PLAYING', completedAt: null, winnerId: null },
    }),
    // Its bracket slot is undecided again, and so is everything after it.
    prisma.bracketNode.updateMany({ where: { matchId }, data: { winnerId: null } }),
  ]);

  await matchChanged(match.tournament.slug, matchId);
}

// ---------------------------------------------------------------------------
//  Scores from BeatLeader
// ---------------------------------------------------------------------------

export interface PullReviewRun {
  id: number;
  source: 'RUN' | 'SCORE';
  endType: string;
  /** Unix seconds it ended. */
  timeset: number;
  /** Seconds into the song it ended. */
  time: number;
  score: number;
  accuracy: number;
}

export interface PullPlayer {
  playerId: string;
  playerName: string;
  teamNames: string[];
  status: 'SAVED' | 'KEPT' | 'CHECK' | 'WAITING';
  /** The run the pull would use, where it found one. */
  chosenId: number | null;
  candidates: PullReviewRun[];
  notes: string[];
}

export type PullOutcome =
  | { status: 'done'; matchMapId: string; attempt: number; players: PullPlayer[] }
  | { status: 'error'; error: string };

/** Load a match for a BeatLeader pull and check the caller may do one. */
async function authorisePull(matchId: string): Promise<{ slug: string; staff: boolean } | { error: string }> {
  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) return { error: 'Sign in first.' };
  if (
    !can(actor, 'PULL_SCORES', {
      captainsPullScores: match.tournament.captainsPullScores,
      matchTeamIds: [match.teamAId, match.teamBId],
    })
  ) {
    return { error: 'You cannot fill in scores for this match.' };
  }
  if (match.state === 'COMPLETE') return { error: 'This match is complete, so its scores are frozen. Reopen it to change them.' };
  return { slug: match.tournament.slug, staff: isStaff(actor) };
}

const CLOSED = 'Scores for this map are closed. An organiser can reopen them.';

/**
 * Maps are played in order: a map's scores can be filled in only once every
 * map before it has its scores closed. Organisers may go out of order - it is
 * their call when something has gone wrong - so this names the map in the way
 * for anyone else, and null for them.
 */
async function earlierMapOpen(matchId: string, matchMapId: string, staff: boolean): Promise<string | null> {
  if (staff) return null;
  const maps = await prisma.matchMap.findMany({
    where: { matchId },
    orderBy: { order: 'asc' },
    select: { id: true, order: true, isTiebreaker: true, scoresClosedAt: true, poolMap: { select: { leaderboard: { select: { map: { select: { name: true } } } } } } },
  });
  const target = maps.find((m) => m.id === matchMapId);
  if (!target) return null;
  // The tiebreaker comes after every other map, whatever its slot.
  const before = maps.filter((m) => m.id !== target.id && (target.isTiebreaker ? !m.isTiebreaker : !m.isTiebreaker && m.order < target.order));
  const open = before.find((m) => m.scoresClosedAt == null);
  return open
    ? `Maps are played in order: close the scores for ${open.isTiebreaker ? 'the tiebreaker' : `map ${open.order}`} (${open.poolMap.leaderboard.map.name}) first. An organiser can fill maps in out of order.`
    : null;
}

/**
 * Fill a map's scores in from BeatLeader. Safe to press at any time after the
 * song and as often as needed: whoever has a run from the go is saved, anyone
 * not finished yet is listed as waiting, and pressing again picks them up.
 * Runs that want a person's eye are listed to be chosen from, not saved.
 * Values rather than throws, so the reason reaches the screen.
 */
export async function pullMapScores(matchId: string, matchMapId: string): Promise<PullOutcome> {
  const allowed = await authorisePull(matchId);
  if ('error' in allowed) return { status: 'error', error: allowed.error };
  const target = await loadPullTarget(matchId, matchMapId);
  if (!target) return { status: 'error', error: 'That map is not part of this match.' };
  if (target.closed) return { status: 'error', error: CLOSED };
  const outOfOrder = await earlierMapOpen(matchId, matchMapId, allowed.staff);
  if (outOfOrder) return { status: 'error', error: outOfOrder };
  if (target.players.size === 0) return { status: 'error', error: 'Set the lineups for this map first.' };

  let result;
  try {
    result = choose(target, await fetchRuns(target));
  } catch (err) {
    console.error('[pull] BeatLeader fetch failed:', err);
    return { status: 'error', error: 'BeatLeader did not answer. Try again in a moment, or enter the scores by hand.' };
  }

  const written = new Set(
    await writeRuns(
      target,
      result.picks.filter((p) => p.status === 'MATCHED').map((p) => ({ playerId: p.playerId, run: p.chosen! })),
    ),
  );
  if (written.size > 0) await matchChanged(allowed.slug, matchId);

  const teams = await prisma.team.findMany({
    where: { id: { in: [target.teamAId, target.teamBId] } },
    select: { id: true, name: true },
  });
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  return {
    status: 'done',
    matchMapId,
    attempt: target.attempt,
    players: result.picks.map((pick) => ({
      playerId: pick.playerId,
      playerName: pick.playerName,
      teamNames: target.lineups
        .filter((l) => l.playerIds.includes(pick.playerId))
        .map((l) => teamName.get(l.teamId) ?? ''),
      status:
        pick.status === 'MATCHED'
          ? written.has(pick.playerId)
            ? 'SAVED'
            : 'KEPT'
          : pick.status,
      chosenId: pick.chosen?.id ?? null,
      candidates: pick.candidates.map((run) => ({
        id: run.id,
        source: run.source,
        endType: run.endType,
        timeset: run.timeset,
        time: run.time,
        score: Math.round(run.baseScore),
        accuracy: target.maxScore > 0 ? Math.min(1, run.baseScore / target.maxScore) : run.accuracy,
      })),
      notes: pick.status === 'MATCHED' && !written.has(pick.playerId)
        ? ['Their score was typed in by hand, so it was left as it is.', ...pick.notes]
        : pick.notes,
    })),
  };
}

/**
 * Save runs someone chose by hand from a pull's list. Each is fetched from
 * BeatLeader again by its id, so what is written is exactly what BeatLeader
 * recorded.
 */
export async function savePulledRuns(
  matchId: string,
  matchMapId: string,
  choices: ReadonlyArray<{ playerId: string; runId: number }>,
): Promise<{ error?: string; count?: number }> {
  const allowed = await authorisePull(matchId);
  if ('error' in allowed) return { error: allowed.error };
  const target = await loadPullTarget(matchId, matchMapId);
  if (!target) return { error: 'That map is not part of this match.' };
  if (target.closed) return { error: CLOSED };
  const outOfOrder = await earlierMapOpen(matchId, matchMapId, allowed.staff);
  if (outOfOrder) return { error: outOfOrder };

  let runs;
  try {
    runs = await fetchRuns(target);
  } catch (err) {
    console.error('[pull] BeatLeader fetch failed:', err);
    return { error: 'BeatLeader did not answer. Try again in a moment.' };
  }
  const chosen = [];
  for (const choice of choices) {
    if (!target.players.has(choice.playerId)) continue;
    const run = runs.find((r) => r.playerId === choice.playerId)?.runs.find((r) => r.id === choice.runId);
    if (!run) return { error: 'One of those runs is no longer on BeatLeader. Pull again.' };
    chosen.push({ playerId: choice.playerId, run });
  }
  const written = chosen.length ? await writeRuns(target, chosen) : [];
  await matchChanged(allowed.slug, matchId);
  return { count: written.length };
}

/**
 * Say a map's scores are final: no more pulling or typing until an organiser
 * reopens them. Anyone who may fill the scores in may close them.
 */
export async function closeMapScores(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const matchMapId = String(formData.get('matchMapId'));
  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  const context = {
    captainsPullScores: match.tournament.captainsPullScores,
    captainsEnterScores: match.tournament.captainsEnterScores,
    matchTeamIds: [match.teamAId, match.teamBId],
  };
  const mayFill =
    can(actor, 'PULL_SCORES', context) ||
    [match.teamAId, match.teamBId].some((teamId) => can(actor, 'ENTER_SCORE', { ...context, teamId }));
  if (!mayFill) throw new Error('You cannot close these scores.');
  await prisma.matchMap.updateMany({
    where: { id: matchMapId, matchId, scoresClosedAt: null },
    data: { scoresClosedAt: new Date() },
  });
  await matchChanged(match.tournament.slug, matchId);
}

/** Reopen a map's scores so they can be pulled or typed again. Organisers only. */
export async function reopenMapScores(formData: FormData): Promise<void> {
  const matchId = String(formData.get('matchId'));
  const matchMapId = String(formData.get('matchMapId'));
  const match = await loadForMutation(matchId);
  const actor = await getActor(match.tournamentId);
  if (!actor) throw new Error('Sign in first.');
  assertCan(actor, 'UNDO_ACTION');
  if (match.state === 'COMPLETE') failBack(`/t/${match.tournament.slug}/match/${matchId}`, 'Reopen the match first.');
  await prisma.matchMap.updateMany({ where: { id: matchMapId, matchId }, data: { scoresClosedAt: null } });
  await matchChanged(match.tournament.slug, matchId);
}

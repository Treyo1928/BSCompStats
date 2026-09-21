import type { ActionType, MatchFormat, PickBanActor } from './format.js';

/**
 * Pick/ban as a pure state machine over an append-only action log.
 *
 * The server replays the log to decide whose turn it is, so a captain cannot
 * pick out of turn, pick a banned map, or pick twice by double-clicking -
 * whatever their browser thinks the state is. Recomputing from the log also
 * makes organiser undo trivial: drop the last action and re-derive.
 */

export interface AppliedAction {
  seq: number;
  type: ActionType;
  teamId: string;
  poolMapId: string;
}

export interface PickBanContext {
  format: MatchFormat;
  /** Pickable maps. A DESIGNATED tiebreaker is excluded by the caller. */
  poolMapIds: readonly string[];
  coinWinnerTeamId: string;
  coinLoserTeamId: string;
  /** Pre-set tiebreaker, when the format designates one. */
  designatedTiebreakerId?: string | null;
  actions: readonly AppliedAction[];
}

export interface PendingStep {
  seq: number;
  type: ActionType;
  teamId: string;
  /** Maps this team may legally choose right now. */
  availableMapIds: string[];
}

export type PickBanErrorCode =
  | 'PICKBAN_COMPLETE'
  | 'NOT_YOUR_TURN'
  | 'MAP_NOT_IN_POOL'
  | 'MAP_ALREADY_USED'
  | 'POOL_TOO_SMALL';

export class PickBanError extends Error {
  constructor(
    readonly code: PickBanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PickBanError';
  }
}

/** Action log with undone entries dropped and order guaranteed. */
function liveActions(ctx: PickBanContext): AppliedAction[] {
  return [...ctx.actions].sort((a, b) => a.seq - b.seq);
}

function teamForActor(ctx: PickBanContext, actor: PickBanActor): string {
  return actor === 'COIN_WINNER' ? ctx.coinWinnerTeamId : ctx.coinLoserTeamId;
}

/** Maps still untouched by any pick or ban. */
export function remainingMapIds(ctx: PickBanContext): string[] {
  const used = new Set(liveActions(ctx).map((a) => a.poolMapId));
  if (ctx.designatedTiebreakerId) used.add(ctx.designatedTiebreakerId);
  return ctx.poolMapIds.filter((id) => !used.has(id));
}

/**
 * The step waiting to be taken, or null when pick/ban is finished.
 */
export function currentStep(ctx: PickBanContext): PendingStep | null {
  const taken = liveActions(ctx).length;
  const step = ctx.format.pickBanSequence[taken];
  if (!step) return null;

  return {
    seq: taken,
    type: step.action,
    teamId: teamForActor(ctx, step.actor),
    availableMapIds: remainingMapIds(ctx),
  };
}

export function isComplete(ctx: PickBanContext): boolean {
  return currentStep(ctx) === null;
}

/**
 * Validate one team's choice. Returns the action to append; throws a
 * PickBanError the API layer turns into a 4xx with a usable message.
 */
export function prepareAction(
  ctx: PickBanContext,
  input: { teamId: string; poolMapId: string },
): AppliedAction {
  const step = currentStep(ctx);
  if (!step) {
    throw new PickBanError('PICKBAN_COMPLETE', 'Every pick and ban has already been made.');
  }
  if (step.teamId !== input.teamId) {
    throw new PickBanError(
      'NOT_YOUR_TURN',
      `It is not this team's turn - the next ${step.type.toLowerCase()} belongs to the other team.`,
    );
  }
  if (!ctx.poolMapIds.includes(input.poolMapId)) {
    throw new PickBanError('MAP_NOT_IN_POOL', 'That map is not in this match\'s pool.');
  }
  if (!step.availableMapIds.includes(input.poolMapId)) {
    throw new PickBanError(
      'MAP_ALREADY_USED',
      'That map has already been picked or banned.',
    );
  }

  return {
    seq: step.seq,
    type: step.type,
    teamId: input.teamId,
    poolMapId: input.poolMapId,
  };
}

export interface MatchMapPlan {
  order: number;
  poolMapId: string;
  isTiebreaker: boolean;
  /** Null for the tiebreaker, which nobody picks. */
  pickedByTeamId: string | null;
}

/**
 * The maps that will actually be played, in order.
 *
 * With LAST_REMAINING the decider is whatever survived pick/ban - which is how
 * the MSU pool of 7 ends up as 4 played maps, 2 bans and Girls' Night as the
 * tiebreaker without anyone nominating it.
 */
export function resolveMapPlan(ctx: PickBanContext): MatchMapPlan[] {
  const picks = liveActions(ctx).filter((a) => a.type === 'PICK');

  const plan: MatchMapPlan[] = picks.map((action, index) => ({
    order: index + 1,
    poolMapId: action.poolMapId,
    isTiebreaker: false,
    pickedByTeamId: action.teamId,
  }));

  if (!isComplete(ctx) || ctx.format.tiebreaker === 'NONE') return plan;

  const tiebreakerId =
    ctx.format.tiebreaker === 'DESIGNATED'
      ? (ctx.designatedTiebreakerId ?? null)
      : (remainingMapIds(ctx)[0] ?? null);

  if (tiebreakerId) {
    plan.push({
      order: plan.length + 1,
      poolMapId: tiebreakerId,
      isTiebreaker: true,
      pickedByTeamId: null,
    });
  }

  return plan;
}

/**
 * Check a pool is big enough before a match starts, so a captain never hits a
 * dead end halfway through pick/ban.
 */
export function assertPoolIsBigEnough(ctx: PickBanContext): void {
  const needed =
    ctx.format.pickBanSequence.length +
    (ctx.format.tiebreaker === 'LAST_REMAINING' ? 1 : 0);

  if (ctx.poolMapIds.length < needed) {
    throw new PickBanError(
      'POOL_TOO_SMALL',
      `This format needs at least ${needed} pickable maps but the pool has ${ctx.poolMapIds.length}.`,
    );
  }
}

/** Human-readable log for the match timeline. */
export function describeActions(
  ctx: PickBanContext,
  teamName: (id: string) => string,
  mapName: (poolMapId: string) => string,
): string[] {
  return liveActions(ctx).map(
    (a) =>
      `${teamName(a.teamId)} ${a.type === 'PICK' ? 'picked' : 'banned'} ${mapName(a.poolMapId)}`,
  );
}

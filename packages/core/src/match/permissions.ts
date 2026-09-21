/**
 * Who may do what.
 *
 * Kept here, next to the rules it guards, rather than scattered through route
 * handlers - an authorisation check that lives in one place is one you can
 * actually read and test.
 *
 * The override rule is worth spelling out. An illegal lineup blocks submission,
 * but an organiser can force it through, because the real scrim data contains a
 * match that needs it: team White fielded three players against a format that
 * requires four distinct duos, so no legal lineup existed and the match still
 * happened. Crucially, a captain who is *also* an organiser or admin can
 * override their own lineup - which is the normal case for friendly scrims,
 * where the person running the event is playing in it. Every override is
 * recorded with who performed it.
 */

export type GlobalRole = 'USER' | 'ADMIN';

export type TournamentRole =
  | 'OWNER'
  | 'ORGANIZER'
  | 'CAPTAIN'
  | 'PLAYER'
  | 'VIEWER';

export interface Actor {
  userId: string;
  globalRole: GlobalRole;
  /** Their role in the tournament in question, if any. */
  tournamentRole?: TournamentRole | null;
  /** The team they captain, when tournamentRole is CAPTAIN. */
  captainOfTeamId?: string | null;
}

export type Action =
  | 'VIEW'
  | 'MANAGE_TOURNAMENT'
  | 'MANAGE_TEAMS'
  | 'IMPORT_POOL'
  | 'CREATE_MATCH'
  | 'MAKE_PICK_BAN'
  | 'SET_LINEUP'
  | 'ENTER_SCORE'
  | 'OVERRIDE_RULES'
  | 'ACT_FOR_OTHERS'
  | 'UNDO_ACTION';

export interface ActionContext {
  /** The team the action concerns, for team-scoped actions. */
  teamId?: string | null;
  /** True when the tournament is public. */
  isPublic?: boolean;
}

/** Roles that administer a tournament rather than compete in it. */
const STAFF: ReadonlySet<TournamentRole> = new Set<TournamentRole>(['OWNER', 'ORGANIZER']);

export function isStaff(actor: Actor): boolean {
  return (
    actor.globalRole === 'ADMIN' ||
    (actor.tournamentRole != null && STAFF.has(actor.tournamentRole))
  );
}

/** Whether this actor speaks for the given team. */
export function isCaptainOf(actor: Actor, teamId: string | null | undefined): boolean {
  if (!teamId) return false;
  return actor.tournamentRole === 'CAPTAIN' && actor.captainOfTeamId === teamId;
}

export function can(actor: Actor, action: Action, context: ActionContext = {}): boolean {
  // A site admin can do anything. Self-hosted instances are run by the people
  // playing in them; pretending otherwise just adds friction.
  if (actor.globalRole === 'ADMIN') return true;

  const staff = isStaff(actor);

  switch (action) {
    case 'VIEW':
      return context.isPublic !== false || actor.tournamentRole != null;

    case 'MANAGE_TOURNAMENT':
    case 'MANAGE_TEAMS':
    case 'IMPORT_POOL':
    case 'CREATE_MATCH':
    case 'ACT_FOR_OTHERS':
    case 'UNDO_ACTION':
    case 'OVERRIDE_RULES':
      // Note there is no captain branch here: a captain who may override is one
      // who also holds a staff role, and that is caught by `staff` above.
      return staff;

    case 'ENTER_SCORE':
      // Scores normally arrive from BeatLeader; typing one in is a staff action.
      return staff;

    case 'MAKE_PICK_BAN':
    case 'SET_LINEUP':
      return staff || isCaptainOf(actor, context.teamId);

    default:
      return false;
  }
}

/** Throwing variant for route handlers. */
export class ForbiddenError extends Error {
  constructor(readonly action: Action) {
    super(`Not allowed to ${action.toLowerCase().replace(/_/g, ' ')}.`);
    this.name = 'ForbiddenError';
  }
}

export function assertCan(
  actor: Actor,
  action: Action,
  context: ActionContext = {},
): void {
  if (!can(actor, action, context)) throw new ForbiddenError(action);
}

/**
 * Whether submitting a lineup that breaks the rules should be permitted, and
 * how it must be recorded.
 */
export function canOverrideViolations(actor: Actor): boolean {
  return can(actor, 'OVERRIDE_RULES');
}

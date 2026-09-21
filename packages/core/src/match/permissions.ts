/**
 * Who may do what.
 *
 * Kept here, next to the rules it guards, rather than scattered through route
 * handlers - an authorisation check that lives in one place is one you can
 * actually read and test.
 *
 * The override rule is worth spelling out. An illegal lineup blocks submission,
 * but it can be forced through - by an organiser for either team, or by a
 * captain for their own, with what was overridden kept on the lineup for the
 * organisers to see. Originally only an organiser could force it through, because the real scrim data contains a
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
  /**
   * Teams they captain. Independent of tournamentRole on purpose: the person
   * running a scrim is usually also captaining a side in it.
   */
  captainOfTeamIds?: readonly string[];
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
  /** Tournament setting: captains may enter their own team's scores. */
  captainsEnterScores?: boolean;
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
  return actor.captainOfTeamIds?.includes(teamId) ?? false;
}

export function can(actor: Actor, action: Action, context: ActionContext = {}): boolean {
  // A site admin can do anything. Self-hosted instances are run by the people
  // playing in them; pretending otherwise just adds friction.
  if (actor.globalRole === 'ADMIN') return true;

  const staff = isStaff(actor);

  switch (action) {
    case 'VIEW':
      // Fails closed: a caller that forgets to say whether the tournament is
      // public gets the private answer, not an open door.
      return context.isPublic === true || actor.tournamentRole != null;

    case 'MANAGE_TOURNAMENT':
    case 'MANAGE_TEAMS':
    case 'IMPORT_POOL':
    case 'CREATE_MATCH':
    case 'ACT_FOR_OTHERS':
    case 'UNDO_ACTION':
      // Note there is no captain branch here: a captain who may override is one
      // who also holds a staff role, and that is caught by `staff` above.
      return staff;

    case 'ENTER_SCORE':
      // BeatLeader only knows a player's best ever run, not the one they just
      // played, so match scores are typed in. Staff always may; captains only
      // for their own team, and only where the tournament allows it.
      return (
        staff || (context.captainsEnterScores === true && isCaptainOf(actor, context.teamId))
      );

    case 'MAKE_PICK_BAN':
    case 'SET_LINEUP':
      return staff || isCaptainOf(actor, context.teamId);

    case 'OVERRIDE_RULES':
      // A captain may knowingly field a lineup that breaks the rules for their
      // own team. Whether that is acceptable is for the people running the
      // tournament to judge afterwards - the override is recorded for them -
      // not for the software to forbid on the night.
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
export function canOverrideViolations(actor: Actor, teamId?: string | null): boolean {
  return can(actor, 'OVERRIDE_RULES', { teamId });
}

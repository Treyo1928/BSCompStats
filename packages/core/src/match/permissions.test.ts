import { describe, it, expect } from 'vitest';
import { can, canOverrideViolations, assertCan, ForbiddenError, type Actor } from './permissions.js';

const admin: Actor = { userId: 'u1', globalRole: 'ADMIN' };
const organizer: Actor = { userId: 'u2', globalRole: 'USER', tournamentRole: 'ORGANIZER' };
const captain: Actor = { userId: 'u3', globalRole: 'USER', tournamentRole: 'CAPTAIN', captainOfTeamIds: ['maroon'] };
const playerCaptainWhoRunsTheEvent: Actor = { userId: 'u4', globalRole: 'ADMIN', tournamentRole: 'CAPTAIN', captainOfTeamIds: ['white'] };
const player: Actor = { userId: 'u5', globalRole: 'USER', tournamentRole: 'PLAYER' };
const stranger: Actor = { userId: 'u6', globalRole: 'USER' };

describe('pick/ban and lineups', () => {
  it('lets a captain act only for their own team', () => {
    expect(can(captain, 'MAKE_PICK_BAN', { teamId: 'maroon' })).toBe(true);
    expect(can(captain, 'MAKE_PICK_BAN', { teamId: 'white' })).toBe(false);
    expect(can(captain, 'SET_LINEUP', { teamId: 'maroon' })).toBe(true);
    expect(can(captain, 'SET_LINEUP', { teamId: 'white' })).toBe(false);
  });

  it('lets organisers act for either team', () => {
    expect(can(organizer, 'MAKE_PICK_BAN', { teamId: 'maroon' })).toBe(true);
    expect(can(organizer, 'MAKE_PICK_BAN', { teamId: 'white' })).toBe(true);
    expect(can(organizer, 'ACT_FOR_OTHERS')).toBe(true);
  });

  it('keeps ordinary players and strangers out', () => {
    expect(can(player, 'MAKE_PICK_BAN', { teamId: 'maroon' })).toBe(false);
    expect(can(stranger, 'SET_LINEUP', { teamId: 'maroon' })).toBe(false);
    expect(can(stranger, 'IMPORT_POOL')).toBe(false);
  });
});

describe('overriding an illegal lineup', () => {
  it('is allowed for admins and organisers', () => {
    expect(canOverrideViolations(admin)).toBe(true);
    expect(canOverrideViolations(organizer)).toBe(true);
  });

  it('is allowed for a captain who also runs the event', () => {
    // The friendly-scrim case: the person captaining is the person organising.
    // They must be able to force their own lineup through without finding
    // somebody else to click it.
    expect(canOverrideViolations(playerCaptainWhoRunsTheEvent)).toBe(true);
    expect(can(playerCaptainWhoRunsTheEvent, 'SET_LINEUP', { teamId: 'white' })).toBe(true);
  });

  it('is allowed for a captain, but only for their own team', () => {
    // Whether breaking a rule was acceptable is for the organisers to judge
    // afterwards; the software records it rather than forbidding it.
    expect(canOverrideViolations(captain, 'maroon')).toBe(true);
    expect(canOverrideViolations(captain, 'white')).toBe(false);
    expect(canOverrideViolations(captain)).toBe(false);
    expect(canOverrideViolations(player, 'maroon')).toBe(false);
  });
});

describe('assertCan', () => {
  it('throws a usable error', () => {
    expect(() => assertCan(stranger, 'IMPORT_POOL')).toThrow(ForbiddenError);
    try {
      assertCan(stranger, 'IMPORT_POOL');
    } catch (err) {
      expect((err as Error).message).toBe('Not allowed to import pool.');
    }
  });

  it('does not throw when permitted', () => {
    expect(() => assertCan(organizer, 'IMPORT_POOL')).not.toThrow();
  });
});

describe('viewing', () => {
  it('allows anyone into a public tournament and members into a private one', () => {
    expect(can(stranger, 'VIEW', { isPublic: true })).toBe(true);
    expect(can(stranger, 'VIEW', { isPublic: false })).toBe(false);
    expect(can(player, 'VIEW', { isPublic: false })).toBe(true);
  });
});

describe('match set-up and BeatLeader scores', () => {
  const captain = { userId: 'u', globalRole: 'USER' as const, tournamentRole: 'CAPTAIN' as const, captainOfTeamIds: ['red'] };
  const organiser = { userId: 'o', globalRole: 'USER' as const, tournamentRole: 'ORGANIZER' as const };

  it('lets a captain create a match for their own team only where the tournament allows it', () => {
    expect(can(captain, 'CREATE_MATCH', { teamId: 'red' })).toBe(false);
    expect(can(captain, 'CREATE_MATCH', { teamId: 'red', captainsCreateMatches: true })).toBe(true);
    expect(can(captain, 'CREATE_MATCH', { teamId: 'blue', captainsCreateMatches: true })).toBe(false);
    expect(can(captain, 'CREATE_MATCH', { captainsCreateMatches: true })).toBe(true);
    expect(can(organiser, 'CREATE_MATCH')).toBe(true);
  });

  it('lets either captain in a match pull its scores where the tournament allows it', () => {
    expect(can(captain, 'PULL_SCORES', { matchTeamIds: ['red', 'blue'] })).toBe(false);
    expect(can(captain, 'PULL_SCORES', { matchTeamIds: ['red', 'blue'], captainsPullScores: true })).toBe(true);
    expect(can(captain, 'PULL_SCORES', { matchTeamIds: ['green', 'blue'], captainsPullScores: true })).toBe(false);
    expect(can(organiser, 'PULL_SCORES', { matchTeamIds: ['green', 'blue'] })).toBe(true);
  });
});

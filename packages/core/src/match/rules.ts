import type { MatchFormat } from './format.js';

/**
 * Lineup legality.
 *
 * The rule captains trip over is the duo rule: with a four-player roster and
 * four maps of two players, every one of the six possible pairs may be used at
 * most once, and the tiebreaker is exempt. The MSU scrim is exactly this -
 * Maroon fielded Erin+Will, Erin+Trey, Will+Mia, Trey+Mia across the four
 * maps, then Erin+Mia on the tiebreaker.
 *
 * Validation runs on every keystroke in the lineup builder, so it has to cope
 * with half-finished input: an incomplete map is a WARNING (you are not done
 * yet), an over-filled or illegal one is an ERROR (you cannot submit this).
 */

export type Severity = 'ERROR' | 'WARNING';

export interface LineupInput {
  /** Identifies the map within the match; echoed back on violations. */
  matchMapId: string;
  /** Human label for messages, e.g. "Map 2 - CASINO RAVE". */
  mapLabel: string;
  isTiebreaker: boolean;
  /** Player ids chosen so far. May be short while the captain is still picking. */
  playerIds: string[];
}

export interface Violation {
  code: ViolationCode;
  severity: Severity;
  message: string;
  /** Maps the violation touches - both maps, for a repeated duo. */
  matchMapIds: string[];
  playerIds: string[];
}

export type ViolationCode =
  | 'DUPLICATE_PLAYER_IN_MAP'
  | 'TOO_MANY_PLAYERS'
  | 'INCOMPLETE_LINEUP'
  | 'NOT_ON_ROSTER'
  | 'DUPLICATE_DUO'
  | 'TOO_FEW_APPEARANCES'
  | 'TOO_MANY_APPEARANCES';

export interface ValidationResult {
  violations: Violation[];
  /** True when nothing blocks submission. Warnings do not block. */
  valid: boolean;
  /** Every lineup has exactly playersPerMap players. */
  complete: boolean;
  /** Appearance count per player id, tiebreaker excluded where exempt. */
  appearances: Record<string, number>;
  /** Duos used, keyed by sorted pair, with the maps each was used on. */
  duos: Record<string, string[]>;
}

/** Stable key for an unordered group of players. */
export function duoKey(playerIds: readonly string[]): string {
  return [...playerIds].sort().join('|');
}

export interface ValidateOptions {
  format: MatchFormat;
  lineups: readonly LineupInput[];
  /** Player ids eligible to play for this team. */
  roster: readonly string[];
  /** Resolves a player id to a name for readable messages. */
  playerName?: (id: string) => string;
}

export function validateLineups(options: ValidateOptions): ValidationResult {
  const { format, lineups, roster } = options;
  const name = options.playerName ?? ((id: string) => id);
  const rosterSet = new Set(roster);
  const rules = format.rules;

  const violations: Violation[] = [];
  const appearances: Record<string, number> = {};
  const duos: Record<string, string[]> = {};
  const duoLabels = new Map<string, string[]>();

  let complete = true;

  for (const lineup of lineups) {
    const ids = lineup.playerIds;

    // --- Within one map -----------------------------------------------------
    if (rules.noDuplicateWithinMap) {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          violations.push({
            code: 'DUPLICATE_PLAYER_IN_MAP',
            severity: 'ERROR',
            message: `${name(id)} is listed twice on ${lineup.mapLabel}.`,
            matchMapIds: [lineup.matchMapId],
            playerIds: [id],
          });
        }
        seen.add(id);
      }
    }

    for (const id of ids) {
      if (!rosterSet.has(id)) {
        violations.push({
          code: 'NOT_ON_ROSTER',
          severity: 'ERROR',
          message: `${name(id)} is not on this team's roster.`,
          matchMapIds: [lineup.matchMapId],
          playerIds: [id],
        });
      }
    }

    if (ids.length > format.playersPerMap) {
      violations.push({
        code: 'TOO_MANY_PLAYERS',
        severity: 'ERROR',
        message: `${lineup.mapLabel} has ${ids.length} players; the format allows ${format.playersPerMap}.`,
        matchMapIds: [lineup.matchMapId],
        playerIds: ids,
      });
    } else if (ids.length < format.playersPerMap) {
      complete = false;
      violations.push({
        code: 'INCOMPLETE_LINEUP',
        severity: 'WARNING',
        message: `${lineup.mapLabel} needs ${format.playersPerMap - ids.length} more player(s).`,
        matchMapIds: [lineup.matchMapId],
        playerIds: ids,
      });
    }

    // --- Across maps --------------------------------------------------------
    const countsTowardsDuos = !(lineup.isTiebreaker && rules.tiebreakerExemptFromDuos);
    const countsTowardsAppearances = countsTowardsDuos;

    if (countsTowardsAppearances) {
      for (const id of new Set(ids)) {
        appearances[id] = (appearances[id] ?? 0) + 1;
      }
    }

    // A duo only exists once the map is fully staffed - a half-filled lineup
    // must not raise a duo clash against a pair the captain has not chosen yet.
    if (
      rules.uniqueDuos &&
      countsTowardsDuos &&
      ids.length === format.playersPerMap &&
      format.playersPerMap > 1
    ) {
      const key = duoKey(ids);
      const previous = duos[key];

      if (previous) {
        const names = [...ids].sort().map(name).join(' + ');
        violations.push({
          code: 'DUPLICATE_DUO',
          severity: 'ERROR',
          message:
            `${names} already played together on ${(duoLabels.get(key) ?? []).join(', ')}. ` +
            `Each pairing may only be used once.`,
          matchMapIds: [...previous, lineup.matchMapId],
          playerIds: [...ids],
        });
        previous.push(lineup.matchMapId);
        duoLabels.get(key)?.push(lineup.mapLabel);
      } else {
        duos[key] = [lineup.matchMapId];
        duoLabels.set(key, [lineup.mapLabel]);
      }
    }
  }

  // --- Appearance bounds ----------------------------------------------------
  // Only meaningful once every lineup is filled; before that, a player with too
  // few appearances is simply a captain who has not finished.
  if (rules.maxAppearances != null) {
    for (const [id, count] of Object.entries(appearances)) {
      if (count > rules.maxAppearances) {
        violations.push({
          code: 'TOO_MANY_APPEARANCES',
          severity: 'ERROR',
          message: `${name(id)} is playing ${count} maps; the limit is ${rules.maxAppearances}.`,
          matchMapIds: [],
          playerIds: [id],
        });
      }
    }
  }

  if (complete && rules.minAppearances != null) {
    for (const id of roster) {
      const count = appearances[id] ?? 0;
      if (count < rules.minAppearances) {
        violations.push({
          code: 'TOO_FEW_APPEARANCES',
          severity: 'ERROR',
          message: `${name(id)} is only playing ${count} map(s); each player must play at least ${rules.minAppearances}.`,
          matchMapIds: [],
          playerIds: [id],
        });
      }
    }
  }

  return {
    violations,
    valid: !violations.some((v) => v.severity === 'ERROR'),
    complete,
    appearances,
    duos,
  };
}

/**
 * Which players can still be added to `targetMapId` without creating an error.
 * Drives the lineup builder's dropdown, so a captain is steered away from an
 * illegal pick rather than only told off after making it.
 */
export function legalAdditions(
  options: ValidateOptions & { targetMapId: string },
): { playerId: string; legal: boolean; reason?: string }[] {
  const { format, lineups, roster, targetMapId } = options;
  const name = options.playerName ?? ((id: string) => id);
  const target = lineups.find((l) => l.matchMapId === targetMapId);
  if (!target) return roster.map((playerId) => ({ playerId, legal: true }));

  return roster.map((playerId) => {
    if (target.playerIds.includes(playerId)) {
      return { playerId, legal: false, reason: 'Already on this map' };
    }

    const candidate: LineupInput[] = lineups.map((l) =>
      l.matchMapId === targetMapId
        ? { ...l, playerIds: [...l.playerIds, playerId] }
        : l,
    );

    const result = validateLineups({ ...options, lineups: candidate });
    const blocking = result.violations.find(
      (v) => v.severity === 'ERROR' && v.playerIds.includes(playerId),
    );

    if (!blocking) return { playerId, legal: true };

    return {
      playerId,
      legal: false,
      reason:
        blocking.code === 'DUPLICATE_DUO'
          ? `Would repeat a duo with ${target.playerIds.map(name).join(', ')}`
          : blocking.message,
    };
  });
}

import { z } from 'zod';

/**
 * Who a pick/ban step belongs to. Sequences are written relative to the coin
 * flip rather than to a specific team, so one format serves every match.
 */
export const pickBanActorSchema = z.enum(['COIN_WINNER', 'COIN_LOSER']);
/** Which side of the coin flip a pick/ban step belongs to. */
export type PickBanActor = z.infer<typeof pickBanActorSchema>;

export const actionTypeSchema = z.enum(['PICK', 'BAN']);
export type ActionType = z.infer<typeof actionTypeSchema>;

export const pickBanStepSchema = z.object({
  actor: pickBanActorSchema,
  action: actionTypeSchema,
});
export type PickBanStep = z.infer<typeof pickBanStepSchema>;

export const tiebreakerModeSchema = z.enum([
  /** Whatever map is left once every pick and ban is spent. */
  'LAST_REMAINING',
  /** A map flagged isTiebreaker in the pool, set aside up front. */
  'DESIGNATED',
  /** No tiebreaker at all. */
  'NONE',
]);
export type TiebreakerMode = z.infer<typeof tiebreakerModeSchema>;

export const winConditionSchema = z.enum([
  /** Most maps won, each map decided on combined team score. */
  'MAP_WINS',
  /** Largest total score across every map. */
  'AGGREGATE_MARGIN',
]);
export type WinCondition = z.infer<typeof winConditionSchema>;

export const matchRulesSchema = z.object({
  /**
   * No unordered pair of players may play together more than once. This is the
   * rule captains get wrong most often, so it is validated live.
   */
  uniqueDuos: z.boolean().default(true),
  /** The tiebreaker does not count towards the duo rule. */
  tiebreakerExemptFromDuos: z.boolean().default(true),
  /** Per-player appearance bounds across non-tiebreaker maps. Null = unbounded. */
  minAppearances: z.number().int().nonnegative().nullable().default(null),
  maxAppearances: z.number().int().positive().nullable().default(null),
  /** A player may not appear twice on the same map. */
  noDuplicateWithinMap: z.boolean().default(true),
  /**
   * Repeated pairings a roster is allowed because it is too small to avoid
   * them. Worked out by `rulesForRoster`, not something a format sets: three
   * players make three duos, so four maps force one repeat.
   */
  duoRepeatsAllowed: z.number().int().nonnegative().default(0),
  /**
   * How many times a team may call for a map to be replayed in one match.
   * Both teams play the map again and each player's best run counts.
   */
  replaysPerTeam: z.number().int().nonnegative().default(1),
});
export type MatchRules = z.infer<typeof matchRulesSchema>;

export const matchFormatSchema = z.object({
  name: z.string().default('Standard 2v2 duos'),
  /** Players each team fields per map. 2 in the MSU format. */
  playersPerMap: z.number().int().positive().default(2),
  /** Expected roster size. Used for guidance, not enforced. */
  rosterSize: z.number().int().positive().default(4),
  pickBanSequence: z.array(pickBanStepSchema).default([]),
  tiebreaker: tiebreakerModeSchema.default('LAST_REMAINING'),
  winCondition: winConditionSchema.default('MAP_WINS'),
  rules: matchRulesSchema.default({}),
});
export type MatchFormat = z.infer<typeof matchFormatSchema>;

/**
 * The format the MSU scrim sheet encodes, reproduced exactly:
 *
 *   coin-flip winner picks, loser picks, loser bans, winner bans,
 *   loser picks, winner picks - and the one map nobody touched is the
 *   tiebreaker.
 *
 * With a 7-map pool that spends 4 picks + 2 bans and leaves exactly one map,
 * which is how the sheet ends up with 4 maps plus Girls' Night as the decider.
 */
export const MSU_DUOS_FORMAT: MatchFormat = matchFormatSchema.parse({
  name: 'MSU duos (4 maps + tiebreaker)',
  playersPerMap: 2,
  rosterSize: 4,
  pickBanSequence: [
    { actor: 'COIN_WINNER', action: 'PICK' },
    { actor: 'COIN_LOSER', action: 'PICK' },
    { actor: 'COIN_LOSER', action: 'BAN' },
    { actor: 'COIN_WINNER', action: 'BAN' },
    { actor: 'COIN_LOSER', action: 'PICK' },
    { actor: 'COIN_WINNER', action: 'PICK' },
  ],
  tiebreaker: 'LAST_REMAINING',
  winCondition: 'MAP_WINS',
  rules: {
    uniqueDuos: true,
    tiebreakerExemptFromDuos: true,
    // 4 maps x 2 slots / 4 players = everyone plays exactly twice.
    minAppearances: 2,
    maxAppearances: 2,
    noDuplicateWithinMap: true,
  },
});

/** Format presets offered when creating a tournament. */
export const FORMAT_PRESETS: Record<string, MatchFormat> = {
  msuDuos: MSU_DUOS_FORMAT,
  soloBo5: matchFormatSchema.parse({
    name: 'Solo best-of-5',
    playersPerMap: 1,
    rosterSize: 1,
    pickBanSequence: [
      { actor: 'COIN_WINNER', action: 'BAN' },
      { actor: 'COIN_LOSER', action: 'BAN' },
      { actor: 'COIN_WINNER', action: 'PICK' },
      { actor: 'COIN_LOSER', action: 'PICK' },
      { actor: 'COIN_WINNER', action: 'PICK' },
      { actor: 'COIN_LOSER', action: 'PICK' },
    ],
    tiebreaker: 'LAST_REMAINING',
    winCondition: 'MAP_WINS',
    rules: { uniqueDuos: false, tiebreakerExemptFromDuos: true, noDuplicateWithinMap: true },
  }),
  teamAggregate: matchFormatSchema.parse({
    name: 'Team aggregate (no bans)',
    playersPerMap: 3,
    rosterSize: 5,
    pickBanSequence: [
      { actor: 'COIN_WINNER', action: 'PICK' },
      { actor: 'COIN_LOSER', action: 'PICK' },
      { actor: 'COIN_WINNER', action: 'PICK' },
      { actor: 'COIN_LOSER', action: 'PICK' },
    ],
    tiebreaker: 'DESIGNATED',
    winCondition: 'AGGREGATE_MARGIN',
    rules: { uniqueDuos: false, tiebreakerExemptFromDuos: true, noDuplicateWithinMap: true },
  }),
};

export function parseFormat(raw: unknown): MatchFormat {
  if (raw == null) return MSU_DUOS_FORMAT;
  return matchFormatSchema.parse(raw);
}

/**
 * The format's rules as they apply to one roster.
 *
 * A format's rules are written for the roster it expects - four players across
 * four duo maps, everyone playing exactly twice, no pairing repeated. A team
 * that turns up with six cannot all play twice; one with three cannot avoid
 * repeating a pairing or playing someone a third time; one with two fields the
 * same duo on every map. None of that is a captain breaking a rule. So each
 * limit is relaxed exactly as far as the roster forces it, and no further:
 *
 *   minimum appearances  down to what the slots allow everyone
 *   maximum appearances  up to what is needed to fill the slots
 *   unique pairings      repeats allowed only for the shortfall
 *
 * A lineup that breaks the rules beyond that is still flagged.
 */
export function rulesForRoster(
  format: MatchFormat,
  rosterSize: number,
  scoringMapCount: number,
): MatchFormat {
  if (rosterSize <= 0) return format;
  const k = format.playersPerMap;
  const slots = scoringMapCount * k;
  const rules = { ...format.rules };

  if (rules.minAppearances != null) {
    rules.minAppearances = Math.min(rules.minAppearances, Math.floor(slots / rosterSize));
  }
  if (rules.maxAppearances != null && rosterSize * rules.maxAppearances < slots) {
    rules.maxAppearances = Math.ceil(slots / rosterSize);
  }
  if (rules.uniqueDuos && k > 1) {
    // Distinct groups the roster can form: C(n, k).
    let groups = 1;
    for (let i = 0; i < k; i++) groups = (groups * (rosterSize - i)) / (i + 1);
    rules.duoRepeatsAllowed = Math.max(0, scoringMapCount - Math.round(Math.max(groups, 0)));
  }

  return { ...format, rules };
}

/** How many maps a format will produce, tiebreaker included. */
export function expectedMapCount(format: MatchFormat): number {
  const picks = format.pickBanSequence.filter((s) => s.action === 'PICK').length;
  return picks + (format.tiebreaker === 'NONE' ? 0 : 1);
}

/** Minimum pool size a format needs: every pick and ban, plus the tiebreaker. */
export function requiredPoolSize(format: MatchFormat): number {
  return format.pickBanSequence.length + (format.tiebreaker === 'NONE' ? 0 : 1);
}

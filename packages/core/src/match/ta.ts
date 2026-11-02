import { z } from 'zod';

/**
 * TournamentAssistant (TA) mode.
 *
 * On match night an organiser presses one button and TA starts the song for
 * every player in the lineups at the same moment. The site does not talk to TA
 * itself: a separate bridge program follows the match over the API, sees the
 * start request, does the TA side, and reports back what it sees - which is
 * what is checked here. The report is shown to everyone watching the match, so
 * it is held to a fixed shape and size rather than stored as whatever arrived.
 */

export const TA_PHASES = ['waiting', 'loading', 'playing', 'finished', 'error'] as const;
export type TaPhase = (typeof TA_PHASES)[number];

export const TA_PLAYER_STATES = ['loading', 'ready', 'playing', 'finished', 'failed', 'missing'] as const;
export type TaPlayerState = (typeof TA_PLAYER_STATES)[number];

/** A map is played by two lineups; this is generous for any format and still small. */
export const TA_MAX_PLAYERS = 32;
export const TA_MAX_MESSAGE = 500;

const isoDate = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO date, e.g. 2026-10-29T19:30:00Z');

export const taStatusSchema = z
  .object({
    phase: z.enum(TA_PHASES),
    message: z.string().max(TA_MAX_MESSAGE).optional(),
    players: z
      .array(
        z
          .object({
            playerId: z.string().min(1).max(64),
            state: z.enum(TA_PLAYER_STATES),
            score: z.number().int().min(0).max(100_000_000).optional(),
            accuracy: z.number().min(0).max(1).optional(),
          })
          .strict(),
      )
      .max(TA_MAX_PLAYERS)
      .optional(),
    startedAt: isoDate.optional(),
  })
  .strict();

/** What the bridge reports, as it arrives. */
export type TaStatusInput = z.infer<typeof taStatusSchema>;

/** What is stored and shown: the report, plus when the site received it. */
export interface TaStatus extends TaStatusInput {
  /** Server time the report arrived, ISO. */
  reportedAt: string;
}

/**
 * Check a bridge's report. Answers the status to store, or a message naming
 * the first thing wrong with it - the bridge's author is the one reading it.
 */
export function parseTaStatus(input: unknown, now: Date = new Date()): { status: TaStatus } | { error: string } {
  const parsed = taStatusSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? `status.${issue.path.join('.')}` : 'status';
    return { error: `${where}: ${issue.message}` };
  }
  const ids = (parsed.data.players ?? []).map((p) => p.playerId);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) return { error: `status.players: ${twice} is listed twice.` };
  return {
    status: {
      ...parsed.data,
      ...(parsed.data.startedAt ? { startedAt: new Date(parsed.data.startedAt).toISOString() } : {}),
      reportedAt: now.toISOString(),
    },
  };
}

/** A stored status read back, or null if it is not one (never written, or written by something else). */
export function readTaStatus(stored: unknown): TaStatus | null {
  if (!stored || typeof stored !== 'object') return null;
  const { reportedAt, ...rest } = stored as Record<string, unknown>;
  const parsed = taStatusSchema.safeParse(rest);
  if (!parsed.success || typeof reportedAt !== 'string') return null;
  return { ...parsed.data, reportedAt };
}

/**
 * The map to play next: the first one whose scores are still open, in playing
 * order - every other map by its slot, then the tiebreaker.
 */
export function nextMapToPlay<T extends { order: number; isTiebreaker: boolean; scoresClosed: boolean }>(
  maps: readonly T[],
): T | null {
  const inOrder = [...maps].sort(
    (a, b) => Number(a.isTiebreaker) - Number(b.isTiebreaker) || a.order - b.order,
  );
  return inOrder.find((m) => !m.scoresClosed) ?? null;
}

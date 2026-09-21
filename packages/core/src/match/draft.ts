/**
 * A captains' draft: two captains take turns choosing from a pool of players.
 *
 * Like pick/ban, whose turn it is is never stored. It is worked out from the
 * settings and how many picks have been made, so a stale tab and the server
 * cannot disagree about it.
 */

export type DraftSide = 'A' | 'B';

/**
 * ALTERNATE is A B A B. SNAKE is A B B A A B: whoever picks first gives the
 * next two away, which is the usual answer to first pick being worth the most.
 */
export type DraftOrder = 'ALTERNATE' | 'SNAKE';

/** BOTH is the shared last player of an odd pool - nobody's turn; it just happens. */
export type DraftSlot = DraftSide | 'BOTH';

export interface DraftSettings {
  order: DraftOrder;
  firstPick: DraftSide;
  /**
   * With an odd number to choose from, the last player left plays for both
   * sides rather than leaving one team a player up. Does nothing to an even
   * pool.
   */
  shareOdd: boolean;
}

const other = (side: DraftSide): DraftSide => (side === 'A' ? 'B' : 'A');

/** Who takes each pick. `poolSize` is the players to choose from - captains are not in it. */
export function draftSequence(settings: DraftSettings, poolSize: number): DraftSlot[] {
  const size = Math.max(0, Math.floor(poolSize));
  const shared = settings.shareOdd && size % 2 === 1;
  const turns = shared ? size - 1 : size;

  const slots: DraftSlot[] = [];
  for (let i = 0; i < turns; i++) {
    const firstPicks =
      settings.order === 'ALTERNATE'
        ? i % 2 === 0
        : // Snake runs in fours: first, other, other, first.
          i % 4 === 0 || i % 4 === 3;
    slots.push(firstPicks ? settings.firstPick : other(settings.firstPick));
  }
  if (shared) slots.push('BOTH');
  return slots;
}

/** Whose pick is next, or null once the pool is spent. */
export function nextDraftSlot(
  settings: DraftSettings,
  poolSize: number,
  picksMade: number,
): DraftSlot | null {
  return draftSequence(settings, poolSize)[picksMade] ?? null;
}

/** How many players each side ends up with, captain included. The shared player counts for both. */
export function draftTeamSizes(
  settings: DraftSettings,
  poolSize: number,
): { a: number; b: number } {
  const sizes = { a: 1, b: 1 };
  for (const slot of draftSequence(settings, poolSize)) {
    if (slot !== 'B') sizes.a++;
    if (slot !== 'A') sizes.b++;
  }
  return sizes;
}

export function parseDraftSettings(raw: {
  order?: string | null;
  firstPick?: string | null;
  shareOdd?: boolean | null;
}): DraftSettings {
  return {
    order: raw.order === 'ALTERNATE' ? 'ALTERNATE' : 'SNAKE',
    firstPick: raw.firstPick === 'B' ? 'B' : 'A',
    shareOdd: raw.shareOdd === true,
  };
}

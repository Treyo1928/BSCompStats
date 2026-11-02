import type { PlayOrder } from '@bscs/core';

/** How each play order reads in forms. */
export const PLAY_ORDER_NAMES: Record<PlayOrder, string> = {
  PICKS_FIRST: 'All picks and bans first',
  PLAY_EACH_PICK: 'Play each map as it is picked',
};

/** A play order from a form, or null for "use the tournament default". */
export function parsePlayOrder(raw: FormDataEntryValue | null | undefined): PlayOrder | null {
  return raw === 'PICKS_FIRST' || raw === 'PLAY_EACH_PICK' ? raw : null;
}

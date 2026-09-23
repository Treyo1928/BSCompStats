import type { BracketSlotView } from '@/server/brackets';

/**
 * Where each match of an elimination bracket is drawn, and the lines between.
 *
 * A match sits halfway between the two matches that feed it, so the lines
 * make the familiar tree. Byes are not drawn: a team with one appears in the
 * match it goes straight into, and the line to that match comes from wherever
 * its other side comes from. The layout is worked backwards from the last
 * match, so the first matches actually played sit top to bottom in bracket
 * order with nothing in between.
 */

export interface PlacedSlot {
  slot: BracketSlotView;
  /** Column, 0-based. */
  column: number;
  /** Vertical position in rows; a match fed by two others sits between them, so this can be x.5. */
  row: number;
}

export interface BracketLayout {
  placed: PlacedSlot[];
  /** From one match to the one its winner goes to. */
  lines: Array<{ from: PlacedSlot; to: PlacedSlot }>;
  columns: number;
  rows: number;
  /** A heading per column: "Round 1", "Semi-finals", "Final". */
  headings: string[];
}

/** Drawn at all: a match that is really played. */
export const shown = (slot: BracketSlotView) => !slot.passThrough && slot.state !== 'BYE' && slot.state !== 'VOID';

/**
 * Lay out the matches of the given sections (W, or L, with GF tacked on after
 * W). Round numbers become columns, skipping any round where nothing is drawn.
 */
export function layoutBracket(slots: readonly BracketSlotView[], sections: ReadonlyArray<'W' | 'L' | 'GF'>): BracketLayout {
  const inView = slots.filter((s) => (sections as readonly string[]).includes(s.section));
  const byKey = new Map(slots.map((s) => [s.key, s]));

  // Feeders a line is drawn from: earlier matches in the drawing whose winner comes here.
  // A bye in between is looked through.
  const feeders = (slot: BracketSlotView): BracketSlotView[] =>
    [slot.sources.a, slot.sources.b].flatMap((source) => {
      if (!('winnerOf' in source)) return [];
      const from = byKey.get(source.winnerOf);
      if (!from || !inView.includes(from)) return [];
      return shown(from) ? [from] : feeders(from);
    });

  // Columns: each drawn round in order, sections one after another.
  const columnKeys: string[] = [];
  for (const section of sections) {
    const rounds = [...new Set(inView.filter((s) => s.section === section && shown(s)).map((s) => s.round))].sort((a, b) => a - b);
    for (const round of rounds) columnKeys.push(`${section}${round}`);
  }
  const columnOf = (slot: BracketSlotView) => columnKeys.indexOf(`${slot.section}${slot.round}`);

  // Rows, worked back from the last match: leaves take the next free row,
  // everything else the middle of its feeders.
  const rowOf = new Map<string, number>();
  let nextLeaf = 0;
  const place = (slot: BracketSlotView): number => {
    const known = rowOf.get(slot.key);
    if (known != null) return known;
    const from = feeders(slot);
    const row = from.length === 0 ? nextLeaf++ : from.map(place).reduce((a, b) => a + b, 0) / from.length;
    rowOf.set(slot.key, row);
    return row;
  };
  // The roots: drawn matches nothing later in the drawing is fed by.
  const fedBy = new Set(inView.filter(shown).flatMap((s) => feeders(s).map((f) => f.key)));
  const roots = inView.filter((s) => shown(s) && !fedBy.has(s.key)).sort((a, b) => columnOf(b) - columnOf(a) || a.position - b.position);
  for (const root of roots) place(root);

  const placed: PlacedSlot[] = inView
    .filter(shown)
    .map((slot) => ({ slot, column: columnOf(slot), row: rowOf.get(slot.key) ?? 0 }));
  const placedBy = new Map(placed.map((p) => [p.slot.key, p]));
  const lines = placed.flatMap((to) => feeders(to.slot).map((f) => ({ from: placedBy.get(f.key)!, to })));

  const names = nameSlots(slots);
  const headings = columnKeys.map((key) => {
    const first = inView.find((s) => shown(s) && `${s.section}${s.round}` === key);
    return first ? names.rounds.get(key) ?? '' : '';
  });

  return {
    placed,
    lines,
    columns: columnKeys.length,
    rows: Math.max(1, nextLeaf),
    headings,
  };
}

/**
 * What a side not filled yet is waiting on: "Winner of R1 M2". Through a match
 * that is not really played, to the one that is - a team skipping a round is
 * waiting on whoever its real opponent comes from.
 */
export function describeSide(
  source: BracketSlotView['sources']['a'],
  byKey: ReadonlyMap<string, BracketSlotView>,
  seeds: ReadonlySet<number>,
  names: ReadonlyMap<string, string>,
): string {
  if ('seed' in source) return `Seed ${source.seed}`;
  const from = byKey.get('winnerOf' in source ? source.winnerOf : source.loserOf);
  if (!from) return '';
  if ('winnerOf' in source && !shown(from)) {
    const live = [from.sources.a, from.sources.b].find((side) => !deadSide(side, byKey, seeds));
    if (live) return describeSide(live, byKey, seeds, names);
  }
  const name = names.get(from.key) ?? '';
  return 'winnerOf' in source ? `Winner of ${name}` : `Loser of ${name}`;
}

/** A side that can never be filled. */
function deadSide(
  source: BracketSlotView['sources']['a'],
  byKey: ReadonlyMap<string, BracketSlotView>,
  seeds: ReadonlySet<number>,
): boolean {
  if ('seed' in source) return !seeds.has(source.seed);
  const from = byKey.get('winnerOf' in source ? source.winnerOf : source.loserOf);
  if (!from || from.state === 'VOID') return true;
  // Nobody loses a match that is not really played.
  return 'loserOf' in source && from.passThrough;
}

/**
 * Names for every match that is drawn, and a heading for every round, from
 * the rounds as they are drawn: a round nobody really plays is skipped, so
 * the first round anyone plays is Round 1.
 *
 *   headings: Round 1, Quarter-finals, Semi-finals, Final, Losers round 2...
 *   matches:  R1 M2,   Quarter 3,      Semi 1,      Final, Losers R2 M1...
 */
export function nameSlots(slots: readonly BracketSlotView[]): {
  /** Slot key -> its name. */
  slots: Map<string, string>;
  /** `${section}${round}` -> the round's heading. */
  rounds: Map<string, string>;
} {
  const out = new Map<string, string>();
  const rounds = new Map<string, string>();
  const hasGrandFinal = slots.some((s) => s.section === 'GF');
  for (const section of ['RR', 'W', 'L', 'GF'] as const) {
    const drawn = slots.filter((s) => s.section === section && (section === 'RR' || shown(s)));
    const roundNumbers = [...new Set(drawn.map((s) => s.round))].sort((a, b) => a - b);
    roundNumbers.forEach((round, i) => {
      const inRound = drawn.filter((s) => s.round === round).sort((a, b) => a.position - b.position);
      const fromEnd = roundNumbers.length - 1 - i;
      // Headings are written out; a match's own name is short enough to fit on its card.
      let heading: string;
      let each: (n: number) => string;
      const single = inRound.length === 1;
      if (section === 'GF') {
        heading = 'Grand final';
        each = () => 'Grand final';
      } else if (section === 'L') {
        heading = fromEnd === 0 ? 'Losers final' : `Losers round ${i + 1}`;
        each = (n) => (fromEnd === 0 ? 'Losers final' : single ? `Losers R${i + 1}` : `Losers R${i + 1} M${n}`);
      } else if (section === 'W' && fromEnd === 0) {
        heading = hasGrandFinal ? 'Winners final' : 'Final';
        each = () => heading;
      } else if (section === 'W' && fromEnd === 1 && inRound.length === 2) {
        heading = hasGrandFinal ? 'Winners semi-finals' : 'Semi-finals';
        each = (n) => `${hasGrandFinal ? 'Winners semi' : 'Semi'} ${n}`;
      } else if (section === 'W' && fromEnd === 2 && inRound.length === 4) {
        heading = 'Quarter-finals';
        each = (n) => `Quarter ${n}`;
      } else {
        heading = `Round ${i + 1}`;
        each = (n) => (single ? `R${i + 1}` : `R${i + 1} M${n}`);
      }
      rounds.set(`${section}${round}`, heading);
      inRound.forEach((slot, n) => out.set(slot.key, each(n + 1)));
    });
  }
  return { slots: out, rounds };
}

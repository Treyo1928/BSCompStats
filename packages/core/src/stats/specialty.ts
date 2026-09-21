import type { PpProfile } from './pp-profile.js';

/**
 * A player's specialty: the kind of map they do best on, and the kind they do
 * worst on. It is about the player, not about their team - two people on one
 * side can both be Speed specialists, and the best player in the field still
 * has a worst kind.
 *
 * "Does best on" needs a yardstick, and the obvious ones fail:
 *
 *  - Raw accuracy says everyone is best on True Acc and worst on Speed, because
 *    that is how hard the maps are.
 *  - The gap to other players on the same maps fixes that, but in accuracy
 *    points Speed still decides everything: speed maps spread a field over
 *    thirty points and acc maps over two, so strong players all come out as
 *    Speed specialists and weak ones as worst on Speed.
 *
 * So each kind is measured in its own units: a player's gap to the field on
 * the maps of that kind both have played, divided by how much that gap varies
 * from player to player. Two points clear on Acc maps, where the field sits
 * within three, is a bigger lead than eight points clear on Speed, where it
 * sits within thirty. The specialty is the kind where they are furthest ahead
 * in those terms; the worst is where they are furthest behind.
 *
 * No prediction or model is involved - only scores, like for like.
 *
 * That is the fallback, though, not the first choice. Accuracy against others
 * says who is more accurate, not what kind of player someone is, and it needs
 * overlap. Where a player has a real ranked history the specialty is read from
 * where they earn their pp instead - see pp-profile.ts.
 */

export interface KindStandingInput {
  kind: string;
  /** Average gap to the rest of the field on shared maps of this kind, 0..1. Null with nothing to compare. */
  gap: number | null;
  /** How much that gap varies across players, 0..1. Null when too few players can be compared to say. */
  spread: number | null;
  /** Their own scores of this kind. */
  maps: number;
  /** How many (other player, map) pairs the gap is an average of. */
  comparisons: number;
}

export interface SpecialtyKind {
  kind: string;
  gap: number;
  /** The gap in units of the kind's spread - what the kinds are ordered by. */
  lead: number;
  maps: number;
}

export type SpecialtyStatus = 'TOO_FEW' | 'NOTHING_SHARED' | 'ONE_KIND' | 'RANGE';

export interface SpecialtyBadge {
  label: string;
  tone: 'good' | 'warn' | 'neutral';
}

export interface Specialty {
  status: SpecialtyStatus;
  /** Where the labels came from: where they earn their pp, or maps shared with the field. */
  source: 'PP' | 'SHARED_MAPS';
  /** Their pp by kind, when they have the ranked history for one - whichever source named the labels. */
  pp: PpProfile | null;
  badges: SpecialtyBadge[];
  /** The badges as one line of text, for places that have no room for chips. */
  label: string;
  summary: string;
  best: SpecialtyKind | null;
  worst: SpecialtyKind | null;
  /** Every kind they can be placed on, best first. */
  kinds: SpecialtyKind[];
}

const MIN_SCORES = 3;
/** A gap resting on fewer comparisons than this is a couple of scores, and named a "Tech specialist" off two maps. */
const MIN_COMPARISONS = 4;
/** Half a point. Below this a kind has not separated anyone, and dividing by it would turn noise into a specialty. */
const MIN_SPREAD = 0.005;

/** Spread of a kind: the standard deviation of players' gaps on it. Null with fewer than three to go on. */
export function kindSpread(gaps: ReadonlyArray<number | null>): number | null {
  const values = gaps.filter((g): g is number => g != null);
  if (values.length < 3) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function buildSpecialty(input: {
  kinds: readonly KindStandingInput[];
  scoreCount: number;
  pp?: PpProfile | null;
  /** The average pp profile of the field - what "less than most here" is measured against. */
  fieldShare?: Readonly<Record<string, number>>;
}): Specialty {
  const pp = input.pp ?? null;
  const kinds: SpecialtyKind[] = input.kinds
    .filter((k) => k.gap != null && k.spread != null && k.maps > 0 && k.comparisons >= MIN_COMPARISONS)
    .map((k) => ({ kind: k.kind, gap: k.gap!, lead: k.gap! / Math.max(k.spread!, MIN_SPREAD), maps: k.maps }))
    .sort((a, b) => b.lead - a.lead);

  const best = kinds[0] ?? null;
  const worst = kinds.length >= 2 ? kinds[kinds.length - 1]! : null;

  const make = (status: SpecialtyStatus, badges: SpecialtyBadge[], summary: string): Specialty => ({
    status,
    source: 'SHARED_MAPS',
    pp,
    badges,
    label: badges.map((b) => b.label).join(' · '),
    summary,
    best: status === 'RANGE' || status === 'ONE_KIND' ? best : null,
    worst: status === 'RANGE' ? worst : null,
    kinds,
  });

  if (pp) {
    const shares = Object.entries(pp.share).sort((x, y) => y[1] - x[1]);
    const [bestKind, bestShare] = shares[0]!;
    // The best is theirs alone: where most of their pp comes from. The worst
    // needs a yardstick, because acc maps pay so little pp that they would be
    // everybody's worst - so it is the kind they earn least on next to what
    // the rest of the field earns there.
    const field = input.fieldShare ?? {};
    const behind = [...new Set([...Object.keys(field), ...Object.keys(pp.share)])]
      .filter((kind) => kind !== bestKind)
      .map((kind) => ({ kind, short: (field[kind] ?? 0) - (pp.share[kind] ?? 0) }))
      .sort((x, y) => y.short - x.short)[0];
    const percent = (v: number) => `${Math.round(v * 100)}%`;

    const badges: SpecialtyBadge[] = [{ label: `${bestKind} specialist`, tone: 'good' }];
    if (behind && behind.short >= 0.03) badges.push({ label: `Lighter on ${behind.kind}`, tone: 'warn' });
    return {
      status: 'RANGE',
      source: 'PP',
      pp,
      badges,
      label: badges.map((badge) => badge.label).join(' · '),
      summary:
        `${percent(bestShare)} of their pp comes from ${bestKind} maps, over ${pp.scores} ranked scores` +
        (behind && behind.short >= 0.03
          ? ` - and ${percent(pp.share[behind.kind] ?? 0)} from ${behind.kind}, where the field here averages ${percent(field[behind.kind] ?? 0)}.`
          : '.'),
      best: null,
      worst: null,
      kinds,
    };
  }

  if (input.scoreCount < MIN_SCORES) {
    return make(
      'TOO_FEW',
      [{ label: 'Not enough scores', tone: 'neutral' }],
      `Only ${input.scoreCount} score${input.scoreCount === 1 ? '' : 's'} so far - too few to say what they are best at.`,
    );
  }
  if (!best) {
    return make(
      'NOTHING_SHARED',
      [{ label: 'Nothing to compare', tone: 'neutral' }],
      'No kind of map in common with enough other players yet, so there is nothing to measure a specialty against.',
    );
  }
  if (!worst) {
    return make(
      'ONE_KIND',
      [{ label: `Only placed on ${best.kind}`, tone: 'neutral' }],
      `${best.kind} is the one kind of map they can be compared on, so there is no best or worst to name yet.`,
    );
  }

  const points = (k: SpecialtyKind) => `${k.gap >= 0 ? '+' : '−'}${Math.abs(k.gap * 100).toFixed(1)}`;
  return make(
    'RANGE',
    [
      { label: `${best.kind} specialist`, tone: 'good' },
      { label: `Worst on ${worst.kind}`, tone: 'warn' },
    ],
    `Does best on ${best.kind} maps (${points(best)} against the field on the same maps) and worst on ${worst.kind} (${points(worst)}) - each judged against how far that kind of map spreads players apart, so a wide-open kind like Speed does not win by default.`,
  );
}

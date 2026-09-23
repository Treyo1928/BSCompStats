/**
 * Brackets: round robin, single elimination, and double elimination (a losers
 * bracket feeding a grand final).
 *
 * A bracket is stored as its shape - which seed, or which earlier match's
 * winner or loser, fills each slot - plus the results reported so far. Who
 * actually plays in a slot is never stored: `resolveBracket` works it out
 * from the seeds and results every time. That keeps byes, undone results and
 * reopened matches from ever leaving the bracket half-updated.
 */

export type BracketFormat = 'ROUND_ROBIN' | 'SINGLE_ELIM' | 'DOUBLE_ELIM';
export const BRACKET_FORMATS: readonly BracketFormat[] = ['ROUND_ROBIN', 'SINGLE_ELIM', 'DOUBLE_ELIM'];
export const BRACKET_FORMAT_NAMES: Record<BracketFormat, string> = {
  ROUND_ROBIN: 'Round robin',
  SINGLE_ELIM: 'Single elimination',
  DOUBLE_ELIM: 'Double elimination',
};

export function parseBracketFormat(raw: unknown): BracketFormat {
  return BRACKET_FORMATS.includes(raw as BracketFormat) ? (raw as BracketFormat) : 'SINGLE_ELIM';
}

/** Round robin, winners bracket, losers bracket, grand final. */
export type BracketSection = 'RR' | 'W' | 'L' | 'GF';

/** What fills a slot: a seed, or the winner or loser of an earlier match. */
export type SlotSource =
  | { seed: number }
  | { winnerOf: string }
  | { loserOf: string };

export interface BracketNodeSpec {
  /** Unique in the bracket, e.g. "W1-3". */
  key: string;
  section: BracketSection;
  /** 1-based within its section. */
  round: number;
  /** 1-based within its round. */
  position: number;
  a: SlotSource;
  b: SlotSource;
}

// ---------------------------------------------------------------------------
//  Generation
// ---------------------------------------------------------------------------

/** Every pair meets once, round by round (the circle method), seeds 1..n. */
export function roundRobin(entrants: number): BracketNodeSpec[] {
  if (entrants < 2) return [];
  const seats = entrants % 2 === 0 ? entrants : entrants + 1; // an odd field gives someone a rest each round
  const ring = Array.from({ length: seats }, (_, i) => i + 1);
  const nodes: BracketNodeSpec[] = [];
  for (let round = 1; round < seats; round++) {
    let position = 0;
    for (let i = 0; i < seats / 2; i++) {
      const a = ring[i]!;
      const b = ring[seats - 1 - i]!;
      if (a > entrants || b > entrants) continue;
      position++;
      nodes.push({
        key: `RR${round}-${position}`,
        section: 'RR',
        round,
        position,
        a: { seed: Math.min(a, b) },
        b: { seed: Math.max(a, b) },
      });
    }
    // Keep the first seat fixed and turn the rest.
    ring.splice(1, 0, ring.pop()!);
  }
  return nodes;
}

/**
 * The standard seeding order for a bracket of `size` (a power of two): 1 and
 * 2 can only meet in the final, 1 plays the lowest seed, and so on.
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, next - seed]);
  }
  return order;
}

const nextPowerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/** A single-elimination bracket. Missing seeds are byes, which fall to the top seeds. */
export function singleElimination(entrants: number): BracketNodeSpec[] {
  return winnersBracket(entrants);
}

function winnersBracket(entrants: number): BracketNodeSpec[] {
  if (entrants < 2) return [];
  const size = nextPowerOfTwo(entrants);
  const order = seedOrder(size);
  const rounds = Math.log2(size);
  const nodes: BracketNodeSpec[] = [];
  for (let i = 0; i < size / 2; i++) {
    nodes.push({
      key: `W1-${i + 1}`,
      section: 'W',
      round: 1,
      position: i + 1,
      a: { seed: order[2 * i]! },
      b: { seed: order[2 * i + 1]! },
    });
  }
  for (let round = 2; round <= rounds; round++) {
    const matches = size / 2 ** round;
    for (let i = 0; i < matches; i++) {
      nodes.push({
        key: `W${round}-${i + 1}`,
        section: 'W',
        round,
        position: i + 1,
        a: { winnerOf: `W${round - 1}-${2 * i + 1}` },
        b: { winnerOf: `W${round - 1}-${2 * i + 2}` },
      });
    }
  }
  return nodes;
}

/**
 * Double elimination: the winners bracket, a losers bracket that everyone
 * knocked out of it drops into, and a grand final between the two
 * survivors. Losers drop in reverse order on alternate rounds, which keeps
 * early rematches down.
 */
export function doubleElimination(entrants: number): BracketNodeSpec[] {
  const winners = winnersBracket(entrants);
  if (winners.length === 0) return [];
  const size = nextPowerOfTwo(entrants);
  const wRounds = Math.log2(size);
  if (wRounds === 1) {
    // Two teams: a losers "bracket" of nobody. The final is simply played twice at most - here, once more.
    return [
      ...winners,
      { key: 'GF1-1', section: 'GF', round: 1, position: 1, a: { winnerOf: 'W1-1' }, b: { loserOf: 'W1-1' } },
    ];
  }

  const losers: BracketNodeSpec[] = [];
  // Losers round 1: the first round's losers, in pairs.
  let count = size / 4;
  for (let i = 0; i < count; i++) {
    losers.push({
      key: `L1-${i + 1}`,
      section: 'L',
      round: 1,
      position: i + 1,
      a: { loserOf: `W1-${2 * i + 1}` },
      b: { loserOf: `W1-${2 * i + 2}` },
    });
  }
  let lRound = 1;
  for (let wRound = 2; wRound <= wRounds; wRound++) {
    // A "drop" round: survivors meet the losers of this winners round.
    lRound++;
    const reverse = wRound % 2 === 0;
    for (let i = 0; i < count; i++) {
      const dropFrom = reverse ? count - i : i + 1;
      losers.push({
        key: `L${lRound}-${i + 1}`,
        section: 'L',
        round: lRound,
        position: i + 1,
        a: { winnerOf: `L${lRound - 1}-${i + 1}` },
        b: { loserOf: `W${wRound}-${dropFrom}` },
      });
    }
    if (wRound === wRounds) break;
    // A "halving" round: survivors meet each other.
    lRound++;
    count /= 2;
    for (let i = 0; i < count; i++) {
      losers.push({
        key: `L${lRound}-${i + 1}`,
        section: 'L',
        round: lRound,
        position: i + 1,
        a: { winnerOf: `L${lRound - 1}-${2 * i + 1}` },
        b: { winnerOf: `L${lRound - 1}-${2 * i + 2}` },
      });
    }
  }
  return [
    ...winners,
    ...losers,
    {
      key: 'GF1-1',
      section: 'GF',
      round: 1,
      position: 1,
      a: { winnerOf: `W${wRounds}-1` },
      b: { winnerOf: `L${lRound}-1` },
    },
  ];
}

export function generateBracket(format: BracketFormat, entrants: number): BracketNodeSpec[] {
  switch (format) {
    case 'ROUND_ROBIN':
      return roundRobin(entrants);
    case 'DOUBLE_ELIM':
      return doubleElimination(entrants);
    default:
      return singleElimination(entrants);
  }
}

// ---------------------------------------------------------------------------
//  Resolution
// ---------------------------------------------------------------------------

export type NodeState =
  /** Both sides known, no result yet. */
  | 'READY'
  /** Waiting on an earlier match. */
  | 'PENDING'
  | 'DONE'
  /** One side can never be filled: the other goes through. */
  | 'BYE'
  /** Neither side can ever be filled. */
  | 'VOID';

export interface ResolvedNode extends BracketNodeSpec {
  teamA: string | null;
  teamB: string | null;
  /**
   * The match is never really played: one side, or both, can never be filled.
   * Whoever turns up on the other side goes straight through. Not something
   * to draw - the team just appears in the match it goes on to.
   */
  passThrough: boolean;
  winner: string | null;
  loser: string | null;
  state: NodeState;
}

/**
 * Who plays where, and who has won, from the shape, the seeding and the
 * results reported so far. A reported winner who is no longer in that match
 * (an earlier result was changed) is ignored, and everything after it
 * follows.
 */
export function resolveBracket(
  nodes: readonly BracketNodeSpec[],
  /** Team id per seed, seed 1 first. */
  seeds: readonly string[],
  /** Node key -> the team reported as its winner. */
  results: Readonly<Record<string, string | null | undefined>>,
): ResolvedNode[] {
  const byKey = new Map<string, ResolvedNode>();
  // Unknown until decided; `null` means it can never be filled.
  type Slot = { team: string | null; dead: boolean };
  const slot = (source: SlotSource): Slot => {
    if ('seed' in source) {
      const team = seeds[source.seed - 1] ?? null;
      return { team, dead: team == null };
    }
    const from = byKey.get('winnerOf' in source ? source.winnerOf : source.loserOf);
    if (!from) return { team: null, dead: false };
    if ('winnerOf' in source) {
      if (from.state === 'VOID') return { team: null, dead: true };
      return { team: from.winner, dead: false };
    }
    // A bye has no loser.
    if (from.state === 'VOID' || from.state === 'BYE') return { team: null, dead: true };
    return { team: from.loser, dead: false };
  };

  for (const spec of nodes) {
    const a = slot(spec.a);
    const b = slot(spec.b);
    const node: ResolvedNode = {
      ...spec,
      teamA: a.team,
      teamB: b.team,
      passThrough: a.dead || b.dead,
      winner: null,
      loser: null,
      state: 'PENDING',
    };
    if (a.dead && b.dead) node.state = 'VOID';
    else if (a.dead && b.team) Object.assign(node, { state: 'BYE', winner: b.team });
    else if (b.dead && a.team) Object.assign(node, { state: 'BYE', winner: a.team });
    else if (a.team && b.team) {
      const reported = results[spec.key];
      if (reported && (reported === a.team || reported === b.team)) {
        Object.assign(node, { state: 'DONE', winner: reported, loser: reported === a.team ? b.team : a.team });
      } else {
        node.state = 'READY';
      }
    }
    byKey.set(spec.key, node);
  }
  return [...byKey.values()];
}

/** The bracket's winner, once its last match is decided. */
export function champion(format: BracketFormat, resolved: readonly ResolvedNode[]): string | null {
  if (format === 'ROUND_ROBIN') return null;
  const last = resolved[resolved.length - 1];
  return last && (last.state === 'DONE' || last.state === 'BYE') ? last.winner : null;
}

// ---------------------------------------------------------------------------
//  Standings
// ---------------------------------------------------------------------------

export interface Standing {
  teamId: string;
  played: number;
  wins: number;
  losses: number;
  mapsWon: number;
  mapsLost: number;
}

/**
 * Round robin standings: most wins, then best map difference, then most maps
 * won, then seed. Maps come from the matches played, where there are some.
 */
export function standings(
  resolved: readonly ResolvedNode[],
  seeds: readonly string[],
  /** Node key -> maps won by each team in its match. */
  maps: Readonly<Record<string, Readonly<Record<string, number>>>> = {},
): Standing[] {
  const table = new Map<string, Standing>(
    seeds.map((teamId) => [teamId, { teamId, played: 0, wins: 0, losses: 0, mapsWon: 0, mapsLost: 0 }]),
  );
  for (const node of resolved) {
    if (node.state !== 'DONE' || !node.winner || !node.loser) continue;
    const w = table.get(node.winner);
    const l = table.get(node.loser);
    if (!w || !l) continue;
    w.played++;
    l.played++;
    w.wins++;
    l.losses++;
    const tally = maps[node.key];
    if (tally) {
      w.mapsWon += tally[w.teamId] ?? 0;
      w.mapsLost += tally[l.teamId] ?? 0;
      l.mapsWon += tally[l.teamId] ?? 0;
      l.mapsLost += tally[w.teamId] ?? 0;
    }
  }
  const seedOf = new Map(seeds.map((id, i) => [id, i]));
  return [...table.values()].sort(
    (x, y) =>
      y.wins - x.wins ||
      y.mapsWon - y.mapsLost - (x.mapsWon - x.mapsLost) ||
      y.mapsWon - x.mapsWon ||
      seedOf.get(x.teamId)! - seedOf.get(y.teamId)!,
  );
}

/**
 * Final placings for an elimination bracket: the champion, the runner-up,
 * then everyone else by how far they got. Ties share a place.
 */
export function placings(format: BracketFormat, resolved: readonly ResolvedNode[], seeds: readonly string[]): Array<{ teamId: string; place: number }> {
  if (format === 'ROUND_ROBIN') return [];
  // How far each team got: the latest match they played in, with the losers bracket counting after the winners bracket.
  const reach = new Map<string, number>(seeds.map((id) => [id, 0]));
  const weight = (node: ResolvedNode) =>
    node.section === 'GF' ? 10_000 : node.section === 'L' ? 100 + node.round * 2 : node.round * (format === 'DOUBLE_ELIM' ? 1 : 100);
  for (const node of resolved) {
    for (const team of [node.teamA, node.teamB]) {
      if (team) reach.set(team, Math.max(reach.get(team) ?? 0, weight(node)));
    }
  }
  const winner = champion(format, resolved);
  const ordered = [...reach].sort((x, y) => (y[0] === winner ? 1 : 0) - (x[0] === winner ? 1 : 0) || y[1] - x[1]);
  const out: Array<{ teamId: string; place: number }> = [];
  ordered.forEach(([teamId, r], i) => {
    const prev = out[i - 1];
    const tied = i > 0 && ordered[i - 1]![1] === r && ordered[i - 1]![0] !== winner && teamId !== winner;
    out.push({ teamId, place: tied ? prev!.place : i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------------------
//  Seeding and duos
// ---------------------------------------------------------------------------

/** Fisher-Yates with a supplied random source, so it can be tested. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Pairs players into duos. Seeded, the best is paired with the lowest seed,
 * the second with the second-lowest and so on, which evens the duos out. An
 * odd player out is returned on their own.
 */
export function makeDuos<T>(seeded: readonly T[], method: 'SEEDED' | 'RANDOM', random: () => number = Math.random): { duos: Array<[T, T]>; left: T[] } {
  const players = method === 'RANDOM' ? shuffle(seeded, random) : [...seeded];
  const duos: Array<[T, T]> = [];
  const left: T[] = [];
  if (players.length % 2 === 1) left.push(players.splice(method === 'RANDOM' ? players.length - 1 : Math.floor(players.length / 2), 1)[0]!);
  if (method === 'RANDOM') {
    for (let i = 0; i + 1 < players.length; i += 2) duos.push([players[i]!, players[i + 1]!]);
  } else {
    for (let i = 0; i < players.length / 2; i++) duos.push([players[i]!, players[players.length - 1 - i]!]);
  }
  return { duos, left };
}

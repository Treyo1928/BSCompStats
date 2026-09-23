import { prisma } from '@bscs/db';
import {
  champion,
  parseBracketFormat,
  placings,
  resolveBracket,
  standings,
  type BracketFormat,
  type BracketNodeSpec,
  type NodeState,
  type SlotSource,
  type Standing,
} from '@bscs/core/bracket';
import { tallyMaps } from './match-summary';

/**
 * A bracket as a page shows it: the shape resolved against the seeds and the
 * results so far (packages/core/bracket), with each slot's teams and match.
 */

export interface BracketTeam {
  id: string;
  name: string;
  color: string;
  colorSecondary: string | null;
  seed: number;
}

export interface BracketSlotView {
  key: string;
  section: 'RR' | 'W' | 'L' | 'GF';
  round: number;
  position: number;
  state: NodeState;
  teamA: BracketTeam | null;
  teamB: BracketTeam | null;
  /** What fills a side still to be decided: "Winner of W1-2". */
  sourceA: string;
  sourceB: string;
  /** The same, as data - what a bracket drawing connects. */
  sources: { a: SlotSource; b: SlotSource };
  /** Never really played: a side can never be filled, so whoever is on the other goes through. Not drawn. */
  passThrough: boolean;
  winnerId: string | null;
  match: { id: string; name: string; state: string; a: number; b: number } | null;
}

export interface BracketView {
  id: string;
  name: string;
  format: BracketFormat;
  pool: { id: string; name: string } | null;
  teams: BracketTeam[];
  slots: BracketSlotView[];
  championId: string | null;
  standings: Array<Standing & { team: BracketTeam }>;
  placings: Array<{ team: BracketTeam; place: number }>;
}

const describeSource = (source: SlotSource): string =>
  'seed' in source ? `Seed ${source.seed}` : 'winnerOf' in source ? `Winner of ${source.winnerOf}` : `Loser of ${source.loserOf}`;

export type { SlotSource };

export async function loadBracket(bracketId: string): Promise<(BracketView & { tournamentId: string }) | null> {
  const bracket = await prisma.bracket.findUnique({
    where: { id: bracketId },
    select: {
      id: true,
      name: true,
      format: true,
      tournamentId: true,
      pool: { select: { id: true, name: true } },
      entries: {
        orderBy: { seed: 'asc' },
        select: { seed: true, team: { select: { id: true, name: true, color: true, colorSecondary: true } } },
      },
      nodes: {
        orderBy: [{ section: 'asc' }, { round: 'asc' }, { position: 'asc' }],
        select: {
          key: true,
          section: true,
          round: true,
          position: true,
          sources: true,
          winnerId: true,
          match: {
            select: {
              id: true,
              name: true,
              state: true,
              scoring: true,
              pointsCurve: true,
              teamAId: true,
              teamBId: true,
              maps: {
                select: {
                  isTiebreaker: true,
                  attempts: { select: { teamId: true, playerId: true, score: true, accuracy: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!bracket) return null;
  const format = parseBracketFormat(bracket.format);

  // Seeds are numbered 1..n; a team removed from the tournament leaves a gap, which plays as a bye.
  const seeds: string[] = [];
  const teams: BracketTeam[] = bracket.entries.map((e) => ({ ...e.team, seed: e.seed }));
  for (const entry of bracket.entries) seeds[entry.seed - 1] = entry.team.id;
  const teamById = new Map(teams.map((t) => [t.id, t]));

  // Nodes are resolved in the order they were generated, which puts every match after the ones feeding it.
  const order = sectionOrder(format);
  const nodes = [...bracket.nodes].sort(
    (x, y) => order.indexOf(x.section) - order.indexOf(y.section) || x.round - y.round || x.position - y.position,
  );
  const specs: BracketNodeSpec[] = nodes.map((n) => ({
    key: n.key,
    section: n.section as BracketNodeSpec['section'],
    round: n.round,
    position: n.position,
    ...(n.sources as { a: SlotSource; b: SlotSource }),
  }));
  const results = Object.fromEntries(nodes.map((n) => [n.key, n.winnerId]));
  const resolved = resolveBracket(specs, seeds, results);

  const mapTallies: Record<string, Record<string, number>> = {};
  const slots: BracketSlotView[] = resolved.map((node, i) => {
    const m = nodes[i]!.match;
    let match: BracketSlotView['match'] = null;
    if (m) {
      const tally = tallyMaps(m.maps, m.teamAId, m.teamBId, m);
      mapTallies[node.key] = { [m.teamAId]: tally.a, [m.teamBId]: tally.b };
      // Shown from the slot's point of view: its A side first.
      const flipped = node.teamA != null && node.teamA === m.teamBId;
      match = { id: m.id, name: m.name, state: m.state, a: flipped ? tally.b : tally.a, b: flipped ? tally.a : tally.b };
    }
    return {
      key: node.key,
      section: node.section,
      round: node.round,
      position: node.position,
      state: node.state,
      teamA: node.teamA ? (teamById.get(node.teamA) ?? null) : null,
      teamB: node.teamB ? (teamById.get(node.teamB) ?? null) : null,
      sourceA: describeSource(node.a),
      sourceB: describeSource(node.b),
      sources: { a: node.a, b: node.b },
      passThrough: node.passThrough,
      winnerId: node.winner,
      match,
    };
  });

  return {
    id: bracket.id,
    name: bracket.name,
    format,
    tournamentId: bracket.tournamentId,
    pool: bracket.pool,
    teams,
    slots,
    championId: champion(format, resolved),
    standings:
      format === 'ROUND_ROBIN'
        ? standings(resolved, seeds.filter(Boolean), mapTallies).map((s) => ({ ...s, team: teamById.get(s.teamId)! }))
        : [],
    placings: champion(format, resolved)
      ? placings(format, resolved, seeds.filter(Boolean)).map((p) => ({ team: teamById.get(p.teamId)!, place: p.place }))
      : [],
  };
}

export function sectionOrder(format: BracketFormat): string[] {
  return format === 'ROUND_ROBIN' ? ['RR'] : ['W', 'L', 'GF'];
}

/**
 * Teams in the order a bracket placed them - round robin standings, or
 * elimination placings - for seeding the next one. `final` is false while it
 * is still being played; an elimination bracket has no order until then.
 */
export async function finishingOrder(bracketId: string): Promise<{ order: string[]; final: boolean } | null> {
  const view = await loadBracket(bracketId);
  if (!view) return null;
  const final = !view.slots.some((s) => s.state === 'READY' || s.state === 'PENDING');
  if (view.format === 'ROUND_ROBIN') return { order: view.standings.map((s) => s.team.id), final };
  return view.championId ? { order: view.placings.map((p) => p.team.id), final: true } : null;
}

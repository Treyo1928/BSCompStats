import { rulesForRoster, type MatchFormat } from '../match/format.js';
import { duoKey } from '../match/rules.js';
import {
  drawSamples,
  simulate,
  type LineupMap,
  type ScoreSamples,
  type SimMap,
  type SimResult,
  type SimSetup,
} from './simulate.js';
import { evaluateCandidate, precomputeMargins } from './evaluate.js';
import { searchLineups } from './search.js';

/**
 * Lineup optimisation.
 *
 * Two objectives, and the difference between them is the whole point:
 *
 *   EXPECTED_MARGIN maximises total points. It spreads your strong players to
 *   where they add the most raw score.
 *
 *   WIN_PROBABILITY maximises the chance of winning the match. Once a map is
 *   lost it does not matter how badly, so this objective will happily concede
 *   a map it cannot win - parking the two weakest players there - to free the
 *   strong ones for maps that are actually close. That is sandbagging, and it
 *   falls out of the objective rather than being coded in.
 *
 * Both are offered side by side so a captain can see what the gamble costs.
 */

export type Objective = 'WIN_PROBABILITY' | 'EXPECTED_MARGIN';

/**
 * Maps the lineup is effectively giving up on. A map that is rarely reached at
 * all - the tiebreaker in a match you expect to win outright - is not being
 * conceded, so it is excluded rather than reported as a surrender.
 */
function concededFrom(perMap: SimResult['perMap']): string[] {
  return Object.entries(perMap)
    .filter(([, v]) => v.winProbability < 0.2 && v.playProbability > 0.1)
    .map(([id]) => id);
}

export interface LineupCandidate {
  lineups: LineupMap;
  winProbability: number;
  expectedMargin: number;
  perMap: SimResult['perMap'];
  /** Maps this lineup is effectively conceding - under 20% to win. */
  concededMapIds: string[];
}

export interface OptimizeInput {
  maps: readonly SimMap[];
  format: MatchFormat;
  roster: readonly string[];
  /** The opposing lineups, if known. */
  opponentLineups: LineupMap;
  samples: ScoreSamples;
  objective?: Objective;
  /** How many ranked candidates to return. */
  topN?: number;
  /** Safety valve on the search space. */
  maxCandidates?: number;
}

export interface OptimizeResult {
  best: LineupCandidate | null;
  ranked: LineupCandidate[];
  /** Candidates actually evaluated. */
  evaluated: number;
  /** True when the space was too large to enumerate and search was heuristic. */
  truncated: boolean;
  /**
   * Set when no legal lineup exists at all. Silently returning nothing is the
   * worst outcome here: a captain sees an empty panel and cannot tell whether
   * the optimiser is broken, still thinking, or telling them their roster
   * cannot legally fill the card. It usually can't for a concrete reason -
   * too few players for the duo rule, or appearance bounds that do not divide
   * into the number of slots.
   */
  infeasible?: string;
}

/**
 * Why a roster cannot legally fill these maps, in words a captain can act on.
 * Returns null when the constraints are satisfiable on their face.
 */
export function explainInfeasible(
  roster: readonly string[],
  maps: readonly SimMap[],
  format: MatchFormat,
): string | null {
  const k = format.playersPerMap;
  const rules = rulesForRoster(format, roster.length, maps.filter((m) => !m.isTiebreaker).length).rules;
  const scoring = maps.filter((m) => !m.isTiebreaker);
  const slots = scoring.length * k;

  if (roster.length < k) {
    return `This format fields ${k} players per map but the roster only has ${roster.length}.`;
  }

  if (rules.minAppearances != null) {
    const needed = roster.length * rules.minAppearances;
    if (needed > slots) {
      return (
        `Every player must appear on at least ${rules.minAppearances} of the ` +
        `${scoring.length} scoring maps, which needs ${needed} slots, but ${k} ` +
        `players per map only gives ${slots}. Either shorten the roster to ` +
        `${Math.floor(slots / rules.minAppearances)} or relax the minimum.`
      );
    }
  }

  if (rules.maxAppearances != null) {
    const available = roster.length * rules.maxAppearances;
    if (available < slots) {
      const short = Math.ceil((slots - available) / rules.maxAppearances);
      return (
        `No player may appear more than ${rules.maxAppearances} times, so ${roster.length} ` +
        `players can only cover ${available} of the ${slots} slots. ` +
        `Add ${short} more player${short === 1 ? '' : 's'}.`
      );
    }
  }

  if (rules.uniqueDuos && k > 1) {
    // Distinct groups available from the roster: C(n, k).
    let combos = 1;
    for (let i = 0; i < k; i++) combos = (combos * (roster.length - i)) / (i + 1);
    if (combos < scoring.length) {
      return (
        `${roster.length} players give only ${Math.round(combos)} distinct pairings, but ` +
        `${scoring.length} maps each need a different one. This is the bind a ` +
        `short-handed team is in - add a player, or have an organiser override.`
      );
    }
  }

  return null;
}

export function optimizeLineups(input: OptimizeInput): OptimizeResult {
  const objective = input.objective ?? 'WIN_PROBABILITY';
  const topN = input.topN ?? 5;
  const maxCandidates = input.maxCandidates ?? 50_000;

  const candidates = enumerateLineups(
    input.roster,
    input.maps,
    input.format,
    maxCandidates,
  );

  // Every candidate is a combination of the same small set of per-map player
  // groups, so each group's margin is computed once and shared.
  const precomputed = precomputeMargins(
    input.samples,
    input.maps,
    candidates.lineups,
    input.opponentLineups,
  );

  const scored: LineupCandidate[] = candidates.lineups.map((lineups) => {
    const result = evaluateCandidate(precomputed, input.maps, lineups, input.format);
    return {
      lineups,
      winProbability: result.winProbability,
      expectedMargin: result.expectedMargin,
      perMap: result.perMap,
      concededMapIds: concededFrom(result.perMap),
    };
  });

  scored.sort((a, b) =>
    objective === 'WIN_PROBABILITY'
      ? b.winProbability - a.winProbability || b.expectedMargin - a.expectedMargin
      : b.expectedMargin - a.expectedMargin || b.winProbability - a.winProbability,
  );

  return {
    best: scored[0] ?? null,
    ranked: scored.slice(0, topN),
    evaluated: scored.length,
    truncated: candidates.truncated,
    infeasible: scored.length
      ? undefined
      : (explainInfeasible(input.roster, input.maps, input.format) ??
        'No legal lineup exists for this roster and format.'),
  };
}

/**
 * Two-stage search: rank every candidate on a cheap simulation, then re-run the
 * survivors at full precision. Common random numbers make the cheap pass a
 * reliable ranker, so this costs a fraction of simulating everything properly
 * while the final numbers are still the real ones.
 */
export function optimizeLineupsTwoStage(
  setup: SimSetup,
  input: Omit<OptimizeInput, 'samples'> & { coarseIterations?: number },
): OptimizeResult {
  const coarse = drawSamples({
    ...setup,
    iterations: input.coarseIterations ?? 2000,
    seed: (setup.seed ?? 1337) + 1,
  });

  const firstPass = optimizeLineups({ ...input, samples: coarse });
  if (!firstPass.best) return firstPass;

  const fine = drawSamples(setup);
  const shortlist = firstPass.ranked.slice(0, Math.max(input.topN ?? 5, 10));

  const refined: LineupCandidate[] = shortlist.map((candidate) => {
    const result = simulate(fine, candidate.lineups, input.opponentLineups, input.format);
    return {
      lineups: candidate.lineups,
      winProbability: result.winProbability,
      expectedMargin: result.expectedMargin,
      perMap: result.perMap,
      concededMapIds: concededFrom(result.perMap),
    };
  });

  const objective = input.objective ?? 'WIN_PROBABILITY';
  refined.sort((a, b) =>
    objective === 'WIN_PROBABILITY'
      ? b.winProbability - a.winProbability || b.expectedMargin - a.expectedMargin
      : b.expectedMargin - a.expectedMargin || b.winProbability - a.winProbability,
  );

  return {
    best: refined[0] ?? null,
    ranked: refined.slice(0, input.topN ?? 5),
    evaluated: firstPass.evaluated,
    truncated: firstPass.truncated,
  };
}

// ---------------------------------------------------------------------------
//  Enumeration
// ---------------------------------------------------------------------------

export interface EnumerationResult {
  lineups: LineupMap[];
  truncated: boolean;
}

/**
 * Every legal way to fill the maps, found by depth-first search with the rules
 * applied as we go.
 *
 * Pruning during the walk rather than filtering afterwards is what keeps this
 * fast: for the real format - four players, four maps of two, no repeated duo,
 * everyone playing exactly twice - the raw space is 6^5 = 7776 assignments and
 * the constraints cut it to a handful.
 */
export function enumerateLineups(
  roster: readonly string[],
  maps: readonly SimMap[],
  format: MatchFormat,
  maxCandidates = 50_000,
): EnumerationResult {
  const k = format.playersPerMap;
  const rules = rulesForRoster(format, roster.length, maps.filter((m) => !m.isTiebreaker).length).rules;

  if (roster.length < k) return { lineups: [], truncated: false };

  const options = combinations(roster, k);
  const out: LineupMap[] = [];
  let truncated = false;

  const appearances = new Map<string, number>();
  const usedDuos = new Set<string>();
  const chosen: Array<readonly string[]> = [];

  const regularMapCount = maps.filter((m) => !m.isTiebreaker).length;

  const walk = (index: number): void => {
    if (truncated) return;
    if (index === maps.length) {
      if (rules.minAppearances != null) {
        for (const playerId of roster) {
          if ((appearances.get(playerId) ?? 0) < rules.minAppearances) return;
        }
      }
      const lineups: Record<string, readonly string[]> = {};
      maps.forEach((map, i) => {
        lineups[map.id] = chosen[i]!;
      });
      out.push(lineups);
      if (out.length >= maxCandidates) truncated = true;
      return;
    }

    const map = maps[index]!;
    const exempt = map.isTiebreaker && rules.tiebreakerExemptFromDuos;

    for (const combo of options) {
      const key = duoKey(combo);

      if (!exempt) {
        if (rules.uniqueDuos && k > 1 && usedDuos.has(key)) continue;
        if (
          rules.maxAppearances != null &&
          combo.some((p) => (appearances.get(p) ?? 0) >= rules.maxAppearances!)
        ) {
          continue;
        }
      }

      // Feasibility: if everyone must reach a minimum, check enough slots remain.
      if (!exempt && rules.minAppearances != null) {
        const remainingSlots = (regularMapCount - index - 1) * k;
        let deficit = 0;
        for (const playerId of roster) {
          const after =
            (appearances.get(playerId) ?? 0) + (combo.includes(playerId) ? 1 : 0);
          deficit += Math.max(0, rules.minAppearances - after);
        }
        if (deficit > remainingSlots) continue;
      }

      if (!exempt) {
        if (rules.uniqueDuos && k > 1) usedDuos.add(key);
        for (const p of combo) appearances.set(p, (appearances.get(p) ?? 0) + 1);
      }
      chosen.push(combo);

      walk(index + 1);

      chosen.pop();
      if (!exempt) {
        if (rules.uniqueDuos && k > 1) usedDuos.delete(key);
        for (const p of combo) appearances.set(p, (appearances.get(p) ?? 1) - 1);
      }
      if (truncated) return;
    }
  };

  walk(0);
  return { lineups: out, truncated };
}

export function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k <= 0) return [[]];
  if (k > items.length) return [];

  const out: T[][] = [];
  const current: T[] = [];

  const walk = (start: number): void => {
    if (current.length === k) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      walk(i + 1);
      current.pop();
    }
  };

  walk(0);
  return out;
}


// ---------------------------------------------------------------------------
//  Public entry point
// ---------------------------------------------------------------------------

export interface RecommendInput extends Omit<OptimizeInput, 'samples'> {
  /** Coarse pass size for ranking. */
  coarseIterations?: number;
  seed?: number;
}

export interface Recommendation extends OptimizeResult {
  /** 'EXHAUSTIVE' when every legal lineup was checked, 'SEARCH' otherwise. */
  strategy: 'EXHAUSTIVE' | 'SEARCH';
}

/**
 * Recommend lineups, choosing the search strategy to fit the problem.
 *
 * Small formats - which is nearly all of them; the real four-player duos
 * format has 432 legal lineups - are solved exactly. Only when the space is
 * too large to enumerate does it fall back to local search, and it says which
 * it did, because "this is the best lineup" and "this is the best one I found"
 * are different claims and a captain deserves to know which they are getting.
 */
export function recommendLineups(
  setup: SimSetup,
  input: RecommendInput,
): Recommendation {
  const probe = enumerateLineups(
    input.roster,
    input.maps,
    input.format,
    input.maxCandidates ?? 50_000,
  );

  if (!probe.truncated) {
    if (!probe.lineups.length) {
      return {
        best: null,
        ranked: [],
        evaluated: 0,
        truncated: false,
        strategy: 'EXHAUSTIVE',
        infeasible:
          explainInfeasible(input.roster, input.maps, input.format) ??
          'No legal lineup exists for this roster and format.',
      };
    }
    const result = optimizeLineupsTwoStage(setup, {
      ...input,
      coarseIterations: input.coarseIterations ?? 2000,
    });
    return { ...result, strategy: 'EXHAUSTIVE' };
  }

  // Search on a coarse sample, then score the winner on the full one - the
  // same two stages as the exhaustive path. Searching on the full sample cost
  // five times as much to choose between lineups a coarse one already ranks.
  const coarse = drawSamples({
    ...setup,
    iterations: input.coarseIterations ?? 2000,
    seed: (setup.seed ?? 1337) + 1,
  });
  const fine = drawSamples(setup);
  const found = searchLineups({
    maps: input.maps,
    format: input.format,
    roster: input.roster,
    opponentLineups: input.opponentLineups,
    samples: coarse,
    objective: input.objective,
    seed: input.seed ?? setup.seed,
  });

  if (!found.lineups) {
    return {
      best: null,
      ranked: [],
      evaluated: found.evaluated,
      truncated: true,
      strategy: 'SEARCH',
      infeasible:
        explainInfeasible(input.roster, input.maps, input.format) ??
        'Local search could not find a legal lineup.',
    };
  }

  const margins = precomputeMargins(fine, input.maps, [found.lineups], input.opponentLineups);
  const result = evaluateCandidate(margins, input.maps, found.lineups, input.format);
  const candidate: LineupCandidate = {
    lineups: found.lineups,
    winProbability: result.winProbability,
    expectedMargin: result.expectedMargin,
    perMap: result.perMap,
    concededMapIds: concededFrom(result.perMap),
  };

  return {
    best: candidate,
    ranked: [candidate],
    evaluated: found.evaluated,
    truncated: true,
    strategy: 'SEARCH',
  };
}

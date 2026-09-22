import { rulesForRoster, type MatchFormat } from '../match/format.js';
import { duoKey } from '../match/rules.js';
import { evaluateCandidate, makeComboMargins, type ComboMargins } from './evaluate.js';
import type { LineupMap, ScoreSamples, SimMap } from './simulate.js';
import { mulberry32 } from './random.js';
import { combinations } from './lineup.js';

/**
 * Local search for rosters too large to enumerate.
 *
 * Exhaustive search is exact and fast enough for the formats this is actually
 * used for - the real four-player duos format has only 432 legal lineups - but
 * it explodes quickly: seven players fielding trios across five maps passes
 * two hundred thousand. Past that threshold this takes over: start from a
 * random legal lineup, repeatedly swap players between maps, and accept worse
 * states with a decreasing probability so the search can climb out of a local
 * optimum. Several independent restarts guard against a bad start.
 */

export interface SearchInput {
  maps: readonly SimMap[];
  format: MatchFormat;
  roster: readonly string[];
  opponentLineups: LineupMap;
  samples: ScoreSamples;
  objective?: 'WIN_PROBABILITY' | 'EXPECTED_MARGIN';
  restarts?: number;
  stepsPerRestart?: number;
  seed?: number;
  /** Maps whose group is already decided. The start honours them and no move touches them. */
  pinned?: LineupMap;
}

export interface SearchResult {
  lineups: LineupMap | null;
  score: number;
  evaluated: number;
}

export function searchLineups(input: SearchInput): SearchResult {
  const objective = input.objective ?? 'WIN_PROBABILITY';
  const restarts = input.restarts ?? 6;
  const steps = input.stepsPerRestart ?? 600;
  const random = mulberry32(input.seed ?? 99);
  const pinned = input.pinned ?? {};

  const margins: ComboMargins = makeComboMargins(
    new Map(),
    input.samples.iterations,
    input.samples,
    input.maps,
    input.opponentLineups,
  );

  const score = (lineups: LineupMap): number => {
    const result = evaluateCandidate(margins, input.maps, lineups, input.format);
    return objective === 'WIN_PROBABILITY' ? result.winProbability : result.expectedMargin;
  };

  let bestOverall: LineupMap | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let evaluated = 0;

  for (let restart = 0; restart < restarts; restart++) {
    const start = randomLegalLineup(input.roster, input.maps, input.format, random, pinned);
    if (!start) break;

    let current = start;
    let currentScore = score(current);
    evaluated++;

    let best = current;
    let bestLocal = currentScore;

    for (let step = 0; step < steps; step++) {
      const temperature = 0.08 * (1 - step / steps) + 1e-4;
      const next = mutate(current, input.roster, input.maps, input.format, random, pinned);
      if (!next) continue;

      const nextScore = score(next);
      evaluated++;

      const delta = nextScore - currentScore;
      if (delta >= 0 || random() < Math.exp(delta / temperature)) {
        current = next;
        currentScore = nextScore;
        if (nextScore > bestLocal) {
          bestLocal = nextScore;
          best = next;
        }
      }
    }

    if (bestLocal > bestScore) {
      bestScore = bestLocal;
      bestOverall = best;
    }
  }

  return { lineups: bestOverall, score: bestScore, evaluated };
}

/** Depth-first fill with randomised order - gives a legal starting point. */
function randomLegalLineup(
  roster: readonly string[],
  maps: readonly SimMap[],
  format: MatchFormat,
  random: () => number,
  pinned: LineupMap = {},
): LineupMap | null {
  const options = shuffle(combinations(roster, format.playersPerMap), random);
  const rules = rulesForRoster(format, roster.length, maps.filter((m) => !m.isTiebreaker).length).rules;
  const appearances = new Map<string, number>();
  const usedDuos = new Map<string, number>();
  let repeatsLeft = rules.duoRepeatsAllowed;
  const chosen: Array<readonly string[]> = [];

  const walk = (index: number): boolean => {
    if (index === maps.length) {
      if (rules.minAppearances == null) return true;
      return roster.every((p) => (appearances.get(p) ?? 0) >= rules.minAppearances!);
    }

    const map = maps[index]!;
    const exempt = map.isTiebreaker && rules.tiebreakerExemptFromDuos;
    const pin = pinned[map.id];
    const choices = pin ? options.filter((combo) => duoKey(combo) === duoKey(pin)) : options;

    for (const combo of choices) {
      const key = duoKey(combo);
      const tracked = !exempt && rules.uniqueDuos && format.playersPerMap > 1;
      const isRepeat = tracked && (usedDuos.get(key) ?? 0) > 0;
      if (!exempt) {
        if (isRepeat && repeatsLeft === 0) continue;
        if (
          rules.maxAppearances != null &&
          combo.some((p) => (appearances.get(p) ?? 0) >= rules.maxAppearances!)
        ) {
          continue;
        }
        if (tracked) usedDuos.set(key, (usedDuos.get(key) ?? 0) + 1);
        if (isRepeat) repeatsLeft--;
        for (const p of combo) appearances.set(p, (appearances.get(p) ?? 0) + 1);
      }
      chosen.push(combo);

      if (walk(index + 1)) return true;

      chosen.pop();
      if (!exempt) {
        if (tracked) usedDuos.set(key, (usedDuos.get(key) ?? 1) - 1);
        if (isRepeat) repeatsLeft++;
        for (const p of combo) appearances.set(p, (appearances.get(p) ?? 1) - 1);
      }
    }
    return false;
  };

  if (!walk(0)) return null;

  const lineups: Record<string, readonly string[]> = {};
  maps.forEach((map, i) => {
    lineups[map.id] = chosen[i]!;
  });
  return lineups;
}

/**
 * One random legal neighbour: either swap a player between two maps, or
 * replace one with somebody currently sitting out. Illegal results are
 * rejected rather than repaired, which keeps the move set simple and the
 * legality guarantee absolute.
 */
function mutate(
  lineups: LineupMap,
  roster: readonly string[],
  maps: readonly SimMap[],
  format: MatchFormat,
  random: () => number,
  pinned: LineupMap = {},
): LineupMap | null {
  // Pinned maps are fixed: moves only pick among the rest.
  const mapIds = maps.map((m) => m.id).filter((id) => !pinned[id]);
  if (mapIds.length < 1) return null;

  const next: Record<string, string[]> = {};
  for (const map of maps) next[map.id] = [...(lineups[map.id] ?? [])];

  if (random() < 0.5 && mapIds.length >= 2) {
    // Swap one player between two maps.
    const a = mapIds[Math.floor(random() * mapIds.length)]!;
    let b = mapIds[Math.floor(random() * mapIds.length)]!;
    if (a === b) b = mapIds[(mapIds.indexOf(a) + 1) % mapIds.length]!;

    const groupA = next[a]!;
    const groupB = next[b]!;
    if (!groupA.length || !groupB.length) return null;

    const i = Math.floor(random() * groupA.length);
    const j = Math.floor(random() * groupB.length);
    const playerA = groupA[i]!;
    const playerB = groupB[j]!;
    if (playerA === playerB) return null;
    if (groupA.includes(playerB) || groupB.includes(playerA)) return null;

    groupA[i] = playerB;
    groupB[j] = playerA;
  } else {
    // Bring in someone who is not on this map.
    const mapId = mapIds[Math.floor(random() * mapIds.length)]!;
    const group = next[mapId]!;
    if (!group.length) return null;

    const bench = roster.filter((p) => !group.includes(p));
    if (!bench.length) return null;

    group[Math.floor(random() * group.length)] =
      bench[Math.floor(random() * bench.length)]!;
  }

  return isLegal(next, roster, maps, format) ? next : null;
}

function isLegal(
  lineups: Record<string, string[]>,
  roster: readonly string[],
  maps: readonly SimMap[],
  format: MatchFormat,
): boolean {
  const rules = rulesForRoster(format, roster.length, maps.filter((m) => !m.isTiebreaker).length).rules;
  const appearances = new Map<string, number>();
  const duos = new Set<string>();
  let repeatsLeft = rules.duoRepeatsAllowed;

  for (const map of maps) {
    const group = lineups[map.id] ?? [];
    if (group.length !== format.playersPerMap) return false;
    if (new Set(group).size !== group.length) return false;
    if (group.some((p) => !roster.includes(p))) return false;

    if (map.isTiebreaker && rules.tiebreakerExemptFromDuos) continue;

    if (rules.uniqueDuos && format.playersPerMap > 1) {
      const key = duoKey(group);
      if (duos.has(key)) {
        if (repeatsLeft === 0) return false;
        repeatsLeft--;
      }
      duos.add(key);
    }
    for (const p of group) appearances.set(p, (appearances.get(p) ?? 0) + 1);
  }

  if (rules.maxAppearances != null) {
    for (const count of appearances.values()) {
      if (count > rules.maxAppearances) return false;
    }
  }
  if (rules.minAppearances != null) {
    for (const p of roster) {
      if ((appearances.get(p) ?? 0) < rules.minAppearances) return false;
    }
  }
  return true;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

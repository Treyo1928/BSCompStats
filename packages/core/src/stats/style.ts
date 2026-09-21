import { median } from './normalize.js';
import type { PlayerProfile, ScoreDetail } from './profile.js';

/**
 * Play style: what kind of player someone is, in words a captain would use.
 *
 * Nothing here is new evidence - it is the profile read back as a description.
 * Two rules keep it honest:
 *
 *  - Everything is relative to the field it is given, because "consistent" only
 *    means something next to the people you might field instead.
 *  - A lean toward a category has to clear a real margin and rest on more than
 *    one map. A pool has one or two maps per tag, and a player who had one good
 *    night on the only Speed map is not a speed specialist. When the evidence
 *    is that thin the lean is still listed, marked as thin, and does not name
 *    the archetype.
 */

export type Archetype = 'SPECIALIST' | 'ANCHOR' | 'STEADY' | 'STREAKY' | 'ALL_ROUNDER' | 'UNKNOWN';

export interface StyleTrait {
  key: string;
  label: string;
  detail: string;
  tone: 'good' | 'bad' | 'neutral';
}

export interface CategoryLean {
  category: string;
  /** Mean of (actual - what general skill predicts), logit units. Positive is better than expected. */
  affinity: number;
  /** The same lean in accuracy points: mean of actual minus predicted. */
  accPoints: number;
  maps: number;
}

export interface PlayStyle {
  playerId: string;
  archetype: Archetype;
  /** "Tech specialist", "All-rounder" - the headline. */
  label: string;
  summary: string;
  traits: StyleTrait[];
  /** Best first. */
  categories: CategoryLean[];
  /** Where they sit in the field given, 0..1, higher always meaning more of the named thing. */
  percentiles: { skill: number; consistency: number; fullCombos: number };
  /** Too few scores for any of this to mean much. */
  thin: boolean;
}

export interface BuildStylesInput {
  profiles: Readonly<Record<string, PlayerProfile>>;
  scores: readonly ScoreDetail[];
  categories?: Readonly<Record<string, string | null | undefined>>;
}

/** A lean has to be worth about a point of accuracy at 95% before it is called one. */
const LEAN_LOGIT = 0.2;
const MIN_SCORES = 3;

export function buildPlayStyles(input: BuildStylesInput): Record<string, PlayStyle> {
  const profiles = Object.values(input.profiles);
  const field = {
    skill: profiles.map((p) => p.skill),
    sigma: profiles.map((p) => p.sigma),
    fcRate: profiles.map((p) => p.fcRate),
  };
  const typicalSigma = median(field.sigma) || 1;

  // How many clean scores sit behind each affinity figure.
  const mapsPerCategory = new Map<string, Map<string, number>>();
  for (const s of input.scores) {
    const category = input.categories?.[s.leaderboardId];
    if (!category || s.isDnf) continue;
    const mine = mapsPerCategory.get(s.playerId) ?? new Map<string, number>();
    mine.set(category, (mine.get(category) ?? 0) + 1);
    mapsPerCategory.set(s.playerId, mine);
  }

  const out: Record<string, PlayStyle> = {};
  for (const profile of profiles) {
    const thin = profile.scoreCount < MIN_SCORES;
    const categories: CategoryLean[] = Object.entries(profile.categoryAffinity)
      .map(([category, affinity]) => ({
        category,
        affinity,
        accPoints: (profile.categoryAccDelta[category] ?? 0) * 100,
        maps: mapsPerCategory.get(profile.playerId)?.get(category) ?? 0,
      }))
      .sort((a, b) => b.affinity - a.affinity);

    const best = categories[0];
    const worst = categories.length > 1 ? categories[categories.length - 1] : undefined;
    const spread = best && worst ? best.affinity - worst.affinity : 0;

    const percentiles = {
      skill: percentile(field.skill, profile.skill),
      consistency: 1 - percentile(field.sigma, profile.sigma),
      fullCombos: percentile(field.fcRate, profile.fcRate),
    };
    const relativeSigma = profile.sigma / typicalSigma;

    const traits: StyleTrait[] = [];
    if (!thin) {
      if (best && best.affinity >= LEAN_LOGIT) {
        traits.push({
          key: 'strength',
          label: `Strong on ${best.category}`,
          detail: `${signed(best.accPoints)} points against what their general level predicts, over ${maps(best.maps)}.${best.maps < 2 ? ' One map is thin evidence.' : ''}`,
          tone: 'good',
        });
      }
      if (worst && worst.affinity <= -LEAN_LOGIT) {
        traits.push({
          key: 'weakness',
          label: `Weaker on ${worst.category}`,
          detail: `${signed(worst.accPoints)} points against what their general level predicts, over ${maps(worst.maps)}.${worst.maps < 2 ? ' One map is thin evidence.' : ''}`,
          tone: 'bad',
        });
      }
      if (relativeSigma <= 0.75) {
        traits.push({
          key: 'consistent',
          label: 'Consistent',
          detail: 'Scores land close to where they are expected, map after map. Safe to build a lineup around.',
          tone: 'good',
        });
      } else if (relativeSigma >= 1.4) {
        traits.push({
          key: 'streaky',
          label: 'Streaky',
          detail: 'Results swing further from expectation than most. Better on a map you can afford to lose than on the decider.',
          tone: 'neutral',
        });
      }
      if (profile.fcRate >= 0.5 && percentiles.fullCombos >= 0.5) {
        traits.push({
          key: 'clean',
          label: 'Clean',
          detail: `Full combo on ${Math.round(profile.fcRate * 100)}% of their maps.`,
          tone: 'good',
        });
      } else if (profile.missRate >= 0.9 && percentiles.skill >= 0.5) {
        traits.push({
          key: 'scrappy',
          label: 'Plays through misses',
          detail: 'Rarely full combos, and scores well regardless - the accuracy is in the cuts, not the combo.',
          tone: 'neutral',
        });
      }
      if (profile.bestAcc - profile.medianAcc >= 0.02) {
        traits.push({
          key: 'ceiling',
          label: 'High ceiling',
          detail: `Best map is ${((profile.bestAcc - profile.medianAcc) * 100).toFixed(1)} points above their median.`,
          tone: 'neutral',
        });
      }
      // accLeft/accRight are average cut scores out of 115; a point is visible.
      if (Math.abs(profile.handBalance) >= 1) {
        traits.push({
          key: 'hand',
          label: profile.handBalance > 0 ? 'Left hand leads' : 'Right hand leads',
          detail: `${Math.abs(profile.handBalance).toFixed(1)} points a cut better on the ${profile.handBalance > 0 ? 'left' : 'right'}. Maps weighted to the other hand may cost them.`,
          tone: 'neutral',
        });
      }
      if (profile.failCount > 0) {
        traits.push({
          key: 'abandons',
          label: profile.failCount === 1 ? 'One abandoned run' : `${profile.failCount} abandoned runs`,
          detail: 'Far below both their own level and everyone else on the map. Left out of their averages.',
          tone: 'bad',
        });
      }
    }

    // A specialist has a real lean, backed by more than one map, that stands
    // out from how they do elsewhere.
    const specialist =
      !thin && best && best.affinity >= LEAN_LOGIT && best.maps >= 2 && spread >= LEAN_LOGIT * 1.5;

    let archetype: Archetype;
    let label: string;
    let summary: string;
    if (thin) {
      archetype = 'UNKNOWN';
      label = 'Not enough scores';
      summary = `Only ${profile.scoreCount} score${profile.scoreCount === 1 ? '' : 's'} so far - a style needs at least ${MIN_SCORES}.`;
    } else if (specialist) {
      archetype = 'SPECIALIST';
      label = `${best.category} specialist`;
      summary = `Does noticeably better on ${best.category} maps than their general level suggests${
        worst && worst.affinity <= -LEAN_LOGIT ? `, and gives some of it back on ${worst.category}` : ''
      }.`;
    } else if (relativeSigma <= 0.75 && percentiles.skill >= 0.66) {
      archetype = 'ANCHOR';
      label = 'Anchor';
      summary = 'Among the strongest here and among the most predictable. The player to put on the map that has to be won.';
    } else if (relativeSigma <= 0.75) {
      archetype = 'STEADY';
      label = 'Steady';
      summary = 'Scores where expected nearly every time, across every kind of map.';
    } else if (relativeSigma >= 1.4) {
      archetype = 'STREAKY';
      label = 'Streaky';
      summary = 'Capable of well above and well below their usual level. High variance is an asset on a map you are expected to lose.';
    } else {
      archetype = 'ALL_ROUNDER';
      label = 'All-rounder';
      // A lean that did not make them a specialist - usually because it rests
      // on one map - is still the most useful thing to know about them.
      const exception = [best, worst]
        .filter((c): c is CategoryLean => c != null && Math.abs(c.affinity) >= LEAN_LOGIT)
        .sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity))[0];
      summary = exception
        ? `Level across most of the pool. The exception so far is ${exception.category}, ${
            exception.affinity > 0 ? 'above' : 'below'
          } their usual by ${Math.abs(exception.accPoints).toFixed(1)} points${
            exception.maps < 2 ? ' - on one map, so a lead rather than a verdict' : ''
          }.`
        : 'No category stands out either way - their level carries across the pool.';
    }

    out[profile.playerId] = {
      playerId: profile.playerId,
      archetype,
      label,
      summary,
      traits,
      categories,
      percentiles,
      thin,
    };
  }
  return out;
}

/** Share of the field at or below this value, 0..1. Alone in the field is 1. */
function percentile(field: readonly number[], value: number): number {
  if (field.length <= 1) return 1;
  const below = field.filter((v) => v < value).length;
  return below / (field.length - 1);
}

const signed = (v: number): string => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(1)}`;
const maps = (n: number): string => `${n} map${n === 1 ? '' : 's'}`;

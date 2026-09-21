import { median } from './normalize.js';
import type { PlayerProfile, ScoreDetail } from './profile.js';

/**
 * How a player plays, as far as it can be said without comparing them to anyone:
 * how steady they are, how clean, which hand leads, how far their best sits
 * above their usual.
 *
 * What is deliberately not here is any verdict on what they are good or bad at.
 * That used to live in this file, measured against what a model predicted from
 * the player's own level, and it called the second-best Tech player on a team
 * "weak on Tech". What a player is best and worst at is worked out from real
 * scores against the rest of the field - see specialty.ts.
 *
 * `categories` is kept for the one place that still asks the model's question
 * on purpose: the "their own level" view of a player's kinds of map.
 */

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
  /** Where they stand on this kind of map among everyone with a score on it, by general level plus lean. */
  fieldRank: number;
  fieldSize: number;
}

export interface PlayStyle {
  playerId: string;
  traits: StyleTrait[];
  /** Best first. */
  categories: CategoryLean[];
  /** Where they sit in the field given, 0..1, higher always meaning more of the named thing. */
  percentiles: { consistency: number; fullCombos: number };
  /** Too few scores for any of this to mean much. */
  thin: boolean;
}

export interface BuildStylesInput {
  profiles: Readonly<Record<string, PlayerProfile>>;
  scores: readonly ScoreDetail[];
  categories?: Readonly<Record<string, string | null | undefined>>;
}

const MIN_SCORES = 3;
/** Calling someone consistent is praise, and three scores that happen to agree have not earned it. */
const MIN_SCORES_FOR_CONSISTENCY = 5;

export function buildPlayStyles(input: BuildStylesInput): Record<string, PlayStyle> {
  const profiles = Object.values(input.profiles);
  const field = {
    sigma: profiles.map((p) => p.sigma),
    fcRate: profiles.map((p) => p.fcRate),
  };
  const typicalSigma = median(field.sigma) || 1;
  const typicalSkill = median(profiles.map((p) => p.skill));

  // How many clean scores sit behind each affinity figure.
  const mapsPerCategory = new Map<string, Map<string, number>>();
  for (const s of input.scores) {
    const category = input.categories?.[s.leaderboardId];
    if (!category || s.isDnf) continue;
    const mine = mapsPerCategory.get(s.playerId) ?? new Map<string, number>();
    mine.set(category, (mine.get(category) ?? 0) + 1);
    mapsPerCategory.set(s.playerId, mine);
  }

  // Level on each kind of map: general skill plus the lean. Ranked across
  // everyone with a score of that kind.
  const levels = new Map<string, number[]>();
  for (const p of profiles) {
    for (const [category, affinity] of Object.entries(p.categoryAffinity)) {
      levels.set(category, [...(levels.get(category) ?? []), p.skill + affinity]);
    }
  }
  const out: Record<string, PlayStyle> = {};
  for (const profile of profiles) {
    const thin = profile.scoreCount < MIN_SCORES;
    const categories: CategoryLean[] = Object.entries(profile.categoryAffinity)
      .map(([category, affinity]) => {
        const level = levels.get(category) ?? [];
        return {
          category,
          affinity,
          accPoints: (profile.categoryAccDelta[category] ?? 0) * 100,
          maps: mapsPerCategory.get(profile.playerId)?.get(category) ?? 0,
          fieldRank: 1 + level.filter((v) => v > profile.skill + affinity).length,
          fieldSize: level.length,
        };
      })
      .sort((a, b) => b.affinity - a.affinity);

    const percentiles = {
      consistency: 1 - percentile(field.sigma, profile.sigma),
      fullCombos: percentile(field.fcRate, profile.fcRate),
    };
    const relativeSigma = profile.sigma / typicalSigma;
    const provenSteady = relativeSigma <= 0.75 && profile.cleanCount >= MIN_SCORES_FOR_CONSISTENCY;

    const traits: StyleTrait[] = [];
    if (!thin) {
      if (provenSteady) {
        traits.push({
          key: 'consistent',
          label: 'Consistent',
          detail: 'Their scores sit in a tight band, map after map. Safe to build a lineup around.',
          tone: 'good',
        });
      } else if (relativeSigma >= 1.4) {
        traits.push({
          key: 'streaky',
          label: 'Streaky',
          detail: 'Their results swing more than most players\' do. Better on a map you can afford to lose than on the decider.',
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
      } else if (profile.missRate >= 0.9 && profile.skill >= typicalSkill) {
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

    out[profile.playerId] = { playerId: profile.playerId, traits, categories, percentiles, thin };
  }
  return out;
}

/** Share of the field at or below this value, 0..1. Alone in the field is 1. */
function percentile(field: readonly number[], value: number): number {
  if (field.length <= 1) return 1;
  const below = field.filter((v) => v < value).length;
  return below / (field.length - 1);
}

/**
 * A guess at what kind of map this is, from BeatLeader's difficulty ratings.
 *
 * BeatLeader rates every map on three axes: `pass` (how hard it is to survive -
 * in practice, speed and stamina), `tech` (awkward angles, resets, patterns
 * that need reading) and `acc` (how hard it is to score well on). The community
 * labels follow from the first two:
 *
 *   speed       fast, plain patterns            pass high, tech low
 *   speed-tech  fast and awkward                pass high, tech high
 *   tech        awkward at ordinary speed       tech high
 *   low-tech    mid-speed, little tech          pass middling, tech low
 *   tech-acc    slow but awkward - an acc map that punishes lazy swings
 *   acc         slow and clean enough that the score is all about accuracy
 *   true acc    slow and entirely plain: nothing to do but swing well
 *
 * The thresholds were set by eye against real tournament pools and are not
 * official - nothing is. It is a starting point; an organiser's own label
 * always wins over it.
 */

export interface MapRatings {
  acc: number;
  pass: number;
  tech: number;
}

export type MapCategory =
  | 'speed'
  | 'speed-tech'
  | 'tech'
  | 'low-tech'
  | 'tech-acc'
  | 'acc'
  | 'true acc';

export function categorizeMap(ratings: MapRatings): MapCategory | null {
  const { pass, tech, acc } = ratings;
  // All zero means BeatLeader has not rated it, not that it is trivially easy.
  if (!(pass > 0 || tech > 0 || acc > 0)) return null;

  if (pass >= 6.5) return tech >= 5 ? 'speed-tech' : 'speed';
  if (tech >= 6) return 'tech';
  if (pass < 3) {
    if (tech < 1.5) return 'true acc';
    return tech < 3 ? 'acc' : 'tech-acc';
  }
  return tech >= 4.5 ? 'tech' : 'low-tech';
}

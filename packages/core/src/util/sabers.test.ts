import { describe, expect, it } from 'vitest';
import { colourDistance, contrastingColour, secondColourChosen, teamSabers, tooAlike, SABERS_TOO_ALIKE } from './sabers.js';

describe('team sabers', () => {
  it('uses exactly the two colours an organiser chose', () => {
    expect(teamSabers('#b3233f', '#f2ead8')).toEqual({ left: '#b3233f', right: '#f2ead8', adjusted: false });
    expect(teamSabers('#FF4D5E', '#3D9BFF')).toEqual({ left: '#ff4d5e', right: '#3d9bff', adjusted: false });
  });

  it('keeps a chosen second colour however like the first it is: that is the organiser\'s call', () => {
    expect(teamSabers('#b3233f', '#b82a45')).toEqual({ left: '#b3233f', right: '#b82a45', adjusted: false });
    expect(teamSabers('#2ecc71', '#2ecc71')).toEqual({ left: '#2ecc71', right: '#2ecc71', adjusted: false });
    // and a dark one is not touched either
    expect(teamSabers('#12020a', '#2a0510')).toEqual({ left: '#12020a', right: '#2a0510', adjusted: false });
    expect(tooAlike('#b3233f', '#b82a45')).toBe(true);      // what the Teams page warns about
  });

  it('replaces only a second colour nobody chose: what a team is made with', () => {
    // a new team's stock lilac (whatever first colour was picked), the pool's grey, the duo maker's pale tints
    for (const [a, b] of [['#4F46E5', '#A5B4FC'], ['#123456', '#a5b4fc'], ['#6b7280', '#d1d5db'], ['#ff4d5e', '#ffb3ba'], ['#3d9bff', '#b3d7ff'], ['#e0e04a', '#f3f3b5']] as const) {
      expect(secondColourChosen(a, b), `${a} + ${b}`).toBe(false);
      const s = teamSabers(a, b);
      expect(s.adjusted).toBe(true);
      expect(s.left).toBe(a.toLowerCase());
      expect(colourDistance(s.left, s.right), `${a} + ${b} -> ${s.left} + ${s.right}`).toBeGreaterThanOrEqual(SABERS_TOO_ALIKE);
    }
    // a tint is only stock beside the colour it was handed out with
    expect(secondColourChosen('#00ff00', '#ffb3ba')).toBe(true);
  });

  it('gives a team with no second colour, or a broken one, a right saber of its own', () => {
    for (const second of [null, undefined, '', 'nonsense']) {
      const s = teamSabers('#a26bfa', second);
      expect(s.adjusted).toBe(true);
      expect(tooAlike(s.left, s.right)).toBe(false);
    }
    expect(tooAlike(teamSabers('nonsense', '').left, teamSabers('nonsense', '').right)).toBe(false);
  });

  it('a made-up second colour is never like the first, whatever the first is', () => {
    for (let n = 0; n < 60; n++) {
      const first = `#${((n * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`;
      expect(tooAlike(first, contrastingColour(first)), `${first} -> ${contrastingColour(first)}`).toBe(false);
    }
    for (const grey of ['#000000', '#ffffff', '#808080', '#222222', '#dddddd']) expect(tooAlike(grey, contrastingColour(grey)), grey).toBe(false);
  });
});

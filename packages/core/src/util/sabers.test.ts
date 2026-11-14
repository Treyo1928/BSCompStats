import { describe, expect, it } from 'vitest';
import { colourDistance, contrastingColour, teamSabers, tooAlike, visible, SABERS_TOO_ALIKE } from './sabers.js';

describe('team sabers', () => {
  it('uses the team\'s two colours when they are clearly different', () => {
    expect(teamSabers('#b3233f', '#f2ead8')).toEqual({ left: '#b3233f', right: '#f2ead8', adjusted: false });
    expect(teamSabers('#ff4d5e', '#3d9bff').adjusted).toBe(false);
  });

  it('replaces a second colour that is too like the first', () => {
    // what a new team used to get, and the pale tints the duo maker used: one colour and its own lighter shade
    for (const [a, b] of [['#4F46E5', '#A5B4FC'], ['#ff4d5e', '#ffb3ba'], ['#3d9bff', '#b3d7ff'], ['#2ecc71', '#2ecc71'], ['#e0e04a', '#f3f3b5']] as const) {
      const s = teamSabers(a, b);
      expect(colourDistance(s.left, s.right), `${a} + ${b} -> ${s.left} + ${s.right}`).toBeGreaterThanOrEqual(SABERS_TOO_ALIKE);
    }
    expect(teamSabers('#2ecc71', '#2ecc71').adjusted).toBe(true);
  });

  it('gives a team with no second colour one of its own', () => {
    const s = teamSabers('#a26bfa', null);
    expect(s.adjusted).toBe(true);
    expect(tooAlike(s.left, s.right)).toBe(false);
  });

  it('never hands out two sabers that are alike, whatever the first colour', () => {
    for (let h = 0; h < 360; h += 15) {
      for (const first of [`hsl(${h})`].map(() => contrastingColour(contrastingColour(`#${(h * 46603).toString(16).padStart(6, '0').slice(0, 6)}`)))) {
        const s = teamSabers(first, first);
        expect(tooAlike(s.left, s.right), `${first} -> ${s.right}`).toBe(false);
      }
    }
    for (const grey of ['#000000', '#ffffff', '#808080', '#222222', '#dddddd']) {
      const s = teamSabers(grey, grey);
      expect(tooAlike(s.left, s.right), `${grey} -> ${s.left} + ${s.right}`).toBe(false);
    }
  });

  it('lifts a colour too dark to see as a saber, keeping its hue', () => {
    expect(visible('#2a0510')).not.toBe('#2a0510');
    expect(colourDistance(visible('#2a0510'), '#000000')).toBeGreaterThan(30);
    expect(visible('#ff4d5e')).toBe('#ff4d5e');
    const s = teamSabers('#12020a', '#f2ead8');
    expect(s.left).not.toBe('#12020a');
    expect(s.right).toBe('#f2ead8');
  });

  it('takes a colour that is not one as missing', () => {
    expect(teamSabers('nonsense', 'also nonsense').adjusted).toBe(true);
    expect(tooAlike(teamSabers('nonsense', '').left, teamSabers('nonsense', '').right)).toBe(false);
  });
});

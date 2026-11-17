import { describe, expect, it } from 'vitest';
import { hasScoreAlteringModifier, modifierMarks, noFailTriggered } from './normalize';

describe('which modifiers keep a run from counting', () => {
  it('lets through the ones that leave the score alone', () => {
    // Pro Mode, Small Cubes, Strict Angles, One Life, Four Lives, No Fail; and none at all
    for (const mods of ['', 'PM', 'SC', 'SA', 'IF', 'BE', 'NF', 'PM,IF', 'be, pm ,sa', undefined]) {
      expect(hasScoreAlteringModifier(mods), String(mods)).toBe(false);
    }
  });

  it('keeps out the ones that make the map easier or slower', () => {
    for (const mods of ['SS', 'EZ', 'NO', 'NB', 'NA', 'PM,SS', 'IF,NB', 'nf,no']) {
      expect(hasScoreAlteringModifier(mods), mods).toBe(true);
    }
  });

  it('still marks a run where No Fail kicked in', () => {
    expect(noFailTriggered('PM,NF')).toBe(true);
    expect(noFailTriggered('PM,IF')).toBe(false);
  });

  it('names the modifiers to show beside a run, never No Fail', () => {
    expect(modifierMarks('PM,IF').map((m) => m.mark)).toEqual(['PM', 'OL']);
    expect(modifierMarks('nf, be ,pm').map((m) => `${m.mark}=${m.name}`)).toEqual(['4L=Four Lives', 'PM=Pro Mode']);
    expect(modifierMarks('NF')).toEqual([]);
    expect(modifierMarks('')).toEqual([]);
    expect(modifierMarks(null)).toEqual([]);
    expect(modifierMarks('XX')).toEqual([{ mark: 'XX', name: 'XX' }]);
  });
});

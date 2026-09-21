import { describe, it, expect } from 'vitest';
import {
  currentStep,
  prepareAction,
  remainingMapIds,
  resolveMapPlan,
  isComplete,
  assertPoolIsBigEnough,
  PickBanError,
  type PickBanContext,
  type AppliedAction,
} from './pickban.js';
import { MSU_DUOS_FORMAT } from './format.js';

// Pool 1 from the scrim sheet, in sheet order.
const POOL = [
  'madeleine',
  'casino',
  'sentiment',
  'electric',
  'girlsnight',
  'konpeito',
  'spin',
];

const base = (actions: AppliedAction[] = []): PickBanContext => ({
  format: MSU_DUOS_FORMAT,
  poolMapIds: POOL,
  coinWinnerTeamId: 'maroon',
  coinLoserTeamId: 'white',
  actions,
});

/** Replays the scrim's pick/ban exactly as the sheet records it. */
function playScrim(): PickBanContext {
  const sequence: Array<[string, string]> = [
    ['maroon', 'madeleine'], // Maroon's pick
    ['white', 'casino'], // White's pick
    ['white', 'spin'], // White's ban
    ['maroon', 'electric'], // Maroon's ban
    ['white', 'sentiment'], // White's pick
    ['maroon', 'konpeito'], // Maroon's pick
  ];

  let ctx = base();
  for (const [teamId, poolMapId] of sequence) {
    const action = prepareAction(ctx, { teamId, poolMapId });
    ctx = { ...ctx, actions: [...ctx.actions, action] };
  }
  return ctx;
}

describe('pick/ban against the real scrim', () => {
  it('walks the sheet sequence and leaves the right maps standing', () => {
    const ctx = playScrim();

    expect(isComplete(ctx)).toBe(true);
    // Exactly one map went untouched - it becomes the tiebreaker.
    expect(remainingMapIds(ctx)).toEqual(['girlsnight']);
  });

  it('produces the four played maps plus the tiebreaker, in order', () => {
    const plan = resolveMapPlan(playScrim());

    expect(plan).toEqual([
      { order: 1, poolMapId: 'madeleine', isTiebreaker: false, pickedByTeamId: 'maroon' },
      { order: 2, poolMapId: 'casino', isTiebreaker: false, pickedByTeamId: 'white' },
      { order: 3, poolMapId: 'sentiment', isTiebreaker: false, pickedByTeamId: 'white' },
      { order: 4, poolMapId: 'konpeito', isTiebreaker: false, pickedByTeamId: 'maroon' },
      { order: 5, poolMapId: 'girlsnight', isTiebreaker: true, pickedByTeamId: null },
    ]);
  });

  it('assigns each step to the right team', () => {
    let ctx = base();
    const expected: Array<[string, 'PICK' | 'BAN']> = [
      ['maroon', 'PICK'],
      ['white', 'PICK'],
      ['white', 'BAN'],
      ['maroon', 'BAN'],
      ['white', 'PICK'],
      ['maroon', 'PICK'],
    ];

    for (const [teamId, type] of expected) {
      const step = currentStep(ctx)!;
      expect([step.teamId, step.type]).toEqual([teamId, type]);
      ctx = {
        ...ctx,
        actions: [...ctx.actions, prepareAction(ctx, { teamId, poolMapId: step.availableMapIds[0]! })],
      };
    }
    expect(currentStep(ctx)).toBeNull();
  });
});

describe('the state machine refuses illegal moves', () => {
  it('rejects a team acting out of turn', () => {
    const ctx = base();
    expect(() => prepareAction(ctx, { teamId: 'white', poolMapId: 'casino' })).toThrow(
      PickBanError,
    );
    try {
      prepareAction(ctx, { teamId: 'white', poolMapId: 'casino' });
    } catch (err) {
      expect((err as PickBanError).code).toBe('NOT_YOUR_TURN');
    }
  });

  it('rejects a map that was already picked - the double-click case', () => {
    let ctx = base();
    ctx = {
      ...ctx,
      actions: [prepareAction(ctx, { teamId: 'maroon', poolMapId: 'madeleine' })],
    };

    try {
      prepareAction(ctx, { teamId: 'white', poolMapId: 'madeleine' });
      expect.unreachable('should have rejected the duplicate map');
    } catch (err) {
      expect((err as PickBanError).code).toBe('MAP_ALREADY_USED');
    }
  });

  it('rejects a map that is not in the pool', () => {
    try {
      prepareAction(base(), { teamId: 'maroon', poolMapId: 'some-other-map' });
      expect.unreachable('should have rejected the foreign map');
    } catch (err) {
      expect((err as PickBanError).code).toBe('MAP_NOT_IN_POOL');
    }
  });

  it('rejects anything once pick/ban is finished', () => {
    const ctx = playScrim();
    try {
      prepareAction(ctx, { teamId: 'maroon', poolMapId: 'girlsnight' });
      expect.unreachable('should have refused a seventh action');
    } catch (err) {
      expect((err as PickBanError).code).toBe('PICKBAN_COMPLETE');
    }
  });
});

describe('undo', () => {
  it('re-derives state when the last action is dropped', () => {
    const ctx = playScrim();
    const rolledBack = { ...ctx, actions: ctx.actions.slice(0, -1) };

    const step = currentStep(rolledBack);
    expect(step).not.toBeNull();
    expect(step!.teamId).toBe('maroon');
    expect(step!.type).toBe('PICK');
    // Konpeito is free again, and so is the map that will become the tiebreaker.
    expect(step!.availableMapIds.sort()).toEqual(['girlsnight', 'konpeito']);
  });
});

describe('pool size guard', () => {
  it('accepts the 7-map pool the format was built for', () => {
    expect(() => assertPoolIsBigEnough(base())).not.toThrow();
  });

  it('refuses a pool too small to finish pick/ban', () => {
    // 6 pick/ban steps + 1 tiebreaker means 7 is the floor.
    const ctx = { ...base(), poolMapIds: POOL.slice(0, 6) };
    try {
      assertPoolIsBigEnough(ctx);
      expect.unreachable('should have refused the short pool');
    } catch (err) {
      expect((err as PickBanError).code).toBe('POOL_TOO_SMALL');
      expect((err as Error).message).toContain('at least 7');
    }
  });
});

describe('designated tiebreaker', () => {
  it('keeps the nominated map out of pick/ban and plays it last', () => {
    const format = {
      ...MSU_DUOS_FORMAT,
      tiebreaker: 'DESIGNATED' as const,
    };
    let ctx: PickBanContext = {
      format,
      poolMapIds: POOL,
      coinWinnerTeamId: 'maroon',
      coinLoserTeamId: 'white',
      designatedTiebreakerId: 'girlsnight',
      actions: [],
    };

    expect(remainingMapIds(ctx)).not.toContain('girlsnight');

    for (let i = 0; i < 6; i++) {
      const step = currentStep(ctx)!;
      ctx = {
        ...ctx,
        actions: [
          ...ctx.actions,
          prepareAction(ctx, { teamId: step.teamId, poolMapId: step.availableMapIds[0]! }),
        ],
      };
    }

    const plan = resolveMapPlan(ctx);
    expect(plan.at(-1)).toMatchObject({ poolMapId: 'girlsnight', isTiebreaker: true });
  });
});

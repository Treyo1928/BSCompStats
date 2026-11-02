import { describe, it, expect } from 'vitest';
import {
  currentStep,
  prepareAction,
  resolveMapPlan,
  isComplete,
  mapAwaitingPlay,
  PickBanError,
  type PickBanContext,
} from './pickban.js';
import { MSU_DUOS_FORMAT, MSU_DUOS_LIVE_FORMAT, parseFormat } from './format.js';

// Pool 1 from the scrim sheet, played live: pick, play, pick, play, ban, ban,
// pick, play, pick, play, then the tiebreaker.
const POOL = ['madeleine', 'casino', 'sentiment', 'electric', 'girlsnight', 'konpeito', 'spin'];

const base = (): PickBanContext => ({
  format: MSU_DUOS_LIVE_FORMAT,
  poolMapIds: POOL,
  coinWinnerTeamId: 'maroon',
  coinLoserTeamId: 'white',
  actions: [],
  playedPoolMapIds: [],
});

function act(ctx: PickBanContext, teamId: string, poolMapId: string): PickBanContext {
  return { ...ctx, actions: [...ctx.actions, prepareAction(ctx, { teamId, poolMapId })] };
}
const play = (ctx: PickBanContext, poolMapId: string): PickBanContext => ({
  ...ctx,
  playedPoolMapIds: [...(ctx.playedPoolMapIds ?? []), poolMapId],
});

function expectBlocked(ctx: PickBanContext, teamId: string, poolMapId: string) {
  try {
    prepareAction(ctx, { teamId, poolMapId });
    throw new Error('expected the step to be held');
  } catch (err) {
    expect(err).toBeInstanceOf(PickBanError);
    expect((err as PickBanError).code).toBe('PLAY_PICKED_MAP_FIRST');
  }
}

describe('play each pick (live order)', () => {
  it('defaults to picks-first, so existing formats are unchanged', () => {
    expect(MSU_DUOS_FORMAT.playOrder).toBe('PICKS_FIRST');
    expect(parseFormat({ pickBanSequence: [] }).playOrder).toBe('PICKS_FIRST');
  });

  it('holds the next step until the picked map is played', () => {
    let ctx = act(base(), 'maroon', 'madeleine');
    expect(mapAwaitingPlay(ctx)).toBe('madeleine');
    expect(currentStep(ctx)).toMatchObject({ teamId: 'white', type: 'PICK', waitingForPoolMapId: 'madeleine' });
    expectBlocked(ctx, 'white', 'casino');

    ctx = play(ctx, 'madeleine');
    expect(currentStep(ctx)?.waitingForPoolMapId).toBeNull();
    ctx = act(ctx, 'white', 'casino');
    expect(mapAwaitingPlay(ctx)).toBe('casino');
  });

  it('runs pick, play, pick, play, ban, ban, pick, play, pick, play, tiebreaker', () => {
    let ctx = base();
    const timeline: string[] = [];
    const steps: Array<[string, string]> = [
      ['maroon', 'madeleine'], // pick -> play
      ['white', 'casino'], // pick -> play
      ['white', 'spin'], // ban
      ['maroon', 'electric'], // ban
      ['white', 'sentiment'], // pick -> play
      ['maroon', 'konpeito'], // pick -> play
    ];
    for (const [team, map] of steps) {
      const type = currentStep(ctx)!.type;
      ctx = act(ctx, team, map);
      timeline.push(type.toLowerCase());
      if (type === 'PICK') {
        // the plan already contains the map, so it can be loaded and played now
        expect(resolveMapPlan(ctx).some((p) => p.poolMapId === map)).toBe(true);
        ctx = play(ctx, map);
        timeline.push('play');
      }
    }
    expect(isComplete(ctx)).toBe(true);
    const plan = resolveMapPlan(ctx);
    expect(plan.at(-1)).toMatchObject({ poolMapId: 'girlsnight', isTiebreaker: true });
    timeline.push('play'); // the tiebreaker
    expect(timeline.join(', ')).toBe('pick, play, pick, play, ban, ban, pick, play, pick, play, play');
  });

  it('bans are never held by an unplayed ban, only by unplayed picks', () => {
    let ctx = act(base(), 'maroon', 'madeleine');
    ctx = play(ctx, 'madeleine');
    ctx = act(ctx, 'white', 'casino');
    ctx = play(ctx, 'casino');
    ctx = act(ctx, 'white', 'spin'); // a ban: nothing to play
    expect(mapAwaitingPlay(ctx)).toBeNull();
    expect(() => act(ctx, 'maroon', 'electric')).not.toThrow();
  });

  it('an undo of the pick releases the hold', () => {
    let ctx = act(base(), 'maroon', 'madeleine');
    ctx = { ...ctx, actions: ctx.actions.slice(0, -1) };
    expect(mapAwaitingPlay(ctx)).toBeNull();
    expect(currentStep(ctx)).toMatchObject({ teamId: 'maroon', waitingForPoolMapId: null });
  });
});

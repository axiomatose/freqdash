import { describe, expect, it } from 'vitest';
import { MIN, SEC, T0, event, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botRestartLoop } from './botRestartLoop';

const bots = [healthyBot('votemax', T0)];
const startup = (agoMs: number, over = {}) => event({ type: 'startup', at: T0 - agoMs, ...over });

describe('BOT_RESTART_LOOP', () => {
  it('is critical for three distinct restarts within 15 minutes', () => {
    const [f] = botRestartLoop(input({ bots, events: [startup(100 * SEC), startup(60 * SEC), startup(20 * SEC)] }));
    expect(f).toMatchObject({
      rule: 'BOT_RESTART_LOOP',
      fingerprint: 'BOT_RESTART_LOOP:votemax',
      severity: 'critical',
    });
    expect(f!.evidence).toMatchObject({ count: 3, firstAt: T0 - 100 * SEC, lastAt: T0 - 20 * SEC });
  });

  it('needs three: two restarts are not a loop', () => {
    expect(botRestartLoop(input({ bots, events: [startup(60 * SEC), startup(20 * SEC)] }))).toEqual([]);
  });

  it('counts a log line and a health diff of one restart once (10 s cluster boundary)', () => {
    const doubled = [startup(100 * SEC), startup(100 * SEC - 10 * SEC, { source: 'health' }), startup(60 * SEC)];
    expect(botRestartLoop(input({ bots, events: doubled }))).toEqual([]);
    const apart = [startup(100 * SEC), startup(100 * SEC - 10 * SEC - 1, { source: 'health' }), startup(60 * SEC)];
    expect(botRestartLoop(input({ bots, events: apart }))).toHaveLength(1);
  });

  it('only looks 15 minutes back (boundary) and only at the bot own events', () => {
    const edge = [startup(15 * MIN), startup(10 * MIN), startup(MIN)];
    expect(botRestartLoop(input({ bots, events: edge }))).toHaveLength(1);
    const stale = [startup(15 * MIN + 1), startup(10 * MIN), startup(MIN)];
    expect(botRestartLoop(input({ bots, events: stale }))).toEqual([]);
    const foreign = [
      startup(3 * MIN, { botId: 'dca' }),
      startup(2 * MIN, { botId: 'dca' }),
      startup(MIN, { botId: 'dca' }),
    ];
    expect(botRestartLoop(input({ bots, events: foreign }))).toEqual([]);
  });

  it('honours a configured loop count', () => {
    const cfg = { ...input().cfg, restartLoopCount: 2 };
    expect(botRestartLoop(input({ cfg, bots, events: [startup(60 * SEC), startup(20 * SEC)] }))).toHaveLength(1);
  });
});

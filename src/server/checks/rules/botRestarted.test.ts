import { describe, expect, it } from 'vitest';
import { MIN, SEC, T0, event, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botRestarted } from './botRestarted';

const bots = [healthyBot('votemax', T0)];
const startup = (agoMs: number, over = {}) => event({ type: 'startup', at: T0 - agoMs, ...over });

describe('BOT_RESTARTED', () => {
  it('is an info finding for a restart in the last 30 minutes', () => {
    const [f] = botRestarted(input({ bots, events: [startup(10 * MIN)] }));
    expect(f).toMatchObject({ rule: 'BOT_RESTARTED', fingerprint: 'BOT_RESTARTED:votemax', severity: 'info' });
    expect(f!.evidence).toMatchObject({ count: 1, lastAt: T0 - 10 * MIN });
  });

  it('includes an event exactly 30 minutes old and excludes one a millisecond older (boundary)', () => {
    expect(botRestarted(input({ bots, events: [startup(30 * MIN)] }))).toHaveLength(1);
    expect(botRestarted(input({ bots, events: [startup(30 * MIN + 1)] }))).toEqual([]);
  });

  it('is not raised without startup events, for other bots, other types, or future events', () => {
    expect(botRestarted(input({ bots, events: [] }))).toEqual([]);
    expect(botRestarted(input({ bots, events: [startup(MIN, { botId: 'dca' })] }))).toEqual([]);
    expect(botRestarted(input({ bots, events: [startup(MIN, { type: 'fatal' })] }))).toEqual([]);
    expect(botRestarted(input({ bots, events: [startup(-MIN)] }))).toEqual([]);
  });

  it('counts a log line and a health diff of the same restart once, and separate restarts separately', () => {
    const same = [startup(5 * MIN), startup(5 * MIN - 2 * SEC, { source: 'health' })];
    expect(botRestarted(input({ bots, events: same }))[0]!.evidence).toMatchObject({ count: 1 });
    const two = [startup(5 * MIN), startup(2 * MIN)];
    const [f] = botRestarted(input({ bots, events: two }));
    expect(f!.evidence).toMatchObject({ count: 2 });
    expect(f!.detail).toContain('2 times');
  });
});

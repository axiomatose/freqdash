import { describe, expect, it } from 'vitest';
import { HOUR, MIN, T0, event, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botFatalLog } from './botFatalLog';

const bots = [healthyBot('votemax', T0)];
const fatal = (agoMs: number, over = {}) =>
  event({ type: 'fatal', at: T0 - agoMs, message: 'ValueError: boom', ...over });
const died = (agoMs: number) => event({ type: 'process_died', at: T0 - agoMs });

describe('BOT_FATAL_LOG', () => {
  it('is critical for a fatal record and carries the count and last message', () => {
    const [f] = botFatalLog(
      input({ bots, events: [died(2 * MIN + 1000), fatal(2 * MIN), fatal(MIN, { message: 'ValueError: latest' })] }),
    );
    expect(f).toMatchObject({ rule: 'BOT_FATAL_LOG', fingerprint: 'BOT_FATAL_LOG:votemax', severity: 'critical' });
    expect(f!.evidence).toMatchObject({
      count: 3,
      fatalCount: 2,
      processDiedCount: 1,
      lastMessage: 'ValueError: latest',
      lastAt: T0 - MIN,
    });
    expect(f!.detail).toContain('ValueError: latest');
  });

  it('ignores process_died alone: it is the normal shutdown message (docker restart), not a crash', () => {
    expect(botFatalLog(input({ bots, events: [died(MIN)] }))).toEqual([]);
  });

  it('counts process_died as extra evidence next to a fatal', () => {
    const [f] = botFatalLog(input({ bots, events: [fatal(MIN), died(MIN)] }));
    expect(f!.evidence).toMatchObject({ count: 2, fatalCount: 1, processDiedCount: 1 });
  });

  it('looks back exactly 60 minutes (boundary)', () => {
    expect(botFatalLog(input({ bots, events: [fatal(HOUR)] }))).toHaveLength(1);
    expect(botFatalLog(input({ bots, events: [fatal(HOUR + 1)] }))).toEqual([]);
  });

  it('is not raised without fatal records, for other bots, other event types or future events', () => {
    expect(botFatalLog(input({ bots, events: [] }))).toEqual([]);
    expect(botFatalLog(input({ bots, events: [fatal(MIN, { botId: 'dca' })] }))).toEqual([]);
    expect(botFatalLog(input({ bots, events: [event({ type: 'error', at: T0 - MIN })] }))).toEqual([]);
    expect(botFatalLog(input({ bots, events: [fatal(-MIN)] }))).toEqual([]);
  });
});

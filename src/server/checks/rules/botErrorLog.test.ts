import { describe, expect, it } from 'vitest';
import { MIN, T0, event, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botErrorLog } from './botErrorLog';

const bots = [healthyBot('votemax', T0)];
const error = (agoMs: number, message: string | undefined, over = {}) =>
  event({ type: 'error', at: T0 - agoMs, ...(message === undefined ? {} : { message }), ...over });

describe('BOT_ERROR_LOG', () => {
  it('warns for an error in the last 30 minutes', () => {
    const [f, ...rest] = botErrorLog(input({ bots, events: [error(MIN, 'Something broke')] }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      rule: 'BOT_ERROR_LOG',
      severity: 'warning',
      subject: { botId: 'votemax', kind: 'error' },
    });
    expect(f!.fingerprint).toMatch(/^BOT_ERROR_LOG:votemax:[0-9a-f]{8}$/);
    expect(f!.evidence).toMatchObject({ count: 1, sample: 'Something broke' });
  });

  it('groups repeats that differ only in numbers, hex and txids into one finding', () => {
    const events = [
      error(3 * MIN, 'Order OPXUSE-A4QY3-LM6ZY6 failed after 12 ms at 0xdeadbeef01'),
      error(2 * MIN, 'Order OKD7VW-AQRX4-HO6SQF failed after 987 ms at 0xcafebabe99'),
    ];
    const found = botErrorLog(input({ bots, events }));
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toMatchObject({ count: 2, firstAt: T0 - 3 * MIN, lastAt: T0 - 2 * MIN });
  });

  it('keeps different errors apart with different fingerprints', () => {
    const found = botErrorLog(input({ bots, events: [error(MIN, 'first problem'), error(MIN, 'second problem')] }));
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.fingerprint)).size).toBe(2);
  });

  it('counts failed order attempts, using the event type when there is no message', () => {
    const [f] = botErrorLog(input({ bots, events: [event({ type: 'order_failed', at: T0 - MIN })] }));
    expect(f!.evidence).toMatchObject({ signature: 'order_failed', type: 'order_failed' });
  });

  it('looks back exactly 30 minutes (boundary)', () => {
    expect(botErrorLog(input({ bots, events: [error(30 * MIN, 'x')] }))).toHaveLength(1);
    expect(botErrorLog(input({ bots, events: [error(30 * MIN + 1, 'x')] }))).toEqual([]);
  });

  it('ignores other bots, other event types and future events', () => {
    expect(botErrorLog(input({ bots, events: [error(MIN, 'x', { botId: 'dca' })] }))).toEqual([]);
    expect(botErrorLog(input({ bots, events: [event({ type: 'startup', at: T0 - MIN })] }))).toEqual([]);
    expect(botErrorLog(input({ bots, events: [error(-MIN, 'x')] }))).toEqual([]);
  });

  it('truncates a long message for the title', () => {
    const [f] = botErrorLog(input({ bots, events: [error(MIN, 'y'.repeat(500))] }));
    expect(f!.title.length).toBeLessThan(120);
    expect((f!.evidence as { sample: string }).sample).toHaveLength(300);
  });
});

import { describe, expect, it } from 'vitest';
import { DAY, HOUR, T0, event, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botIdentityChanged } from './botIdentityChanged';

const bots = [healthyBot('votemax', T0)];
const changed = (agoMs: number, over = {}) => event({ type: 'identity_changed', at: T0 - agoMs, ...over });

describe('BOT_IDENTITY_CHANGED', () => {
  it('is critical for an identity change in the last 24 hours and reports the latest one', () => {
    const [f] = botIdentityChanged(
      input({ bots, events: [changed(5 * HOUR), changed(HOUR, { message: 'closed trades 7 -> 0' })] }),
    );
    expect(f).toMatchObject({
      rule: 'BOT_IDENTITY_CHANGED',
      fingerprint: 'BOT_IDENTITY_CHANGED:votemax',
      severity: 'critical',
    });
    expect(f!.evidence).toMatchObject({ count: 2, lastAt: T0 - HOUR, message: 'closed trades 7 -> 0' });
    expect(f!.detail).toContain('closed trades 7 -> 0');
  });

  it('includes an event exactly 24 h old and excludes an older one (boundary)', () => {
    expect(botIdentityChanged(input({ bots, events: [changed(DAY)] }))).toHaveLength(1);
    expect(botIdentityChanged(input({ bots, events: [changed(DAY + 1)] }))).toEqual([]);
  });

  it('ignores other event types and other bots, and copes with a missing message', () => {
    expect(botIdentityChanged(input({ bots, events: [event({ type: 'startup', at: T0 - 1000 })] }))).toEqual([]);
    expect(botIdentityChanged(input({ bots, events: [changed(1000, { botId: 'dca' })] }))).toEqual([]);
    const [f] = botIdentityChanged(input({ bots, events: [changed(1000)] }));
    expect(f!.evidence).toMatchObject({ message: null });
    expect(f!.detail).not.toContain('(');
  });
});

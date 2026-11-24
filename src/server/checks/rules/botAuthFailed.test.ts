import { describe, expect, it } from 'vitest';
import { T0, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botAuthFailed } from './botAuthFailed';

describe('BOT_AUTH_FAILED', () => {
  it('is critical when the bot rejects the credentials, with a 60 s clear timer', () => {
    const bot = healthyBot('dca', T0);
    const [f] = botAuthFailed(input({ bots: [{ ...bot, health: { ...bot.health!, authFailed: true } }] }));
    expect(f).toMatchObject({
      rule: 'BOT_AUTH_FAILED',
      fingerprint: 'BOT_AUTH_FAILED:dca',
      severity: 'critical',
      clearAfterMs: 60_000,
    });
  });

  it('is not raised without an auth failure or without health data', () => {
    expect(botAuthFailed(input({ bots: [healthyBot('dca', T0)] }))).toEqual([]);
    expect(botAuthFailed(input({ bots: [{ ...healthyBot('dca', T0), health: null }] }))).toEqual([]);
  });
});

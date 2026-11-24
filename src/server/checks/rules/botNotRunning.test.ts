import { describe, expect, it } from 'vitest';
import { T0, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botNotRunning } from './botNotRunning';

function inState(state: string) {
  const bot = healthyBot('votemax', T0);
  return { ...bot, config: { ...bot.config!, state } };
}

describe('BOT_NOT_RUNNING', () => {
  it('warns when the state is not running, with a 60 s minimum duration', () => {
    const [f] = botNotRunning(input({ bots: [inState('stopped')] }));
    expect(f).toMatchObject({
      rule: 'BOT_NOT_RUNNING',
      fingerprint: 'BOT_NOT_RUNNING:votemax',
      severity: 'warning',
      minDurationMs: 60_000,
      evidence: { state: 'stopped' },
    });
  });

  it('accepts running in any letter case', () => {
    expect(botNotRunning(input({ bots: [inState('running')] }))).toEqual([]);
    expect(botNotRunning(input({ bots: [inState('RUNNING')] }))).toEqual([]);
  });

  it('is not raised without a config, or while the bot is unreachable (its config is stale then)', () => {
    expect(botNotRunning(input({ bots: [{ ...inState('stopped'), config: null }] }))).toEqual([]);
    const bot = inState('stopped');
    expect(botNotRunning(input({ bots: [{ ...bot, health: { ...bot.health!, reachable: false } }] }))).toEqual([]);
    expect(botNotRunning(input({ bots: [{ ...bot, health: null }] }))).toHaveLength(1);
  });
});

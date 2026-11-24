import { describe, expect, it } from 'vitest';
import { SEC, T0, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botStaleProcess } from './botStaleProcess';

function withProcessAge(ageMs: number | null, reachable = true) {
  const bot = healthyBot('votemax', T0);
  return { ...bot, health: { ...bot.health!, reachable, lastProcessAt: ageMs === null ? null : T0 - ageMs } };
}

describe('BOT_STALE_PROCESS', () => {
  it('needs the loop to be older than 120 s (strictly)', () => {
    expect(botStaleProcess(input({ bots: [withProcessAge(120 * SEC)] }))).toEqual([]);
    const [f] = botStaleProcess(input({ bots: [withProcessAge(120 * SEC + 1)] }));
    expect(f).toMatchObject({
      rule: 'BOT_STALE_PROCESS',
      fingerprint: 'BOT_STALE_PROCESS:votemax',
      severity: 'warning',
      clearAfterMs: 30_000,
    });
  });

  it('turns critical above 600 s (strictly)', () => {
    expect(botStaleProcess(input({ bots: [withProcessAge(600 * SEC)] }))[0]!.severity).toBe('warning');
    expect(botStaleProcess(input({ bots: [withProcessAge(600 * SEC + 1)] }))[0]!.severity).toBe('critical');
  });

  it('is not raised for a fresh loop, an unreachable bot (BOT_UNREACHABLE covers it) or missing data', () => {
    expect(botStaleProcess(input({ bots: [withProcessAge(5 * SEC)] }))).toEqual([]);
    expect(botStaleProcess(input({ bots: [withProcessAge(900 * SEC, false)] }))).toEqual([]);
    expect(botStaleProcess(input({ bots: [withProcessAge(null)] }))).toEqual([]);
    expect(botStaleProcess(input({ bots: [{ ...healthyBot('votemax', T0), health: null }] }))).toEqual([]);
  });
});

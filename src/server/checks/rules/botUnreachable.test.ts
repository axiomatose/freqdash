import { describe, expect, it } from 'vitest';
import { SEC, T0, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { botUnreachable } from './botUnreachable';

function down(over: { firstFailureAt?: number | null; unreachableSince?: number | null; authFailed?: boolean } = {}) {
  const bot = healthyBot('votemax', T0);
  return {
    ...bot,
    firstFailureAt: over.firstFailureAt === undefined ? T0 - 45 * SEC : over.firstFailureAt,
    health: {
      ...bot.health!,
      reachable: false,
      authFailed: over.authFailed ?? false,
      unreachableSince: over.unreachableSince ?? null,
    },
  };
}

describe('BOT_UNREACHABLE', () => {
  it('raises a warning with the documented fingerprint and clear timer', () => {
    const [f, ...rest] = botUnreachable(input({ bots: [down()] }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      rule: 'BOT_UNREACHABLE',
      fingerprint: 'BOT_UNREACHABLE:votemax',
      severity: 'warning',
      subject: { botId: 'votemax' },
      clearAfterMs: 30_000,
    });
    expect(f!.evidence).toMatchObject({ downMs: 45_000, since: T0 - 45_000 });
  });

  it('stays quiet below 30 s and starts exactly at 30 s (boundary)', () => {
    expect(botUnreachable(input({ bots: [down({ firstFailureAt: T0 - 29_999 })] }))).toEqual([]);
    expect(botUnreachable(input({ bots: [down({ firstFailureAt: T0 - 30_000 })] }))).toHaveLength(1);
  });

  it('turns critical at 180 s (boundary)', () => {
    expect(botUnreachable(input({ bots: [down({ firstFailureAt: T0 - 179_999 })] }))[0]!.severity).toBe('warning');
    expect(botUnreachable(input({ bots: [down({ firstFailureAt: T0 - 180_000 })] }))[0]!.severity).toBe('critical');
  });

  it('is not raised for a reachable bot, an auth failure, or a bot without health data', () => {
    expect(botUnreachable(input({ bots: [healthyBot('votemax', T0)] }))).toEqual([]);
    expect(botUnreachable(input({ bots: [down({ authFailed: true })] }))).toEqual([]);
    expect(botUnreachable(input({ bots: [{ ...down(), health: null }] }))).toEqual([]);
  });

  it('falls back to health.unreachableSince, and needs some failure start', () => {
    expect(
      botUnreachable(input({ bots: [down({ firstFailureAt: null, unreachableSince: T0 - 60_000 })] })),
    ).toHaveLength(1);
    expect(botUnreachable(input({ bots: [down({ firstFailureAt: null, unreachableSince: null })] }))).toEqual([]);
  });

  it('reports each bot separately', () => {
    const other = { ...down(), botId: 'dca', name: 'dca' };
    expect(botUnreachable(input({ bots: [down(), other] })).map((f) => f.fingerprint)).toEqual([
      'BOT_UNREACHABLE:votemax',
      'BOT_UNREACHABLE:dca',
    ]);
  });
});

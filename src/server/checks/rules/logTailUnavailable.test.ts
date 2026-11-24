import { describe, expect, it } from 'vitest';
import type { BotCheckView } from '../types';
import { MIN, T0, healthyBot, input } from '../../../../test/fixtures/incident/builders';
import { logTailUnavailable } from './logTailUnavailable';

function bot(tail: Partial<BotCheckView['logTail']>, reachable = true): BotCheckView {
  const b = healthyBot('votemax', T0);
  return { ...b, health: { ...b.health!, reachable }, logTail: { ...b.logTail, ...tail } };
}
const run = (b: BotCheckView) => logTailUnavailable(input({ bots: [b] }));

describe('LOG_TAIL_UNAVAILABLE', () => {
  it('is silent for a readable, recent log', () => {
    expect(run(bot({}))).toEqual([]);
  });

  it('is silent when no log file is configured at all', () => {
    expect(run(bot({ configured: false, available: false, file: null }))).toEqual([]);
  });

  it('warns when the configured file cannot be read, with the error, after 60 s', () => {
    const [f] = run(bot({ available: false, error: 'ENOENT' }));
    expect(f).toMatchObject({
      rule: 'LOG_TAIL_UNAVAILABLE',
      fingerprint: 'LOG_TAIL_UNAVAILABLE:votemax',
      severity: 'warning',
      minDurationMs: 60_000,
    });
    expect(f!.detail).toContain('ENOENT');
    expect(f!.evidence).toMatchObject({ available: false, error: 'ENOENT' });
  });

  it('warns for an unreadable file without an error message or file name', () => {
    const [f] = run(bot({ available: false, error: null, file: null }));
    expect(f!.detail).toContain('cannot be read.');
  });

  it('warns when the bot is reachable but its log has been silent for more than 5 minutes (boundary)', () => {
    expect(run(bot({ lastLineAt: T0 - 5 * MIN }))).toEqual([]);
    const [f] = run(bot({ lastLineAt: T0 - 5 * MIN - 1 }));
    expect(f!.detail).toContain('No new log line');
  });

  it('a silent log of an unreachable bot is expected, and a log without any line yet is not judged', () => {
    expect(run(bot({ lastLineAt: T0 - 20 * MIN }, false))).toEqual([]);
    expect(run(bot({ lastLineAt: null }))).toEqual([]);
    expect(run({ ...bot({ lastLineAt: T0 - 20 * MIN }), health: null })).toEqual([]);
  });
});

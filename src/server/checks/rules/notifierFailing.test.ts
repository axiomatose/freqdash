import { describe, expect, it } from 'vitest';
import { input } from '../../../../test/fixtures/incident/builders';
import { notifierFailing } from './notifierFailing';

describe('NOTIFIER_FAILING', () => {
  it('needs 3 consecutive failures (boundary)', () => {
    expect(notifierFailing(input({ notifierFailures: 0 }))).toEqual([]);
    expect(notifierFailing(input({ notifierFailures: 2 }))).toEqual([]);
    const [f] = notifierFailing(input({ notifierFailures: 3 }));
    expect(f).toMatchObject({
      rule: 'NOTIFIER_FAILING',
      fingerprint: 'NOTIFIER_FAILING',
      severity: 'warning',
      evidence: { consecutiveFailures: 3 },
    });
  });

  it('keeps reporting while failures continue and mentions the count', () => {
    const [f] = notifierFailing(input({ notifierFailures: 12 }));
    expect(f!.detail).toContain('12');
  });
});

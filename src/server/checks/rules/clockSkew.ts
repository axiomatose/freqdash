import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, type Rule } from '../util';

/** The host clock differs from Kraken's by more than the nonce and timestamp checks can tolerate. */
export const clockSkew: Rule = ({ cfg, clockSkewMs }) => {
  if (clockSkewMs === null) return [];
  const skew = Math.abs(clockSkewMs);
  if (skew <= cfg.clockSkewWarnMs) return [];
  const finding: RawFinding = {
    rule: 'CLOCK_SKEW',
    fingerprint: fingerprint('CLOCK_SKEW'),
    severity: skew > cfg.clockSkewCriticalMs ? 'critical' : 'warning',
    title: `Host clock differs from Kraken by ${(skew / 1000).toFixed(1)} s`,
    detail:
      `The clock of the machine running freqdash differs from Kraken's by ${(skew / 1000).toFixed(1)} s. ` +
      `Time-based checks become unreliable and signed Kraken requests can be rejected. Fix NTP time sync on the host.`,
    subject: { kind: 'clock' },
    evidence: { skewMs: clockSkewMs },
    clearAfterMs: cfg.clockSkewClearMs,
  };
  return [finding];
};

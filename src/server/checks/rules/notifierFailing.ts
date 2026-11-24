import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, type Rule } from '../util';

/** Notifications keep failing. Shown in the app only: the failing channel cannot report on itself. */
export const notifierFailing: Rule = ({ cfg, notifierFailures }) => {
  if (notifierFailures < cfg.notifierFailureThreshold) return [];
  const finding: RawFinding = {
    rule: 'NOTIFIER_FAILING',
    fingerprint: fingerprint('NOTIFIER_FAILING'),
    severity: 'warning',
    title: 'Notifications are failing',
    detail: `The last ${notifierFailures} attempts to send a notification failed. Alerts are only visible in freqdash until this is fixed; check the Discord webhook and push settings on the Status page.`,
    subject: { kind: 'notifier' },
    evidence: { consecutiveFailures: notifierFailures },
  };
  return [finding];
};

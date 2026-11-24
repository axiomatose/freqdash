import type { Severity } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { duration, fingerprint, type Rule } from '../util';

/** Endpoints whose loss blinds the reconciliation; a missing permission on any other one is only informational. */
const REQUIRED_ENDPOINTS = new Set(['Balance', 'BalanceEx', 'OpenOrders', 'ClosedOrders']);

interface Item {
  kind: string;
  endpoint: string;
  severity: Severity;
  since: number | null;
  message: string;
}

/**
 * Trouble talking to Kraken: rejected credentials (critical), a missing key permission (warning for the endpoints
 * the reconciliation needs, info for the optional ones), or transient errors that have lasted `krakenErrorSustainedMs`.
 */
export const krakenError: Rule = ({ now, cfg, kraken }) => {
  if (kraken === null) return [];
  const items = new Map<string, Item>();
  const put = (item: Item): void => {
    const key = fingerprint('KRAKEN_ERROR', item.kind, item.endpoint);
    if (!items.has(key)) items.set(key, item);
  };
  const permissionSeverity = (endpoint: string): Severity => (REQUIRED_ENDPOINTS.has(endpoint) ? 'warning' : 'info');

  for (const e of kraken.errors) {
    if (e.kind === 'auth')
      put({ kind: e.kind, endpoint: e.endpoint, severity: 'critical', since: e.since, message: e.message });
    else if (e.kind === 'permission')
      put({
        kind: e.kind,
        endpoint: e.endpoint,
        severity: permissionSeverity(e.endpoint),
        since: e.since,
        message: e.message,
      });
    else if (now - e.since >= cfg.krakenErrorSustainedMs)
      put({ kind: e.kind, endpoint: e.endpoint, severity: 'warning', since: e.since, message: e.message });
  }
  for (const endpoint of kraken.permissionDenied) {
    put({
      kind: 'permission',
      endpoint,
      severity: permissionSeverity(endpoint),
      since: null,
      message: 'Permission denied',
    });
  }

  return [...items.entries()].map(([fp, i]): RawFinding => {
    const lasting = i.since === null ? '' : ` for ${duration(now - i.since)}`;
    return {
      rule: 'KRAKEN_ERROR',
      fingerprint: fp,
      severity: i.severity,
      title: `Kraken ${i.endpoint}: ${i.kind} error`,
      detail: `Kraken ${i.endpoint} has been failing with a ${i.kind} error${lasting}: ${i.message}. ${
        i.kind === 'auth'
          ? 'Check that the read-only API key is valid and was not deleted or rotated.'
          : i.kind === 'permission'
            ? 'Enable the missing read-only permission on the API key (never a trading or withdrawal permission).'
            : 'freqdash keeps retrying.'
      }`,
      subject: { kind: i.kind },
      evidence: { kind: i.kind, endpoint: i.endpoint, since: i.since, message: i.message },
      clearAfterMs: cfg.krakenErrorClearMs,
    };
  });
};

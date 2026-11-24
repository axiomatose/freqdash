// Runs evaluate + applyLifecycle over a series of CheckInputs with an in-memory findings table, the way the poller's
// checks job will (docs/PLAN.md section 8, "Each step runs evaluate then applyLifecycle").
import { evaluate } from '@/server/checks/engine';
import { applyLifecycle, type LifecycleOptions } from '@/server/checks/lifecycle';
import type { CheckInput } from '@/server/checks/types';
import { severityRank } from '@/server/checks/util';
import type { Ms, Severity } from '@/shared/types/domain';
import type { Finding, FindingStatus, NotificationIntent } from '@/shared/types/findings';

export interface LogEntry {
  at: Ms;
  id: number;
  fingerprint: string;
  status: FindingStatus;
  severity: Severity;
  evidenceCount: number;
  flapCount: number;
}

export type Notification = NotificationIntent & { at: Ms };

export interface Run {
  /** State transitions: one entry whenever a finding's (status, severity, evidence count, flap count) changed. */
  log: LogEntry[];
  notifications: Notification[];
  /** All rows ever created, by id (latest state). */
  rows: Map<number, Finding>;
  /** Latest state of every row with this fingerprint. */
  rowsFor(fingerprint: string): Finding[];
  /** First time the finding was `active` at `minSeverity` or above, or null. */
  firstActive(fingerprint: string, minSeverity?: Severity): Ms | null;
  /** State of the finding at `at`: the last logged entry not after it (null when it did not exist yet). */
  stateAt(fingerprint: string, at: Ms): LogEntry | null;
  /** Active findings of severity >= minSeverity that were shown before `at`. */
  activeBefore(at: Ms, minSeverity: Severity): LogEntry[];
  rawFingerprints: Set<string>;
}

export function runChecks(inputs: Iterable<CheckInput>, opts: LifecycleOptions = {}): Run {
  const rows = new Map<number, Finding>();
  const log: LogEntry[] = [];
  const notifications: Notification[] = [];
  const lastLogged = new Map<number, string>();
  const rawFingerprints = new Set<string>();
  let nextId = 1;

  for (const input of inputs) {
    const raw = evaluate(input);
    for (const r of raw) rawFingerprints.add(r.fingerprint);
    // What the findings repo hands the lifecycle: open rows plus recently resolved ones.
    const prev = [...rows.values()].filter(
      (f) => f.status !== 'resolved' || (f.resolvedAt !== null && input.now - f.resolvedAt <= input.cfg.reopenWindowMs),
    );
    const res = applyLifecycle(prev, raw, input.now, input.cfg, opts);
    for (const id of res.discardIds) rows.delete(id);
    for (const draft of res.next) {
      const id = draft.id ?? nextId++;
      const row: Finding = { ...draft, id };
      rows.set(id, row);
      const entry: LogEntry = {
        at: input.now,
        id,
        fingerprint: row.fingerprint,
        status: row.status,
        severity: row.severity,
        evidenceCount: row.evidenceKeys?.length ?? 0,
        flapCount: row.flapCount,
      };
      const sig = `${entry.status}|${entry.severity}|${entry.evidenceCount}|${entry.flapCount}`;
      if (lastLogged.get(id) !== sig) {
        lastLogged.set(id, sig);
        log.push(entry);
      }
    }
    for (const n of res.notifications) notifications.push({ ...n, at: input.now });
  }

  const byFp = (fp: string): LogEntry[] => log.filter((e) => e.fingerprint === fp);
  return {
    log,
    notifications,
    rows,
    rawFingerprints,
    rowsFor: (fp) => [...rows.values()].filter((r) => r.fingerprint === fp),
    firstActive: (fp, minSeverity = 'info') =>
      byFp(fp).find((e) => e.status === 'active' && severityRank(e.severity) >= severityRank(minSeverity))?.at ?? null,
    stateAt: (fp, at) =>
      byFp(fp)
        .filter((e) => e.at <= at)
        .at(-1) ?? null,
    activeBefore: (at, minSeverity) =>
      log.filter((e) => e.at < at && e.status === 'active' && severityRank(e.severity) >= severityRank(minSeverity)),
  };
}

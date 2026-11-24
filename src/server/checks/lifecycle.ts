// Finding lifecycle (docs/PLAN.md section 8.2): dedup, minimum duration, flapping, clear timers, silence and
// notifications. Pure: previous rows in, next rows and notification intents out.
import type { Ms, Severity } from '@/shared/types/domain';
import type { Finding, NotificationIntent, RawFinding } from '@/shared/types/findings';
import type { CheckConfig } from './types';
import { maxSeverity, severityRank } from './util';

/** A finding row to persist; `id` is null for a row that does not exist yet. */
export type FindingDraft = Omit<Finding, 'id'> & { id: number | null };

export interface LifecycleOptions {
  /** Lowest severity that is announced (NOTIFY_MIN_SEVERITY). Default `warning`. */
  notifyMinSeverity?: Severity;
  /**
   * True when a finding that is no longer raised should resolve immediately instead of waiting out its clear hold. The hold
   * exists to stop automatic conditions from flapping; a human acknowledgement cannot flap, so the caller passes
   * `coveredByAcks` here.
   */
  clearNow?: (finding: Finding) => boolean;
}

export interface LifecycleResult {
  /**
   * Rows to write: every row that was created, updated, cleared, resolved or reopened in this pass. A resolved row
   * that did not change is not repeated.
   */
  next: FindingDraft[];
  notifications: NotificationIntent[];
  /**
   * Ids of `pending` rows whose raw finding vanished before the minimum duration elapsed. They were never shown or
   * announced and should be deleted rather than kept as noise.
   */
  discardIds: number[];
}

const evidenceCount = (f: { evidenceKeys?: string[] }): number => f.evidenceKeys?.length ?? 0;

/** Rules whose findings are shown in the app only (the notifier cannot report on its own failure). */
const IN_APP_ONLY = new Set<string>(['NOTIFIER_FAILING']);

function toDraft(f: Finding): FindingDraft {
  return { ...f };
}

function applyRaw(row: FindingDraft, raw: RawFinding, cfg: CheckConfig): FindingDraft {
  const next: FindingDraft = {
    ...row,
    rule: raw.rule,
    fingerprint: raw.fingerprint,
    severity: raw.severity,
    title: raw.title,
    detail: raw.detail,
    subject: raw.subject,
    evidence: raw.evidence,
    evidenceKeys: raw.evidenceKeys ?? [],
    minDurationMs: raw.minDurationMs ?? 0,
    clearAfterMs: raw.clearAfterMs ?? cfg.defaultClearAfterMs,
  };
  if (raw.escalateAfterMs !== undefined) next.escalateAfterMs = raw.escalateAfterMs;
  else delete next.escalateAfterMs;
  if (raw.escalateTo !== undefined) next.escalateTo = raw.escalateTo;
  else delete next.escalateTo;
  return next;
}

function freshRow(raw: RawFinding, now: Ms, cfg: CheckConfig): FindingDraft {
  return applyRaw(
    {
      id: null,
      rule: raw.rule,
      fingerprint: raw.fingerprint,
      severity: raw.severity,
      title: '',
      detail: '',
      subject: {},
      evidence: {},
      status: 'pending',
      maxSeverity: raw.severity,
      firstSeenAt: now,
      episodeStartAt: now,
      activeSince: null,
      lastSeenAt: now,
      clearedAt: null,
      resolvedAt: null,
      occurrences: 1,
      flapCount: 0,
      silenced: null,
      notifiedAt: null,
      notifiedSeverity: null,
      notifiedEvidenceCount: null,
    },
    raw,
    cfg,
  );
}

function reopenedRow(resolved: Finding, raw: RawFinding, now: Ms, cfg: CheckConfig): FindingDraft {
  return applyRaw(
    {
      ...toDraft(resolved),
      status: 'pending',
      episodeStartAt: now,
      activeSince: null,
      clearedAt: null,
      resolvedAt: null,
      lastSeenAt: now,
      occurrences: resolved.occurrences + 1,
      flapCount: resolved.flapCount + 1,
    },
    raw,
    cfg,
  );
}

/** A raw finding is present in this pass: refresh the row, promote it when its minimum duration elapsed, escalate. */
function refreshRow(row: FindingDraft, now: Ms): FindingDraft {
  const next: FindingDraft = { ...row, lastSeenAt: now, clearedAt: null };
  if (next.status === 'pending' && now - next.episodeStartAt >= (next.minDurationMs ?? 0)) {
    next.status = 'active';
    next.activeSince = now;
  }
  if (
    next.status === 'active' &&
    next.activeSince !== null &&
    next.escalateAfterMs !== undefined &&
    next.escalateTo !== undefined &&
    now - next.activeSince >= next.escalateAfterMs
  ) {
    next.severity = maxSeverity(next.severity, next.escalateTo);
  }
  next.maxSeverity = maxSeverity(next.maxSeverity, next.severity);
  if (
    next.silenced !== null &&
    (severityRank(next.severity) > severityRank(next.silenced.severity) ||
      evidenceCount(next) > next.silenced.evidenceCount)
  ) {
    next.silenced = null;
  }
  return next;
}

function announce(row: FindingDraft, kind: NotificationIntent['kind'], detail: string): NotificationIntent {
  return { fingerprint: row.fingerprint, findingId: row.id, kind, severity: row.severity, title: row.title, detail };
}

/** Which notification (if any) an active, visible finding earns in this pass; mutates the notified-* fields. */
function notifyFor(row: FindingDraft, now: Ms, cfg: CheckConfig, minSeverity: Severity): NotificationIntent | null {
  if (row.status !== 'active' || row.silenced !== null || IN_APP_ONLY.has(row.rule)) return null;
  if (severityRank(row.severity) < severityRank(minSeverity)) return null;

  const keys = evidenceCount(row);
  let intent: NotificationIntent | null = null;
  if (row.notifiedSeverity === null) {
    const activeFor = row.activeSince === null ? 0 : now - row.activeSince;
    if (row.severity === 'critical' || activeFor >= cfg.warningNotifyAfterMs)
      intent = announce(row, 'opened', row.detail);
  } else if (severityRank(row.severity) > severityRank(row.notifiedSeverity)) {
    intent = announce(row, 'escalated', row.detail);
  } else {
    const was = row.notifiedEvidenceCount ?? 0;
    const grew = keys > was && keys >= (was === 0 ? 1 : Math.ceil(cfg.growMinRatio * was));
    const settled = row.notifiedAt === null || now - row.notifiedAt > cfg.growCooldownMs;
    if (grew && settled) intent = announce(row, 'grew', `${keys} affected (was ${was}). ${row.detail}`);
  }
  if (intent !== null) {
    row.notifiedAt = now;
    row.notifiedSeverity = row.severity;
    row.notifiedEvidenceCount = keys;
  }
  return intent;
}

/**
 * The all-clear for a finding that was announced as critical. It is sent only after the finding stayed resolved for
 * `resolvedNotifyDelayMs`, so a finding that comes back meanwhile never produced a "resolved" message in between.
 * Sending it resets the notified-* fields: a later reopen is then announced afresh.
 */
function resolvedNotice(row: FindingDraft, now: Ms, cfg: CheckConfig): NotificationIntent | null {
  if (row.status !== 'resolved' || row.resolvedAt === null || row.silenced !== null || IN_APP_ONLY.has(row.rule))
    return null;
  if (row.notifiedSeverity !== 'critical' || now - row.resolvedAt < cfg.resolvedNotifyDelayMs) return null;
  row.notifiedAt = now;
  row.notifiedSeverity = null;
  row.notifiedEvidenceCount = null;
  return announce(row, 'resolved', `${row.title} has cleared.`);
}

/**
 * One lifecycle pass.
 *
 * `prev` must hold every `pending`/`active` row and the `resolved` rows of the last `reopenWindowMs` (they are
 * matched by fingerprint for flap detection and for the delayed resolved notice). `raw` is this pass's engine output.
 */
export function applyLifecycle(
  prev: readonly Finding[],
  raw: readonly RawFinding[],
  now: Ms,
  cfg: CheckConfig,
  opts: LifecycleOptions = {},
): LifecycleResult {
  const minSeverity = opts.notifyMinSeverity ?? 'warning';
  const next: FindingDraft[] = [];
  const notifications: NotificationIntent[] = [];
  const discardIds: number[] = [];

  const open = new Map<string, Finding>();
  const resolved = new Map<string, Finding>();
  const duplicates: Finding[] = [];
  for (const f of prev) {
    if (f.status === 'resolved') {
      const cur = resolved.get(f.fingerprint);
      if (cur === undefined || (f.resolvedAt ?? 0) > (cur.resolvedAt ?? 0)) resolved.set(f.fingerprint, f);
    } else if (open.has(f.fingerprint)) {
      duplicates.push(f);
    } else {
      open.set(f.fingerprint, f);
    }
  }

  const rawByFp = new Map<string, RawFinding>();
  for (const r of raw) {
    const cur = rawByFp.get(r.fingerprint);
    if (cur === undefined || severityRank(r.severity) > severityRank(cur.severity)) rawByFp.set(r.fingerprint, r);
  }

  for (const r of rawByFp.values()) {
    const existing = open.get(r.fingerprint);
    const lastResolved = resolved.get(r.fingerprint);
    let row: FindingDraft;
    if (existing !== undefined) {
      row = applyRaw(toDraft(existing), r, cfg);
    } else if (
      lastResolved !== undefined &&
      lastResolved.resolvedAt !== null &&
      now - lastResolved.resolvedAt <= cfg.reopenWindowMs
    ) {
      row = reopenedRow(lastResolved, r, now, cfg);
    } else {
      row = freshRow(r, now, cfg);
    }
    row = refreshRow(row, now);
    const notice = notifyFor(row, now, cfg, minSeverity);
    if (notice !== null) notifications.push(notice);
    next.push(row);
  }

  for (const f of [...open.values(), ...duplicates]) {
    if (rawByFp.has(f.fingerprint) && open.get(f.fingerprint) === f) continue;
    if (f.status === 'pending') {
      discardIds.push(f.id);
      continue;
    }
    const cleared: FindingDraft = { ...toDraft(f), clearedAt: f.clearedAt ?? now };
    const isDuplicate = duplicates.includes(f);
    const heldLongEnough = now - (cleared.clearedAt ?? now) >= (cleared.clearAfterMs ?? cfg.defaultClearAfterMs);
    if (isDuplicate || heldLongEnough || opts.clearNow?.(f) === true) {
      cleared.status = 'resolved';
      cleared.resolvedAt = now;
      const notice = isDuplicate ? null : resolvedNotice(cleared, now, cfg);
      if (notice !== null) notifications.push(notice);
    }
    next.push(cleared);
  }

  for (const f of resolved.values()) {
    // a finding that is present again (reopened or created anew) must not get a stale all-clear
    if (rawByFp.has(f.fingerprint)) continue;
    const row = toDraft(f);
    const notice = resolvedNotice(row, now, cfg);
    if (notice !== null) {
      notifications.push(notice);
      next.push(row);
    }
  }

  return { next, notifications, discardIds };
}

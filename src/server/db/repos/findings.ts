import 'server-only';
import type { Ms, Severity } from '@/shared/types/domain';
import type { Finding, FindingStatus, FindingSubject, RuleId } from '@/shared/types/findings';
import { chunk, clipText, getDb, parseJson, placeholders } from '../client';

// Findings (`findings` table): the persisted output of the pure lifecycle (docs/PLAN.md section 8.2).
//
// Invariants enforced by the schema:
//  * at most one OPEN (pending/active) row per fingerprint (partial unique index `ux_findings_open`);
//  * `status` is one of pending/active/resolved (CHECK).
//
// Concurrency note for the checks job: read `prev` (listFindings), run evaluate + applyLifecycle and call
// saveLifecycle in ONE synchronous stretch, with no `await` in between. saveLifecycle writes the drafts verbatim,
// including their `silenced` field (the lifecycle lifts a silence by sending `silenced: null`), so a silence() call
// that lands between the read and the save would otherwise be overwritten.
//
// Free text (title, detail, evidence) is built by the rules from already-redacted event messages; the repo stores it
// as given and never redacts. Callers that put raw error text in a finding must pass it through `redactSecrets`.

/**
 * What the lifecycle hands to saveLifecycle: a `Finding` without its database id. `id` is the row to update, or
 * `null` for a row to insert. Every `Finding` (id: number) is also a valid draft.
 */
export type FindingDraft = Omit<Finding, 'id'> & { id: number | null };

export interface SaveLifecycleResult {
  /** Row id of each draft, in input order: existing ids are echoed, inserted rows get their new id. */
  ids: number[];
  /**
   * Ids of the rows this call inserted, keyed by fingerprint (use them to fill `NotificationIntent.findingId`).
   * If a batch inserted two rows with one fingerprint (one of them resolved), the open row wins.
   */
  newIds: Record<string, number>;
}

export interface ListFindingsOptions {
  /** One status or several. Omit for every status (including `pending`, which the UI must not show). */
  status?: FindingStatus | readonly FindingStatus[];
  severity?: Severity | readonly Severity[];
  /** true: only silenced rows, false: only rows that are not silenced. */
  silenced?: boolean;
  fingerprint?: string;
  /** Inclusive lower bound on `resolvedAt` (implies resolved rows only). */
  resolvedSince?: Ms;
  limit?: number;
}

interface FindingRow {
  id: number;
  fingerprint: string;
  rule: string;
  severity: string;
  max_severity: string;
  status: string;
  title: string;
  detail: string;
  subject_json: string;
  evidence_json: string;
  evidence_keys_json: string;
  min_duration_ms: number;
  clear_after_ms: number;
  escalate_after_ms: number | null;
  escalate_to: string | null;
  first_seen_at: number;
  episode_start_at: number;
  active_since: number | null;
  last_seen_at: number;
  cleared_at: number | null;
  resolved_at: number | null;
  occurrences: number;
  flap_count: number;
  silenced_at: number | null;
  silenced_by: string | null;
  silenced_note: string | null;
  silenced_severity: string | null;
  silenced_evidence_count: number | null;
  notified_at: number | null;
  notified_severity: string | null;
  notified_evidence_count: number | null;
}

const SEVERITY_RANK_SQL = "CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END";

function toFinding(row: FindingRow): Finding {
  const evidenceKeys = parseJson<string[]>(row.evidence_keys_json, []);
  const finding: Finding = {
    id: row.id,
    rule: row.rule as RuleId,
    fingerprint: row.fingerprint,
    severity: row.severity as Severity,
    title: row.title,
    detail: row.detail,
    subject: parseJson<FindingSubject>(row.subject_json, {}),
    evidence: parseJson<Record<string, unknown>>(row.evidence_json, {}),
    evidenceKeys,
    minDurationMs: row.min_duration_ms,
    clearAfterMs: row.clear_after_ms,
    status: row.status as FindingStatus,
    maxSeverity: row.max_severity as Severity,
    firstSeenAt: row.first_seen_at,
    episodeStartAt: row.episode_start_at,
    activeSince: row.active_since,
    lastSeenAt: row.last_seen_at,
    clearedAt: row.cleared_at,
    resolvedAt: row.resolved_at,
    occurrences: row.occurrences,
    flapCount: row.flap_count,
    silenced:
      row.silenced_at === null
        ? null
        : {
            at: row.silenced_at,
            by: row.silenced_by,
            note: row.silenced_note,
            severity: (row.silenced_severity ?? row.severity) as Severity,
            evidenceCount: row.silenced_evidence_count ?? evidenceKeys.length,
          },
    notifiedAt: row.notified_at,
    notifiedSeverity: row.notified_severity as Severity | null,
    notifiedEvidenceCount: row.notified_evidence_count,
  };
  if (row.escalate_after_ms !== null) finding.escalateAfterMs = row.escalate_after_ms;
  if (row.escalate_to !== null) finding.escalateTo = row.escalate_to as Severity;
  return finding;
}

function asList<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

export function listFindings(options: ListFindingsOptions = {}): Finding[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  let resolvedOnly = false;

  if (options.status !== undefined) {
    const statuses = asList(options.status);
    if (statuses.length === 0) return [];
    where.push(`status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
    resolvedOnly = statuses.every((s) => s === 'resolved');
  }
  if (options.severity !== undefined) {
    const severities = asList(options.severity);
    if (severities.length === 0) return [];
    where.push(`severity IN (${placeholders(severities.length)})`);
    params.push(...severities);
  }
  if (options.silenced !== undefined) where.push(options.silenced ? 'silenced_at IS NOT NULL' : 'silenced_at IS NULL');
  if (options.fingerprint !== undefined) {
    where.push('fingerprint = ?');
    params.push(options.fingerprint);
  }
  if (options.resolvedSince !== undefined) {
    where.push("status = 'resolved' AND resolved_at >= ?");
    params.push(options.resolvedSince);
    resolvedOnly = true;
  }

  // Open findings first, most severe first; a resolved-only list is newest-resolved first.
  const orderBy = resolvedOnly
    ? 'resolved_at DESC, id DESC'
    : `(status = 'resolved') ASC, ${SEVERITY_RANK_SQL} DESC, last_seen_at DESC, id DESC`;
  let sql = `SELECT * FROM findings${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}`;
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(Math.max(0, Math.floor(options.limit)));
  }
  return (
    getDb()
      .prepare(sql)
      .all(...params) as FindingRow[]
  ).map(toFinding);
}

export function getFinding(id: number): Finding | null {
  const row = getDb().prepare('SELECT * FROM findings WHERE id = ?').get(id) as FindingRow | undefined;
  return row === undefined ? null : toFinding(row);
}

function bindings(draft: FindingDraft): Record<string, string | number | null> {
  const keys = draft.evidenceKeys ?? [];
  return {
    fingerprint: draft.fingerprint,
    rule: draft.rule,
    severity: draft.severity,
    maxSeverity: draft.maxSeverity,
    status: draft.status,
    title: draft.title,
    detail: draft.detail,
    subjectJson: JSON.stringify(draft.subject),
    evidenceJson: JSON.stringify(draft.evidence),
    evidenceKeysJson: JSON.stringify(keys),
    minDurationMs: draft.minDurationMs ?? 0,
    clearAfterMs: draft.clearAfterMs ?? 30_000,
    escalateAfterMs: draft.escalateAfterMs ?? null,
    escalateTo: draft.escalateTo ?? null,
    firstSeenAt: draft.firstSeenAt,
    episodeStartAt: draft.episodeStartAt,
    activeSince: draft.activeSince,
    lastSeenAt: draft.lastSeenAt,
    clearedAt: draft.clearedAt,
    resolvedAt: draft.resolvedAt,
    occurrences: draft.occurrences,
    flapCount: draft.flapCount,
    silencedAt: draft.silenced?.at ?? null,
    silencedBy: draft.silenced?.by ?? null,
    silencedNote: draft.silenced?.note ?? null,
    silencedSeverity: draft.silenced?.severity ?? null,
    silencedEvidenceCount: draft.silenced?.evidenceCount ?? null,
    notifiedAt: draft.notifiedAt,
    notifiedSeverity: draft.notifiedSeverity,
    notifiedEvidenceCount: draft.notifiedEvidenceCount,
  };
}

const INSERT_SQL = `INSERT INTO findings (fingerprint, rule, severity, max_severity, status, title, detail, subject_json,
    evidence_json, evidence_keys_json, min_duration_ms, clear_after_ms, escalate_after_ms, escalate_to, first_seen_at,
    episode_start_at, active_since, last_seen_at, cleared_at, resolved_at, occurrences, flap_count, silenced_at,
    silenced_by, silenced_note, silenced_severity, silenced_evidence_count, notified_at, notified_severity,
    notified_evidence_count)
  VALUES (@fingerprint, @rule, @severity, @maxSeverity, @status, @title, @detail, @subjectJson, @evidenceJson,
    @evidenceKeysJson, @minDurationMs, @clearAfterMs, @escalateAfterMs, @escalateTo, @firstSeenAt, @episodeStartAt,
    @activeSince, @lastSeenAt, @clearedAt, @resolvedAt, @occurrences, @flapCount, @silencedAt, @silencedBy,
    @silencedNote, @silencedSeverity, @silencedEvidenceCount, @notifiedAt, @notifiedSeverity, @notifiedEvidenceCount)`;

// fingerprint and rule identify the row and never change.
const UPDATE_SQL = `UPDATE findings SET severity = @severity, max_severity = @maxSeverity, status = @status,
    title = @title, detail = @detail, subject_json = @subjectJson, evidence_json = @evidenceJson,
    evidence_keys_json = @evidenceKeysJson, min_duration_ms = @minDurationMs, clear_after_ms = @clearAfterMs,
    escalate_after_ms = @escalateAfterMs, escalate_to = @escalateTo, first_seen_at = @firstSeenAt,
    episode_start_at = @episodeStartAt, active_since = @activeSince, last_seen_at = @lastSeenAt,
    cleared_at = @clearedAt, resolved_at = @resolvedAt, occurrences = @occurrences, flap_count = @flapCount,
    silenced_at = @silencedAt, silenced_by = @silencedBy, silenced_note = @silencedNote,
    silenced_severity = @silencedSeverity, silenced_evidence_count = @silencedEvidenceCount,
    notified_at = @notifiedAt, notified_severity = @notifiedSeverity,
    notified_evidence_count = @notifiedEvidenceCount
  WHERE id = @id`;

/**
 * Writes the lifecycle output in ONE transaction: any failure (constraint violation, unknown id, unserializable
 * evidence) rolls the whole batch back and rethrows, so the table never holds a half-applied cycle.
 *
 *  * `id: null` drafts are inserted, the others update the row with that id (unknown id throws).
 *  * Rows in `prev` that the drafts do not mention are left untouched.
 *  * Statement order avoids tripping the unique-open-fingerprint index: rows that end `resolved` are written first,
 *    then the other updates, then the inserts.
 */
export function saveLifecycle(drafts: readonly FindingDraft[]): SaveLifecycleResult {
  if (drafts.length === 0) return { ids: [], newIds: {} };
  const db = getDb();
  const insert = db.prepare(INSERT_SQL);
  const update = db.prepare(UPDATE_SQL);

  // 0 update-to-resolved, 1 update-to-open, 2 insert-resolved, 3 insert-open (rows that free the index go first).
  const phase = (d: FindingDraft): number => (d.id === null ? 2 : 0) + (d.status === 'resolved' ? 0 : 1);
  const order = drafts
    .map((draft, index) => ({ index, phase: phase(draft) }))
    .sort((a, b) => a.phase - b.phase || a.index - b.index)
    .map((entry) => entry.index);

  return db
    .transaction((): SaveLifecycleResult => {
      const ids: number[] = new Array<number>(drafts.length).fill(0);
      const newIds: Record<string, number> = {};
      for (const index of order) {
        const draft = drafts[index] as FindingDraft;
        if (draft.id === null) {
          const id = Number(insert.run(bindings(draft)).lastInsertRowid);
          ids[index] = id;
          if (newIds[draft.fingerprint] === undefined || draft.status !== 'resolved') newIds[draft.fingerprint] = id;
        } else {
          const result = update.run({ ...bindings(draft), id: draft.id });
          if (result.changes === 0) throw new Error(`finding ${draft.id} does not exist`);
          ids[index] = draft.id;
        }
      }
      return { ids, newIds };
    })
    .immediate();
}

export interface SilenceOptions {
  by?: string | null;
  /** Free text from the user; clipped to MAX_TEXT_LENGTH. */
  note?: string | null;
}

/**
 * Silences an open finding as of `now`, remembering the severity and evidence count at that moment (the lifecycle
 * lifts the silence when either grows). Re-silencing refreshes the baseline. Returns the finding, or null when the
 * id does not exist. A resolved finding is returned unchanged.
 */
export function silence(id: number, options: SilenceOptions, now: Ms): Finding | null {
  const db = getDb();
  return db
    .transaction((): Finding | null => {
      const finding = getFinding(id);
      if (finding === null || finding.status === 'resolved') return finding;
      db.prepare(
        `UPDATE findings SET silenced_at = @at, silenced_by = @by, silenced_note = @note, silenced_severity = @severity,
         silenced_evidence_count = @count WHERE id = @id`,
      ).run({
        at: now,
        by: options.by ?? null,
        note: clipText(options.note ?? null),
        severity: finding.severity,
        count: (finding.evidenceKeys ?? []).length,
        id,
      });
      return getFinding(id);
    })
    .immediate();
}

/** Clears the silence. Returns the finding, or null when the id does not exist. */
export function unsilence(id: number): Finding | null {
  getDb()
    .prepare(
      `UPDATE findings SET silenced_at = NULL, silenced_by = NULL, silenced_note = NULL, silenced_severity = NULL,
         silenced_evidence_count = NULL WHERE id = ?`,
    )
    .run(id);
  return getFinding(id);
}

export const RESOLVED_FINDING_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Retention: resolved findings are deleted 90 days after they resolved. Returns the rows deleted. */
export function pruneResolvedFindings(now: Ms): number {
  return getDb()
    .prepare("DELETE FROM findings WHERE status = 'resolved' AND COALESCE(resolved_at, last_seen_at) < ?")
    .run(now - RESOLVED_FINDING_RETENTION_MS).changes;
}

/** Removes rows outright (pending findings that vanished before they were ever shown). Returns the rows deleted. */
export function deleteFindings(ids: readonly number[]): number {
  if (ids.length === 0) return 0;
  return getDb()
    .transaction((): number => {
      let deleted = 0;
      for (const part of chunk(ids)) {
        deleted += getDb()
          .prepare(`DELETE FROM findings WHERE id IN (${placeholders(part.length)})`)
          .run(...part).changes;
      }
      return deleted;
    })
    .immediate();
}

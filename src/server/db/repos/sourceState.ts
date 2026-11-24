import 'server-only';
import type { Ms, SourceKey } from '@/shared/types/domain';
import { clipText, getDb, parseJson } from '../client';

// Per-source poller bookkeeping (`source_state`), persisted so freshness survives a restart.

export interface SourceStateInput {
  source: SourceKey;
  lastOkAt: Ms | null;
  lastAttemptAt: Ms | null;
  consecutiveFailures: number;
  /**
   * Free text. The CALLER must pass it through `redactSecrets` (server/log.ts) first: this repo stores what it is
   * given. Clipped to MAX_TEXT_LENGTH.
   */
  lastError: string | null;
  /** Opaque JSON-serializable state of the job. `undefined` keeps the stored payload, `null` clears it. */
  payload?: unknown;
}

export interface PersistedSourceState {
  source: SourceKey;
  lastOkAt: Ms | null;
  lastAttemptAt: Ms | null;
  consecutiveFailures: number;
  lastError: string | null;
  payload: unknown;
  updatedAt: Ms;
}

interface SourceStateRow {
  source: string;
  last_ok_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
  payload_json: string | null;
  updated_at: number;
}

/** Upserts one source. `now` becomes `updatedAt`. */
export function saveSourceState(state: SourceStateInput, now: Ms): void {
  const setPayload = state.payload !== undefined;
  getDb()
    .prepare(
      `INSERT INTO source_state (source, last_ok_at, last_attempt_at, consecutive_failures, last_error, payload_json, updated_at)
       VALUES (@source, @lastOkAt, @lastAttemptAt, @consecutiveFailures, @lastError, @payloadJson, @updatedAt)
       ON CONFLICT(source) DO UPDATE SET
         last_ok_at = excluded.last_ok_at,
         last_attempt_at = excluded.last_attempt_at,
         consecutive_failures = excluded.consecutive_failures,
         last_error = excluded.last_error,
         payload_json = CASE WHEN @setPayload = 1 THEN excluded.payload_json ELSE source_state.payload_json END,
         updated_at = excluded.updated_at`,
    )
    .run({
      source: state.source,
      lastOkAt: state.lastOkAt,
      lastAttemptAt: state.lastAttemptAt,
      consecutiveFailures: state.consecutiveFailures,
      lastError: clipText(state.lastError),
      payloadJson: setPayload && state.payload !== null ? JSON.stringify(state.payload) : null,
      setPayload: setPayload ? 1 : 0,
      updatedAt: now,
    });
}

/** Every persisted source, keyed by source key (used to hydrate the state store on boot). */
export function loadSourceStates(): Record<SourceKey, PersistedSourceState> {
  const rows = getDb().prepare('SELECT * FROM source_state ORDER BY source').all() as SourceStateRow[];
  const out: Record<SourceKey, PersistedSourceState> = {};
  for (const row of rows) {
    out[row.source] = {
      source: row.source,
      lastOkAt: row.last_ok_at,
      lastAttemptAt: row.last_attempt_at,
      consecutiveFailures: row.consecutive_failures,
      lastError: row.last_error,
      payload: parseJson<unknown>(row.payload_json, null),
      updatedAt: row.updated_at,
    };
  }
  return out;
}

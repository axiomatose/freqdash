import 'server-only';
import type { Ms } from '@/shared/types/domain';
import { DEFAULT_PUSH_PREFS, type PushPrefs } from '@/shared/types/push';
import { clipText, getDb } from '../client';

// Web Push subscriptions (`push_subscriptions`) and the announced-trade ledger (`push_trade_events`).

export const PUSH_TRADE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PushSubscriptionRecord {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  prefs: PushPrefs;
  createdAt: Ms;
  lastOkAt: Ms | null;
  lastError: string | null;
  lastErrorAt: Ms | null;
  failures: number;
}

interface Row {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  prefs_json: string;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  failures: number;
}

/** Stored prefs merged over the defaults, so a pref added later reads as its default on old rows. */
export function parsePrefs(json: string): PushPrefs {
  try {
    const raw = JSON.parse(json) as Partial<PushPrefs>;
    return { ...DEFAULT_PUSH_PREFS, ...(typeof raw === 'object' && raw !== null ? raw : {}) };
  } catch {
    return { ...DEFAULT_PUSH_PREFS };
  }
}

const toRecord = (r: Row): PushSubscriptionRecord => ({
  id: r.id,
  userId: r.user_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  label: r.label,
  prefs: parsePrefs(r.prefs_json),
  createdAt: r.created_at,
  lastOkAt: r.last_ok_at,
  lastError: r.last_error,
  lastErrorAt: r.last_error_at,
  failures: r.failures,
});

export interface UpsertPushSubscription {
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  prefs: PushPrefs;
}

/**
 * Inserts the subscription, or takes over an existing row with the same endpoint (a browser re-subscribing, or another
 * user signing in on the same device). Keys, owner, label and prefs are replaced; delivery history is reset.
 */
export function upsertPushSubscription(sub: UpsertPushSubscription, now: Ms): PushSubscriptionRecord {
  const row = getDb()
    .prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label, prefs_json, created_at)
       VALUES (@userId, @endpoint, @p256dh, @auth, @label, @prefs, @now)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         label = excluded.label, prefs_json = excluded.prefs_json, created_at = excluded.created_at,
         last_ok_at = NULL, last_error = NULL, last_error_at = NULL, failures = 0
       RETURNING *`,
    )
    .get({
      userId: sub.userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      label: sub.label,
      prefs: JSON.stringify(sub.prefs),
      now,
    }) as Row;
  return toRecord(row);
}

export function listPushSubscriptions(userId?: number): PushSubscriptionRecord[] {
  const rows =
    userId === undefined
      ? getDb().prepare('SELECT * FROM push_subscriptions ORDER BY id').all()
      : getDb().prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(userId);
  return (rows as Row[]).map(toRecord);
}

export function getPushSubscription(id: number): PushSubscriptionRecord | null {
  const row = getDb().prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as Row | undefined;
  return row === undefined ? null : toRecord(row);
}

/** Only the owner's row is changed. Returns the updated record, or null. */
export function updatePushPrefs(id: number, userId: number, prefs: PushPrefs): PushSubscriptionRecord | null {
  const row = getDb()
    .prepare('UPDATE push_subscriptions SET prefs_json = ? WHERE id = ? AND user_id = ? RETURNING *')
    .get(JSON.stringify(prefs), id, userId) as Row | undefined;
  return row === undefined ? null : toRecord(row);
}

/** With `userId`, only the owner's row is deleted. */
export function deletePushSubscription(id: number, userId?: number): boolean {
  const db = getDb();
  return userId === undefined
    ? db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes > 0
    : db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function recordPushResult(id: number, ok: boolean, error: string | null, now: Ms): void {
  if (ok) {
    getDb()
      .prepare('UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL, failures = 0 WHERE id = ?')
      .run(now, id);
  } else {
    getDb()
      .prepare('UPDATE push_subscriptions SET last_error = ?, last_error_at = ?, failures = failures + 1 WHERE id = ?')
      .run(clipText(error), now, id);
  }
}

/** True the first time a key is claimed: the caller announces the event; later calls (and restarts) get false. */
export function claimPushTradeEvent(key: string, botId: string, at: Ms, now: Ms): boolean {
  return (
    getDb()
      .prepare('INSERT OR IGNORE INTO push_trade_events (key, bot_id, at, created_at) VALUES (?, ?, ?, ?)')
      .run(key, botId, at, now).changes === 1
  );
}

export function prunePushTradeEvents(now: Ms): number {
  return getDb()
    .prepare('DELETE FROM push_trade_events WHERE created_at < ?')
    .run(now - PUSH_TRADE_EVENT_RETENTION_MS).changes;
}

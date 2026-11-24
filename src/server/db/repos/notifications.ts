import 'server-only';
import type { Ms, Severity } from '@/shared/types/domain';
import { clipText, getDb } from '../client';

// Audit trail of every notification attempt (`notifications_log`), kept 30 days.

export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface NotificationLogEntry {
  at: Ms;
  /** 'discord' | 'push' */
  channel: string;
  fingerprint: string | null;
  /** 'opened' | 'escalated' | 'grew' | 'resolved' | 'started' | 'test' | ... */
  kind: string;
  severity: Severity;
  ok: boolean;
  /**
   * Free text. The CALLER must pass it through `redactSecrets` (server/log.ts) first: a failed webhook call's error
   * can carry the webhook URL. This repo stores what it is given. Clipped to MAX_TEXT_LENGTH.
   */
  error?: string | null;
}

export interface LoggedNotification extends Omit<NotificationLogEntry, 'error'> {
  id: number;
  error: string | null;
}

export interface ListNotificationsOptions {
  since?: Ms;
  channel?: string;
  limit?: number;
}

interface NotificationRow {
  id: number;
  at: number;
  channel: string;
  fingerprint: string | null;
  kind: string;
  severity: string;
  ok: number;
  error: string | null;
}

/** Records one delivery attempt and returns its row id. */
export function logNotification(entry: NotificationLogEntry): number {
  const result = getDb()
    .prepare(
      `INSERT INTO notifications_log (at, channel, fingerprint, kind, severity, ok, error)
       VALUES (@at, @channel, @fingerprint, @kind, @severity, @ok, @error)`,
    )
    .run({
      at: entry.at,
      channel: entry.channel,
      fingerprint: entry.fingerprint,
      kind: entry.kind,
      severity: entry.severity,
      ok: entry.ok ? 1 : 0,
      error: clipText(entry.error ?? null),
    });
  return Number(result.lastInsertRowid);
}

/** Newest first. */
export function listNotifications(options: ListNotificationsOptions = {}): LoggedNotification[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.since !== undefined) {
    where.push('at >= ?');
    params.push(options.since);
  }
  if (options.channel !== undefined) {
    where.push('channel = ?');
    params.push(options.channel);
  }
  let sql = `SELECT * FROM notifications_log${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC`;
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(Math.max(0, Math.floor(options.limit)));
  }
  return (
    getDb()
      .prepare(sql)
      .all(...params) as NotificationRow[]
  ).map((row) => ({
    id: row.id,
    at: row.at,
    channel: row.channel,
    fingerprint: row.fingerprint,
    kind: row.kind,
    severity: row.severity as Severity,
    ok: row.ok === 1,
    error: row.error,
  }));
}

/** Retention: 30 days. Returns the rows deleted. */
export function pruneNotifications(now: Ms): number {
  return getDb()
    .prepare('DELETE FROM notifications_log WHERE at < ?')
    .run(now - NOTIFICATION_RETENTION_MS).changes;
}

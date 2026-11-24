import 'server-only';
import type { Acknowledgement, Ms } from '@/shared/types/domain';
import { clipText, getDb } from '../client';

// Operator acknowledgements (`acknowledgements`): "this holding/order is mine, stop flagging it".
//
// The schema allows one un-revoked ack per (kind, subject) (partial unique index `ux_acks_active`). Note that an
// expired ack that was never revoked still occupies that slot, so createAcks revokes it too. "Active" everywhere
// below means: not revoked AND (no expiry OR expiry in the future).

export type AckKind = Acknowledgement['kind'];

export interface CreateAcksInput {
  kind: AckKind;
  /** One ack is created per distinct subject (asset ticker or Kraken txid). */
  subjects: readonly string[];
  label: Acknowledgement['label'];
  note?: string | null;
  /** Quantity the ack covers (asset acks); null covers any amount. */
  qtyBaseline?: number | null;
  expiresAt?: Ms | null;
  createdBy?: string | null;
}

export interface ListAcksOptions {
  /** Include revoked and expired acks. Default false (active only). */
  includeInactive?: boolean;
  kind?: AckKind;
}

interface AckRow {
  id: number;
  kind: string;
  subject: string;
  label: string;
  note: string | null;
  qty_baseline: number | null;
  created_at: number;
  created_by: string | null;
  expires_at: number | null;
  revoked_at: number | null;
}

function toAck(row: AckRow): Acknowledgement {
  return {
    id: row.id,
    kind: row.kind as AckKind,
    subject: row.subject,
    label: row.label as Acknowledgement['label'],
    note: row.note,
    qtyBaseline: row.qty_baseline,
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/** Acknowledgements as of `now`, newest first. Active only unless `includeInactive`. */
export function listAcks(now: Ms, options: ListAcksOptions = {}): Acknowledgement[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.includeInactive !== true) {
    where.push('revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)');
    params.push(now);
  }
  if (options.kind !== undefined) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  const sql = `SELECT * FROM acknowledgements${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`;
  return (
    getDb()
      .prepare(sql)
      .all(...params) as AckRow[]
  ).map(toAck);
}

/**
 * Creates one ack per distinct subject in a single transaction. Any un-revoked ack for the same (kind, subject) is
 * revoked first (by the same `createdBy`, at `now`), so the new one replaces it atomically. Returns the created acks
 * in subject order. `note` is user text and is clipped to MAX_TEXT_LENGTH.
 */
export function createAcks(input: CreateAcksInput, now: Ms): Acknowledgement[] {
  const subjects = [...new Set(input.subjects.map((s) => s.trim()))];
  if (subjects.some((s) => s === '')) throw new RangeError('ack subject must not be empty');
  if (subjects.length === 0) return [];

  const db = getDb();
  const revoke = db.prepare(
    `UPDATE acknowledgements SET revoked_at = @now, revoked_by = @by
     WHERE kind = @kind AND subject = @subject AND revoked_at IS NULL`,
  );
  const insert = db.prepare(
    `INSERT INTO acknowledgements (kind, subject, label, note, qty_baseline, created_at, created_by, expires_at)
     VALUES (@kind, @subject, @label, @note, @qtyBaseline, @now, @by, @expiresAt)`,
  );
  const select = db.prepare('SELECT * FROM acknowledgements WHERE id = ?');
  const by = input.createdBy ?? null;

  return db
    .transaction((): Acknowledgement[] => {
      const created: Acknowledgement[] = [];
      for (const subject of subjects) {
        revoke.run({ now, by, kind: input.kind, subject });
        const id = Number(
          insert.run({
            kind: input.kind,
            subject,
            label: input.label,
            note: clipText(input.note ?? null),
            qtyBaseline: input.qtyBaseline ?? null,
            now,
            by,
            expiresAt: input.expiresAt ?? null,
          }).lastInsertRowid,
        );
        created.push(toAck(select.get(id) as AckRow));
      }
      return created;
    })
    .immediate();
}

/** Revokes an un-revoked ack. Returns false when the id does not exist or was already revoked. */
export function revokeAck(id: number, revokedBy: string | null, now: Ms): boolean {
  return (
    getDb()
      .prepare('UPDATE acknowledgements SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, revokedBy, id).changes > 0
  );
}

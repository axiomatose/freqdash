import 'server-only';
import type { Asset, LedgerEntry, Ms } from '@/shared/types/domain';
import { getDb, placeholders } from '../client';

// The full Kraken ledger (`kraken_ledger`), the source for holdings that did not come from an order. Ledger entries
// are immutable, so re-syncing a window is harmless.

export type LedgerEntryInput = LedgerEntry & { raw?: unknown };

export interface ListLedgerOptions {
  since?: Ms;
  /** Empty array matches nothing; omit for all assets. */
  assets?: readonly Asset[];
}

interface LedgerRow {
  ledger_id: string;
  refid: string | null;
  at: number;
  type: string;
  subtype: string | null;
  asset: string;
  amount: number;
  fee: number;
}

export function upsertLedgerEntries(entries: readonly LedgerEntryInput[]): void {
  if (entries.length === 0) return;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO kraken_ledger (ledger_id, refid, at, type, subtype, asset, amount, fee, raw_json)
     VALUES (@ledgerId, @refid, @at, @type, @subtype, @asset, @amount, @fee, @rawJson)
     ON CONFLICT(ledger_id) DO UPDATE SET
       refid = excluded.refid, at = excluded.at, type = excluded.type, subtype = excluded.subtype,
       asset = excluded.asset, amount = excluded.amount, fee = excluded.fee, raw_json = excluded.raw_json`,
  );
  db.transaction(() => {
    for (const input of entries) {
      const { raw, ...entry } = input;
      upsert.run({ ...entry, rawJson: JSON.stringify(raw ?? entry) });
    }
  })();
}

/** Entries in chronological order. */
export function listLedgerEntries(options: ListLedgerOptions = {}): LedgerEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.since !== undefined) {
    where.push('at >= ?');
    params.push(options.since);
  }
  if (options.assets !== undefined) {
    if (options.assets.length === 0) return [];
    where.push(`asset IN (${placeholders(options.assets.length)})`);
    params.push(...options.assets);
  }
  const sql = `SELECT ledger_id, refid, at, type, subtype, asset, amount, fee FROM kraken_ledger${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY at ASC, ledger_id ASC`;
  return (
    getDb()
      .prepare(sql)
      .all(...params) as LedgerRow[]
  ).map((row) => ({
    ledgerId: row.ledger_id,
    refid: row.refid,
    at: row.at,
    type: row.type,
    subtype: row.subtype,
    asset: row.asset,
    amount: row.amount,
    fee: row.fee,
  }));
}

import 'server-only';
import type { KrakenFlow, Ms } from '@/shared/types/domain';
import { getDb, placeholders } from '../client';

// Deposits, withdrawals and transfers from the Kraken ledger (`kraken_flows`): needed to separate "the account
// grew" from "money moved in" in the 24h change. Ledger entries are immutable, so re-syncing a window is harmless.

/** A normalized flow plus the ledger `refid` and the raw exchange record (audit trail, defaults to the flow). */
export type KrakenFlowInput = KrakenFlow & { refid?: string | null; raw?: unknown };

export interface ListFlowsOptions {
  /** Inclusive bounds on `at`. */
  since?: Ms;
  until?: Ms;
  /** Empty array matches nothing; omit for all types. */
  types?: readonly KrakenFlow['type'][];
}

interface KrakenFlowRow {
  ledger_id: string;
  at: number;
  type: string;
  asset: string;
  amount: number;
  fee: number;
}

export function upsertFlows(flows: readonly KrakenFlowInput[]): void {
  if (flows.length === 0) return;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO kraken_flows (ledger_id, at, type, asset, amount, fee, refid, raw_json)
     VALUES (@ledgerId, @at, @type, @asset, @amount, @fee, @refid, @rawJson)
     ON CONFLICT(ledger_id) DO UPDATE SET
       at = excluded.at, type = excluded.type, asset = excluded.asset, amount = excluded.amount, fee = excluded.fee,
       refid = COALESCE(excluded.refid, kraken_flows.refid), raw_json = excluded.raw_json`,
  );
  db.transaction(() => {
    for (const input of flows) {
      const { raw, refid, ...flow } = input;
      upsert.run({
        ledgerId: flow.ledgerId,
        at: flow.at,
        type: flow.type,
        asset: flow.asset,
        amount: flow.amount,
        fee: flow.fee,
        refid: refid ?? null,
        rawJson: JSON.stringify(raw ?? flow),
      });
    }
  })();
}

/** Flows in chronological order. */
export function listFlows(options: ListFlowsOptions = {}): KrakenFlow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.since !== undefined) {
    where.push('at >= ?');
    params.push(options.since);
  }
  if (options.until !== undefined) {
    where.push('at <= ?');
    params.push(options.until);
  }
  if (options.types !== undefined) {
    if (options.types.length === 0) return [];
    where.push(`type IN (${placeholders(options.types.length)})`);
    params.push(...options.types);
  }
  const sql = `SELECT ledger_id, at, type, asset, amount, fee FROM kraken_flows${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY at ASC, ledger_id ASC`;
  return (
    getDb()
      .prepare(sql)
      .all(...params) as KrakenFlowRow[]
  ).map((row) => ({
    ledgerId: row.ledger_id,
    at: row.at,
    type: row.type as KrakenFlow['type'],
    asset: row.asset,
    amount: row.amount,
    fee: row.fee,
  }));
}

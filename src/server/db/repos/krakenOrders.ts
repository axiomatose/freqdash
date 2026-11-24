import 'server-only';
import type { KrakenOrder, KrakenOrderStatus, Ms, Pair } from '@/shared/types/domain';
import { chunk, getDb, placeholders } from '../client';

// Kraken orders as normalized by the Kraken adapter (`kraken_orders`). Kept forever: they are the ground truth the
// orphan/mismatch checks reconcile the bots against.

/** A normalized order plus, optionally, the raw exchange record (audit trail). Defaults to the order itself. */
export type KrakenOrderInput = KrakenOrder & { raw?: unknown };

export interface ListKrakenOrdersOptions {
  /** Inclusive lower bound on `openedAt`. */
  since?: Ms;
  pair?: Pair;
  /** Empty array matches nothing; omit for all statuses. */
  statuses?: readonly KrakenOrderStatus[];
  limit?: number;
  /** Default 'desc' (newest first). */
  order?: 'asc' | 'desc';
}

interface KrakenOrderRow {
  txid: string;
  pair: string | null;
  kraken_pair: string;
  side: string;
  order_type: string;
  status: string;
  opened_at: number;
  closed_at: number | null;
  vol: number;
  vol_exec: number;
  cost_usd: number;
  fee_usd: number;
  avg_price: number | null;
  limit_price: number | null;
  userref: number | null;
  cl_ord_id: string | null;
  reason: string | null;
}

function toOrder(row: KrakenOrderRow): KrakenOrder {
  return {
    txid: row.txid,
    pair: row.pair,
    krakenPair: row.kraken_pair,
    side: row.side as KrakenOrder['side'],
    orderType: row.order_type,
    status: row.status as KrakenOrderStatus,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    vol: row.vol,
    volExec: row.vol_exec,
    costUsd: row.cost_usd,
    feeUsd: row.fee_usd,
    avgPrice: row.avg_price,
    limitPrice: row.limit_price,
    userref: row.userref,
    clOrdId: row.cl_ord_id,
    reason: row.reason,
  };
}

/**
 * Upserts orders (`now` becomes `first_seen_at` for new rows and `updated_at` always).
 *  * Fields a later observation may not carry (pair, closedAt, prices, userref, clOrdId, reason) keep their stored
 *    value when the new one is null.
 *  * A terminal order (closed/canceled/expired) is never regressed to pending/open by a stale observation (an
 *    OpenOrders response fetched before the order closed, arriving after ClosedOrders): that row is left untouched.
 */
export function upsertKrakenOrders(orders: readonly KrakenOrderInput[], now: Ms): void {
  if (orders.length === 0) return;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO kraken_orders (txid, pair, kraken_pair, side, order_type, status, opened_at, closed_at, vol, vol_exec,
       cost_usd, fee_usd, avg_price, limit_price, userref, cl_ord_id, reason, first_seen_at, updated_at, raw_json)
     VALUES (@txid, @pair, @krakenPair, @side, @orderType, @status, @openedAt, @closedAt, @vol, @volExec,
       @costUsd, @feeUsd, @avgPrice, @limitPrice, @userref, @clOrdId, @reason, @now, @now, @rawJson)
     ON CONFLICT(txid) DO UPDATE SET
       pair = COALESCE(excluded.pair, kraken_orders.pair),
       kraken_pair = excluded.kraken_pair,
       side = excluded.side,
       order_type = excluded.order_type,
       status = excluded.status,
       opened_at = excluded.opened_at,
       closed_at = COALESCE(excluded.closed_at, kraken_orders.closed_at),
       vol = excluded.vol,
       vol_exec = excluded.vol_exec,
       cost_usd = excluded.cost_usd,
       fee_usd = excluded.fee_usd,
       avg_price = COALESCE(excluded.avg_price, kraken_orders.avg_price),
       limit_price = COALESCE(excluded.limit_price, kraken_orders.limit_price),
       userref = COALESCE(excluded.userref, kraken_orders.userref),
       cl_ord_id = COALESCE(excluded.cl_ord_id, kraken_orders.cl_ord_id),
       reason = COALESCE(excluded.reason, kraken_orders.reason),
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at
     WHERE NOT (kraken_orders.status IN ('closed','canceled','expired') AND excluded.status IN ('pending','open'))`,
  );
  db.transaction(() => {
    for (const input of orders) {
      const { raw, ...order } = input;
      upsert.run({
        txid: order.txid,
        pair: order.pair,
        krakenPair: order.krakenPair,
        side: order.side,
        orderType: order.orderType,
        status: order.status,
        openedAt: order.openedAt,
        closedAt: order.closedAt,
        vol: order.vol,
        volExec: order.volExec,
        costUsd: order.costUsd,
        feeUsd: order.feeUsd,
        avgPrice: order.avgPrice,
        limitPrice: order.limitPrice,
        userref: order.userref,
        clOrdId: order.clOrdId,
        reason: order.reason,
        rawJson: JSON.stringify(raw ?? order),
        now,
      });
    }
  })();
}

export function listKrakenOrders(options: ListKrakenOrdersOptions = {}): KrakenOrder[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.since !== undefined) {
    where.push('opened_at >= ?');
    params.push(options.since);
  }
  if (options.pair !== undefined) {
    where.push('pair = ?');
    params.push(options.pair);
  }
  if (options.statuses !== undefined) {
    if (options.statuses.length === 0) return [];
    where.push(`status IN (${placeholders(options.statuses.length)})`);
    params.push(...options.statuses);
  }
  const direction = options.order === 'asc' ? 'ASC' : 'DESC';
  let sql = `SELECT * FROM kraken_orders${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY opened_at ${direction}, txid ${direction}`;
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(Math.max(0, Math.floor(options.limit)));
  }
  return (
    getDb()
      .prepare(sql)
      .all(...params) as KrakenOrderRow[]
  ).map(toOrder);
}

/** Orders for the given txids, in the order requested (duplicates collapsed, unknown txids skipped). */
export function getOrdersByTxids(txids: readonly string[]): KrakenOrder[] {
  const unique = [...new Set(txids)];
  if (unique.length === 0) return [];
  const db = getDb();
  const byTxid = new Map<string, KrakenOrder>();
  for (const part of chunk(unique)) {
    const rows = db
      .prepare(`SELECT * FROM kraken_orders WHERE txid IN (${placeholders(part.length)})`)
      .all(...part) as KrakenOrderRow[];
    for (const row of rows) byTxid.set(row.txid, toOrder(row));
  }
  return unique.flatMap((txid) => {
    const order = byTxid.get(txid);
    return order === undefined ? [] : [order];
  });
}

import 'server-only';
import type { KrakenOrder, LedgerEntry } from '@/shared/types/domain';
import { emptyAssetCatalog, type AssetCatalog } from './assets';
import { KrakenError } from './errors';
import { normalizeLedgerEntries, normalizeOrders, type NormalizeOrdersOptions } from './normalize';
import { isRecord, toNumber, unwrapResult, type KrakenCaller } from './types';

// Paging helpers on top of a private client (docs/PLAN.md section 6.3, "Cadence and budget" and "Backfill").

/** Kraken returns 50 results per page for ClosedOrders and Ledgers. */
export const PAGE_SIZE = 50;
/** Incremental syncs re-read this much history before the cursor, to catch orders that closed late. */
export const CURSOR_OVERLAP_SEC = 600;
/** Hard stop for a runaway loop: 200 pages is 10 000 orders. */
export const MAX_PAGES = 200;
/** QueryOrders accepts at most 50 txids per call. */
export const QUERY_ORDERS_CHUNK = 50;

interface PagedResult {
  entries: Map<string, unknown>;
  /** True when every result Kraken announced (`count`) was read. */
  complete: boolean;
  pages: number;
}

/**
 * Reads a `count`-bearing, `ofs`-paged listing to its end. Kraken lists newest first, so a new entry arriving between
 * two page reads pushes older ones down: they show up twice (deduped here by id) and none is missed.
 */
async function readAllPages(
  client: KrakenCaller,
  method: 'ClosedOrders' | 'Ledgers',
  listKey: 'closed' | 'ledger',
  params: Record<string, string | number>,
  maxPages: number,
): Promise<PagedResult> {
  const entries = new Map<string, unknown>();
  let offset = 0;
  let pages = 0;
  while (pages < maxPages) {
    const result = unwrapResult(await client.call(method, { ...params, ofs: offset }));
    pages += 1;
    if (!isRecord(result) || !isRecord(result[listKey])) {
      throw new KrakenError('parse', `${method}: unexpected response shape`, { endpoint: method });
    }
    const list = result[listKey];
    const pageLength = Object.keys(list).length;
    for (const [id, value] of Object.entries(list)) entries.set(id, value);
    offset += pageLength;

    const total = toNumber(result.count);
    if (total !== null ? offset >= total : pageLength < PAGE_SIZE) return { entries, complete: true, pages };
    // Kraken announced more results but returned none: stop instead of looping, and report it as incomplete.
    if (pageLength === 0) break;
  }
  return { entries, complete: false, pages };
}

export interface SyncClosedOrdersOptions {
  /** Earliest close time (epoch seconds) worth reading: the reconciliation start. */
  reconStartSec: number;
  /** Newest close time seen so far (epoch seconds), null before the first sync. */
  cursorSec: number | null;
  /** Persisted `meta.kraken_backfill_complete`. False reads everything since `reconStartSec`. */
  backfillComplete: boolean;
  /** Without one, orders come back with `pair: null`. */
  catalog?: AssetCatalog;
  overlapSec?: number;
  maxPages?: number;
  normalize?: NormalizeOrdersOptions;
}

export interface SyncClosedOrdersResult {
  /** Deduped by txid, oldest first. Upserts are idempotent, so overlap with earlier syncs is harmless. */
  orders: KrakenOrder[];
  /** Persist as `meta.kraken_closed_cursor_sec`: the newest close time seen, never moving backwards. */
  cursorSec: number;
  /** All announced results were read. Persist `kraken_backfill_complete` when this is true. */
  complete: boolean;
  pages: number;
}

/**
 * `ClosedOrders` with `closetime=close`, 50 per page via `ofs`. The first run (or any run before the backfill is
 * marked complete) starts at `reconStartSec`; later runs start at `cursorSec - 600 s`. Throws (a `KrakenError`) if any
 * page fails, and then nothing should be persisted: the next run simply starts over.
 */
export async function syncClosedOrders(
  client: KrakenCaller,
  options: SyncClosedOrdersOptions,
): Promise<SyncClosedOrdersResult> {
  const catalog = options.catalog ?? emptyAssetCatalog();
  const cursorSec = options.cursorSec !== null && Number.isFinite(options.cursorSec) ? options.cursorSec : null;
  const incremental = options.backfillComplete && cursorSec !== null;
  const startSec = incremental
    ? Math.max(0, Math.floor(cursorSec - (options.overlapSec ?? CURSOR_OVERLAP_SEC)))
    : Math.floor(options.reconStartSec);

  const paged = await readAllPages(
    client,
    'ClosedOrders',
    'closed',
    { start: startSec, closetime: 'close' },
    options.maxPages ?? MAX_PAGES,
  );
  const orders = normalizeOrders({ closed: Object.fromEntries(paged.entries) }, catalog, options.normalize);

  const previous = cursorSec ?? options.reconStartSec;
  // An incomplete read holds the OLDEST orders back (newest come first), so the cursor must not advance past them.
  const newest = paged.complete ? Math.max(0, ...orders.map((order) => (order.closedAt ?? 0) / 1000)) : 0;
  return { orders, cursorSec: Math.max(previous, newest), complete: paged.complete, pages: paged.pages };
}

/** `QueryOrders` for explicit txids (log-created orders the sync has not seen), in chunks of 50. */
export async function queryOrdersByTxid(
  client: KrakenCaller,
  txids: readonly string[],
  catalog: AssetCatalog = emptyAssetCatalog(),
  options: NormalizeOrdersOptions = {},
): Promise<KrakenOrder[]> {
  const unique = [...new Set(txids)];
  const byTxid = new Map<string, KrakenOrder>();
  for (let i = 0; i < unique.length; i += QUERY_ORDERS_CHUNK) {
    const chunk = unique.slice(i, i + QUERY_ORDERS_CHUNK);
    const raw = await client.call('QueryOrders', { txid: chunk });
    for (const order of normalizeOrders(raw, catalog, options)) byTxid.set(order.txid, order);
  }
  return [...byTxid.values()].sort((a, b) => a.openedAt - b.openedAt || a.txid.localeCompare(b.txid));
}

export interface SyncLedgerOptions {
  /** Earliest entry time (epoch seconds) worth reading: the reconciliation start. */
  reconStartSec: number;
  /** Newest entry time seen so far (epoch seconds), null before the first sync. */
  cursorSec: number | null;
  /** True once a read from `reconStartSec` reached its end. False reads everything since `reconStartSec`. */
  backfillComplete: boolean;
  catalog?: AssetCatalog;
  overlapSec?: number;
  maxPages?: number;
}

export interface SyncLedgerResult {
  /** Every ledger type, oldest first. Upserts are idempotent, so overlap with earlier syncs is harmless. */
  entries: LedgerEntry[];
  /** Persist as the ledger cursor: the newest entry time seen, never moving backwards. */
  cursorSec: number;
  /** All announced results were read. */
  complete: boolean;
  pages: number;
}

/**
 * `Ledgers` without a type filter (cost 2 per page), 50 per page via `ofs`. Like the closed-order sync, the first run
 * reads from `reconStartSec` and later ones from `cursorSec - 600 s`.
 */
export async function syncLedgerEntries(client: KrakenCaller, options: SyncLedgerOptions): Promise<SyncLedgerResult> {
  const catalog = options.catalog ?? emptyAssetCatalog();
  const cursorSec = options.cursorSec !== null && Number.isFinite(options.cursorSec) ? options.cursorSec : null;
  const incremental = options.backfillComplete && cursorSec !== null;
  const startSec = incremental
    ? Math.max(0, Math.floor(cursorSec - (options.overlapSec ?? CURSOR_OVERLAP_SEC)))
    : Math.floor(options.reconStartSec);
  const paged = await readAllPages(client, 'Ledgers', 'ledger', { start: startSec }, options.maxPages ?? MAX_PAGES);
  const entries = normalizeLedgerEntries({ ledger: Object.fromEntries(paged.entries) }, catalog);
  const previous = cursorSec ?? options.reconStartSec;
  // An incomplete read holds the OLDEST entries back (newest come first), so the cursor must not advance past them.
  const newest = paged.complete ? Math.max(0, ...entries.map((e) => e.at / 1000)) : 0;
  return { entries, cursorSec: Math.max(previous, newest), complete: paged.complete, pages: paged.pages };
}

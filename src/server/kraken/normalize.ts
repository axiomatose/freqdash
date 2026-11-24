import type {
  Asset,
  Candle,
  KrakenBalanceEntry,
  KrakenFlow,
  LedgerEntry,
  KrakenOrder,
  KrakenOrderStatus,
  Ms,
} from '@/shared/types/domain';
import { parseKrakenAsset, type AssetCatalog } from './assets';
import {
  isRecord,
  roundTo,
  secondsToMs,
  toNumber,
  toStringOrNull,
  unwrapResult,
  usdPriceOf,
  type OhlcResult,
  type PriceMap,
  type TradeVolumeResult,
} from './types';

// Pure normalizers for REAL Kraken response shapes: numbers arrive as strings, times as float seconds, and order
// responses name the pair by altname (`descr.pair`). Each accepts either the whole `{error, result}` envelope or
// just the `result`, and skips entries it cannot parse instead of throwing.

// --- balances ---------------------------------------------------------------------------------------------------

function balanceEntry(
  code: string,
  total: number,
  hold: number,
  credit: number,
  creditUsed: number,
  catalog: AssetCatalog,
  prices: PriceMap | undefined,
): KrakenBalanceEntry {
  const resolved = catalog.resolveAsset(code) ?? { ...parseKrakenAsset(code), krakenAsset: code };
  const priceUsd = usdPriceOf(prices, resolved.asset);
  return {
    asset: resolved.asset,
    krakenAsset: code,
    wallet: resolved.wallet,
    total,
    hold,
    // Kraken: available = balance + credit - credit_used - hold_trade
    available: Math.max(0, roundTo(total + credit - creditUsed - hold, 12)),
    priceUsd,
    valueUsd: priceUsd === null ? null : total * priceUsd,
  };
}

function sortEntries(entries: KrakenBalanceEntry[]): KrakenBalanceEntry[] {
  return entries.sort(
    (a, b) =>
      a.asset.localeCompare(b.asset) || a.wallet.localeCompare(b.wallet) || a.krakenAsset.localeCompare(b.krakenAsset),
  );
}

/** `Balance`: `{ ZUSD: "1461.9925", XXBT: "0.0004674400" }`. No hold information, so available equals total. */
export function normalizeBalance(raw: unknown, catalog: AssetCatalog, prices?: PriceMap): KrakenBalanceEntry[] {
  const result = unwrapResult(raw);
  if (!isRecord(result)) return [];
  const entries: KrakenBalanceEntry[] = [];
  for (const [code, value] of Object.entries(result)) {
    const total = toNumber(value);
    if (total !== null) entries.push(balanceEntry(code, total, 0, 0, 0, catalog, prices));
  }
  return sortEntries(entries);
}

/**
 * `BalanceEx`: `{ ZUSD: { balance, credit, credit_used, hold_trade } }`. `credit` and `credit_used` may be absent
 * (unverified against a live key); a plain string value (the `Balance` shape) is tolerated too.
 */
export function normalizeBalanceEx(raw: unknown, catalog: AssetCatalog, prices?: PriceMap): KrakenBalanceEntry[] {
  const result = unwrapResult(raw);
  if (!isRecord(result)) return [];
  const entries: KrakenBalanceEntry[] = [];
  for (const [code, value] of Object.entries(result)) {
    if (!isRecord(value)) {
      const total = toNumber(value);
      if (total !== null) entries.push(balanceEntry(code, total, 0, 0, 0, catalog, prices));
      continue;
    }
    const total = toNumber(value.balance);
    if (total === null) continue;
    const hold = toNumber(value.hold_trade) ?? 0;
    const credit = toNumber(value.credit) ?? 0;
    const creditUsed = toNumber(value.credit_used) ?? 0;
    entries.push(balanceEntry(code, total, hold, credit, creditUsed, catalog, prices));
  }
  return sortEntries(entries);
}

// --- orders -----------------------------------------------------------------------------------------------------

export interface NormalizeOrdersOptions {
  /**
   * USD prices used to convert `cost` and `fee` (which Kraken reports in the QUOTE currency) for pairs that are not
   * USD quoted. Without a price such orders get 0 rather than a number in the wrong unit.
   */
  prices?: PriceMap;
  /** Called for every entry that had to be skipped (malformed or missing side). */
  onSkip?: (txid: string, reason: string) => void;
}

const ORDER_STATUSES: ReadonlySet<string> = new Set<KrakenOrderStatus>([
  'pending',
  'open',
  'closed',
  'canceled',
  'expired',
]);

/** Finds the `txid -> order` map in an OpenOrders, ClosedOrders or QueryOrders result. */
function orderMapOf(result: unknown): { map: Record<string, unknown>; listed: 'open' | 'closed' | 'query' } | null {
  if (!isRecord(result)) return null;
  if (isRecord(result.open)) return { map: result.open, listed: 'open' };
  if (isRecord(result.closed)) return { map: result.closed, listed: 'closed' };
  // QueryOrders returns the map directly.
  return { map: result, listed: 'query' };
}

/**
 * Normalizes an `OpenOrders` (`{ open: {...} }`), `ClosedOrders` (`{ closed: {...}, count }`) or `QueryOrders`
 * (`{ <txid>: {...} }`) result. Sorted by open time, then txid.
 */
export function normalizeOrders(
  raw: unknown,
  catalog: AssetCatalog,
  options: NormalizeOrdersOptions = {},
): KrakenOrder[] {
  const found = orderMapOf(unwrapResult(raw));
  if (!found) return [];
  const orders: KrakenOrder[] = [];
  for (const [txid, value] of Object.entries(found.map)) {
    if (!isRecord(value)) {
      // `count` and friends live next to the map in some shapes; only complain about object-like siblings.
      if (found.listed === 'query' && typeof value !== 'object') continue;
      options.onSkip?.(txid, 'not an object');
      continue;
    }
    const order = normalizeOrder(txid, value, found.listed, catalog, options);
    if (typeof order === 'string') options.onSkip?.(txid, order);
    else orders.push(order);
  }
  return orders.sort((a, b) => a.openedAt - b.openedAt || a.txid.localeCompare(b.txid));
}

function normalizeOrder(
  txid: string,
  order: Record<string, unknown>,
  listed: 'open' | 'closed' | 'query',
  catalog: AssetCatalog,
  options: NormalizeOrdersOptions,
): KrakenOrder | string {
  const descr = isRecord(order.descr) ? order.descr : {};
  const side = descr.type;
  if (side !== 'buy' && side !== 'sell') return 'missing order side';
  const openedAt = secondsToMs(order.opentm);
  if (openedAt === null) return 'missing open time';

  const krakenPair = toStringOrNull(descr.pair) ?? '';
  const pair = krakenPair === '' ? null : catalog.resolvePair(krakenPair);
  const rawStatus = typeof order.status === 'string' ? order.status : '';
  const status: KrakenOrderStatus = ORDER_STATUSES.has(rawStatus)
    ? (rawStatus as KrakenOrderStatus)
    : listed === 'open'
      ? 'open'
      : 'closed';

  // cost and fee are quote-denominated; only a USD quote (or an unknown pair, assumed USD) is taken at face value.
  let toUsd = 1;
  if (pair !== null && pair.quote !== 'USD') toUsd = usdPriceOf(options.prices, pair.quote) ?? 0;

  const closedAtRaw = secondsToMs(order.closetm);
  const avgPrice = toNumber(order.price);
  const limitPrice = toNumber(descr.price);
  const userref = toNumber(order.userref);
  return {
    txid,
    pair: pair?.pair ?? null,
    krakenPair,
    side,
    orderType: toStringOrNull(descr.ordertype) ?? 'unknown',
    status,
    openedAt,
    closedAt: closedAtRaw !== null && closedAtRaw > 0 ? closedAtRaw : null,
    vol: toNumber(order.vol) ?? 0,
    volExec: toNumber(order.vol_exec) ?? 0,
    costUsd: (toNumber(order.cost) ?? 0) * toUsd,
    feeUsd: (toNumber(order.fee) ?? 0) * toUsd,
    avgPrice: avgPrice !== null && avgPrice > 0 ? avgPrice : null,
    limitPrice: limitPrice !== null && limitPrice > 0 ? limitPrice : null,
    userref: userref !== null && userref !== 0 ? userref : null,
    clOrdId: toStringOrNull(order.cl_ord_id),
    reason: toStringOrNull(order.reason),
  };
}

// --- market data ------------------------------------------------------------------------------------------------

/**
 * `Ticker` to USD prices per base asset, from the last trade price `c[0]`. Only USD quoted pairs count; pairs the
 * catalog does not know are ignored. Ticker keys are AssetPairs keys or the requested altnames: both resolve.
 */
export function normalizeTicker(raw: unknown, catalog: AssetCatalog, at: Ms): Record<Asset, { usd: number; at: Ms }> {
  const result = unwrapResult(raw);
  const prices: Record<Asset, { usd: number; at: Ms }> = {};
  if (!isRecord(result)) return prices;
  for (const [key, value] of Object.entries(result)) {
    if (!isRecord(value) || !Array.isArray(value.c)) continue;
    const pair = catalog.resolvePair(key);
    const last = toNumber(value.c[0]);
    if (pair === null || pair.quote !== 'USD' || last === null || last <= 0) continue;
    prices[pair.base] = { usd: last, at };
  }
  return prices;
}

/**
 * `OHLC` to candles. Rows are `[time, open, high, low, close, vwap, volume, count]`; times are UTC seconds. The
 * result is ascending and unique by time. The response's newest row is the FORMING candle: its time is greater
 * than `result.last` (the newest committed candle), and only then does it get `live: true` (PLAN F14).
 */
export function normalizeOhlc(raw: unknown): OhlcResult {
  const result = unwrapResult(raw);
  const empty: OhlcResult = { candles: [], last: null, pairKey: null };
  if (!isRecord(result)) return empty;
  const last = toNumber(result.last);
  const pairKey = Object.keys(result).find((key) => key !== 'last' && Array.isArray(result[key])) ?? null;
  const rows = pairKey === null ? [] : (result[pairKey] as unknown[]);

  const byTime = new Map<number, Candle>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const time = toNumber(row[0]);
    const open = toNumber(row[1]);
    const high = toNumber(row[2]);
    const low = toNumber(row[3]);
    const close = toNumber(row[4]);
    if (time === null || open === null || high === null || low === null || close === null) continue;
    byTime.set(time, { time, open, high, low, close, volume: toNumber(row[6]) ?? 0 });
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  const newest = candles.at(-1);
  if (newest && last !== null && newest.time > last) newest.live = true;
  return { candles, last, pairKey };
}

// --- fees and ledgers -------------------------------------------------------------------------------------------

function fractionOfPercent(percent: number): number {
  return roundTo(percent / 100, 10);
}

/**
 * `TradeVolume` to a fee tier in FRACTIONS (Kraken sends percent: `"0.4000"` becomes 0.004), keyed by the canonical
 * pair. `fees` may be keyed by the AssetPairs key or by the requested altname: both resolve through the catalog.
 * A pair without a maker entry (Kraken omits `fees_maker` when maker equals taker) gets maker = taker.
 */
export function normalizeTradeVolume(raw: unknown, catalog: AssetCatalog): TradeVolumeResult {
  const result = unwrapResult(raw);
  const out: TradeVolumeResult = { currency: null, volume30d: null, feeTier: {} };
  if (!isRecord(result)) return out;
  out.currency = toStringOrNull(result.currency);
  out.volume30d = toNumber(result.volume);

  const feeOf = (schedule: unknown, key: string): number | null => {
    if (!isRecord(schedule)) return null;
    const entry = schedule[key];
    return isRecord(entry) ? toNumber(entry.fee) : null;
  };
  const taker = isRecord(result.fees) ? result.fees : {};
  const maker = isRecord(result.fees_maker) ? result.fees_maker : {};
  for (const key of new Set([...Object.keys(taker), ...Object.keys(maker)])) {
    const pair = catalog.resolvePair(key);
    const takerPct = feeOf(taker, key) ?? feeOf(maker, key);
    if (pair === null || takerPct === null) continue;
    const makerPct = feeOf(maker, key) ?? takerPct;
    out.feeTier[pair.pair] = { taker: fractionOfPercent(takerPct), maker: fractionOfPercent(makerPct) };
  }
  return out;
}

/**
 * `Ledgers` (`{ ledger: { <id>: { refid, time, type, subtype, asset, amount, fee, ... } }, count }`) to entries, oldest
 * first. `amount` keeps Kraken's sign and is before `fee`.
 */
export function normalizeLedgerEntries(raw: unknown, catalog: AssetCatalog): LedgerEntry[] {
  const result = unwrapResult(raw);
  if (!isRecord(result) || !isRecord(result.ledger)) return [];
  const entries: LedgerEntry[] = [];
  for (const [ledgerId, value] of Object.entries(result.ledger)) {
    if (!isRecord(value)) continue;
    const at = secondsToMs(value.time);
    const amount = toNumber(value.amount);
    const code = toStringOrNull(value.asset);
    const type = toStringOrNull(value.type);
    if (at === null || amount === null || code === null || type === null) continue;
    const asset = (catalog.resolveAsset(code) ?? parseKrakenAsset(code)).asset;
    entries.push({
      ledgerId,
      refid: toStringOrNull(value.refid),
      at,
      type,
      subtype: toStringOrNull(value.subtype),
      asset,
      amount,
      fee: toNumber(value.fee) ?? 0,
    });
  }
  return entries.sort((a, b) => a.at - b.at || a.ledgerId.localeCompare(b.ledgerId));
}

/** The deposits and withdrawals among ledger entries, as the equity chart's money-in/out flows. */
export function flowsOf(entries: readonly LedgerEntry[]): KrakenFlow[] {
  return entries.flatMap((e) =>
    e.type === 'deposit' || e.type === 'withdrawal'
      ? [{ ledgerId: e.ledgerId, at: e.at, type: e.type, asset: e.asset, amount: e.amount, fee: e.fee }]
      : [],
  );
}

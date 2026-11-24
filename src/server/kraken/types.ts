import type { Asset, Candle, Ms } from '@/shared/types/domain';

// Local types and small wire-format guards shared by the Kraken adapter modules (docs/PLAN.md section 6.3).
// Everything here is pure: no Node, network or DB imports.

/**
 * The ONLY private methods this dashboard may ever call. The union is the type-level half of the allowlist;
 * `KRAKEN_PRIVATE_METHODS` is the runtime half. Trading and funding methods (AddOrder, CancelOrder, Withdraw,
 * WalletTransfer, ...) are deliberately absent.
 */
export const KRAKEN_PRIVATE_METHODS = [
  'Balance',
  'BalanceEx',
  'OpenOrders',
  'ClosedOrders',
  'QueryOrders',
  'TradeVolume',
  'Ledgers',
] as const;
export type KrakenPrivateMethod = (typeof KRAKEN_PRIVATE_METHODS)[number];

export type KrakenPublicMethod = 'Time' | 'Assets' | 'AssetPairs' | 'Ticker' | 'OHLC';

export type KrakenTier = 'starter' | 'intermediate' | 'pro';

/** A request parameter. `undefined`/`null` are skipped, arrays are joined with commas (Kraken list syntax). */
export type KrakenParamValue = string | number | boolean | readonly (string | number)[] | null | undefined;
export type KrakenParams = Readonly<Record<string, KrakenParamValue>>;

/** What the sync helpers need from a private client (lets tests pass a fake). */
export interface KrakenCaller {
  call(method: KrakenPrivateMethod, params?: KrakenParams): Promise<unknown>;
}

export type KrakenFetch = typeof fetch;

/** Millisecond clock and sleep, injectable so tests never wait in real time. */
export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

/**
 * USD price lookup accepted by the normalizers: `{ BTC: 83000 }` or the state store shape `{ BTC: { usd: 83000 } }`.
 * USD itself is always 1 and needs no entry.
 */
export type PriceMap = Readonly<Record<Asset, number | { readonly usd: number }>>;

export interface OhlcResult {
  /** Ascending, unique open times in UTC seconds. Only the forming candle (if any) carries `live: true`. */
  candles: Candle[];
  /** `result.last`: open time of the newest COMMITTED candle. The forming candle has a time greater than this. */
  last: number | null;
  /** The pair key Kraken used in the response (e.g. `XXBTZUSD`). */
  pairKey: string | null;
}

export interface TradeVolumeResult {
  currency: string | null;
  /** 30 day volume in `currency`. */
  volume30d: number | null;
  /** Fees as fractions (0.004 = 0.4 %), keyed by the canonical pair (`BTC/USD`). */
  feeTier: Record<string, { taker: number; maker: number }>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Kraken answers `{ error: [], result: ... }`. Accepts either the whole envelope or the bare result. */
export function unwrapResult(raw: unknown): unknown {
  if (isRecord(raw) && Array.isArray(raw.error) && 'result' in raw) return raw.result;
  return raw;
}

/** Kraken sends numbers as strings. Empty strings, NaN and Infinity are not numbers. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Float epoch seconds (Kraken's unit) to epoch milliseconds. */
export function secondsToMs(value: unknown): Ms | null {
  const seconds = toNumber(value);
  return seconds === null ? null : Math.round(seconds * 1000);
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Removes floating-point noise from sums of decimal strings (Kraken balances have at most 10 decimals). */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function usdPriceOf(prices: PriceMap | undefined, asset: Asset): number | null {
  if (asset === 'USD') return 1;
  const entry = prices?.[asset];
  const price = typeof entry === 'number' ? entry : (entry?.usd ?? null);
  return price !== null && Number.isFinite(price) && price > 0 ? price : null;
}

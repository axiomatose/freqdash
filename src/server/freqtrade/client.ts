import 'server-only';
import type { z } from 'zod';
import type { Ms } from '@/shared/types/domain';
import { describeError, redactSecrets } from '../log';
import {
  describeZodError,
  ftBalanceSchema,
  ftHealthSchema,
  ftLocksSchema,
  ftLogsSchema,
  ftPairCandlesSchema,
  ftPingSchema,
  ftPlotConfigSchema,
  ftShowConfigSchema,
  ftStrategySchema,
  type FtStrategyRaw,
  ftStatusSchema,
  ftTradesPageSchema,
  ftWhitelistSchema,
  type FtBalanceRaw,
  type FtHealthRaw,
  type FtLocksRaw,
  type FtLogsRaw,
  type FtPairCandlesRaw,
  type FtPlotConfigRaw,
  type FtShowConfigRaw,
  type FtTradeRaw,
  type FtTradesPageRaw,
  type FtWhitelistRaw,
} from './schemas';

// The dashboard holds control-capable freqtrade credentials (freqtrade has no read-only API role), so this client is
// structurally unable to do anything but GET: there is no method parameter anywhere, and the path must be one of the
// allowlisted read endpoints (docs/PLAN.md section 6.1). Credentials only ever travel in the Authorization header.

export const FT_ALLOWED_PATHS = [
  'health',
  'ping',
  'show_config',
  'status',
  'trades',
  'balance',
  'whitelist',
  'locks',
  'logs',
  'plot_config',
  'pair_candles',
  'strategy',
] as const;

export type FtPath = (typeof FT_ALLOWED_PATHS)[number];

const ALLOWED = new Set<string>(FT_ALLOWED_PATHS);

export const FT_TIMEOUT_MS = 8_000;
export const FT_TRADES_PAGE_SIZE = 500;
/** Safety stop for `/trades` pagination (50k trades); a misbehaving server must not loop us forever. */
const MAX_TRADE_PAGES = 100;
const ERROR_DETAIL_MAX = 200;

/** The part of a BotConnection this client needs. */
export interface FtConnection {
  url: string;
  username: string;
  password: string;
}

export type FtErrorKind = 'network' | 'timeout' | 'auth' | 'http' | 'parse';

export interface FtError {
  kind: FtErrorKind;
  status?: number;
  message: string;
}

export type FtResult<T> =
  { ok: true; data: T; fetchedAt: Ms; latencyMs: number } | { ok: false; error: FtError; fetchedAt: Ms };

export interface FtClientOptions {
  /** Clock for fetchedAt / latencyMs (tests inject one). */
  now?: () => Ms;
  timeoutMs?: number;
}

type Query = Record<string, string | number>;

function fail(kind: FtErrorKind, message: string, fetchedAt: Ms, status?: number): FtResult<never> {
  const error: FtError = status === undefined ? { kind, message } : { kind, status, message };
  return { ok: false, error, fetchedAt };
}

function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && 'detail' in parsed && typeof parsed.detail === 'string') {
      return redactSecrets(parsed.detail).slice(0, ERROR_DETAIL_MAX);
    }
  } catch {
    // not JSON: no detail worth showing
  }
  return '';
}

export class FreqtradeClient {
  readonly #base: string;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Ms;
  readonly #timeoutMs: number;

  constructor(conn: FtConnection, fetchImpl?: typeof fetch, options: FtClientOptions = {}) {
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(conn.url)) {
      throw new Error('freqtrade base URL must not embed credentials');
    }
    // String concatenation on purpose: dev base URLs carry a path prefix that `new URL('/x', base)` would drop.
    this.#base = conn.url.replace(/\/+$/, '');
    this.#authorization = `Basic ${Buffer.from(`${conn.username}:${conn.password}`, 'utf8').toString('base64')}`;
    this.#fetch = fetchImpl ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? FT_TIMEOUT_MS;
  }

  ping(): Promise<FtResult<z.output<typeof ftPingSchema>>> {
    return this.#get('ping', ftPingSchema);
  }

  health(): Promise<FtResult<FtHealthRaw>> {
    return this.#get('health', ftHealthSchema);
  }

  showConfig(): Promise<FtResult<FtShowConfigRaw>> {
    return this.#get('show_config', ftShowConfigSchema);
  }

  /** Open trades (a bare array). Closed trades come from trades(). */
  status(): Promise<FtResult<FtTradeRaw[]>> {
    return this.#get('status', ftStatusSchema);
  }

  /** Closed trades, all pages merged (`limit=500` per request). A failing page fails the whole call. */
  async trades(): Promise<FtResult<FtTradesPageRaw>> {
    const started = this.#now();
    const all: FtTradeRaw[] = [];
    let offset = 0;
    for (let page = 1; ; page++) {
      const res = await this.#get('trades', ftTradesPageSchema, { limit: FT_TRADES_PAGE_SIZE, offset });
      if (!res.ok) return res;
      const got = res.data.trades.length;
      all.push(...res.data.trades);
      offset += got;
      const total = typeof res.data.total_trades === 'number' ? res.data.total_trades : null;
      // A server may cap the page size below ours, so a short page only ends the walk when the total is unknown.
      const done = got === 0 || (total !== null ? offset >= total : got < FT_TRADES_PAGE_SIZE);
      if (done || page >= MAX_TRADE_PAGES) {
        return {
          ok: true,
          data: { trades: all, trades_count: all.length, offset: 0, total_trades: total ?? all.length },
          fetchedAt: res.fetchedAt,
          latencyMs: Math.max(0, res.fetchedAt - started),
        };
      }
    }
  }

  balance(): Promise<FtResult<FtBalanceRaw>> {
    return this.#get('balance', ftBalanceSchema);
  }

  whitelist(): Promise<FtResult<FtWhitelistRaw>> {
    return this.#get('whitelist', ftWhitelistSchema);
  }

  locks(): Promise<FtResult<FtLocksRaw>> {
    return this.#get('locks', ftLocksSchema);
  }

  logs(limit: number): Promise<FtResult<FtLogsRaw>> {
    return this.#get('logs', ftLogsSchema, { limit: Math.max(1, Math.trunc(limit)) });
  }

  plotConfig(): Promise<FtResult<FtPlotConfigRaw>> {
    return this.#get('plot_config', ftPlotConfigSchema);
  }

  /** The strategy's source code (read-only). The name must be a plain identifier. */
  strategy(name: string): Promise<FtResult<FtStrategyRaw>> {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('invalid strategy name');
    return this.#get(`strategy/${name}`, ftStrategySchema);
  }

  pairCandles(pair: string, timeframe: string, limit: number): Promise<FtResult<FtPairCandlesRaw>> {
    return this.#get('pair_candles', ftPairCandlesSchema, {
      pair,
      timeframe,
      limit: Math.max(1, Math.trunc(limit)),
    });
  }

  async #get<S extends z.ZodType>(
    path: FtPath | `strategy/${string}`,
    schema: S,
    query?: Query,
  ): Promise<FtResult<z.output<S>>> {
    const root = path.split('/')[0] ?? '';
    if (!ALLOWED.has(root) || (root !== 'strategy' && path !== root))
      throw new Error(`freqtrade path not allowlisted: ${path}`);
    const qs = query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}` : '';
    const url = `${this.#base}/api/v1/${path}${qs}`;
    const started = this.#now();
    const signal = AbortSignal.timeout(this.#timeoutMs);

    let status: number;
    let statusText: string;
    let body: string;
    try {
      const res = await this.#fetch(url, {
        method: 'GET',
        headers: { Authorization: this.#authorization, Accept: 'application/json' },
        signal,
        cache: 'no-store',
        redirect: 'manual',
      });
      status = res.status;
      statusText = res.statusText;
      body = await res.text();
    } catch (err) {
      const timedOut = signal.aborted || (err instanceof Error && err.name === 'TimeoutError');
      return fail(timedOut ? 'timeout' : 'network', describeError(err), this.#now());
    }

    const fetchedAt = this.#now();
    if (status === 401 || status === 403) return fail('auth', `HTTP ${status} ${statusText}`.trim(), fetchedAt, status);
    if (status < 200 || status >= 300) {
      const detail = errorDetail(body);
      return fail('http', `HTTP ${status} ${statusText}${detail ? `: ${detail}` : ''}`.trim(), fetchedAt, status);
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return fail('parse', `${path}: response is not valid JSON`, fetchedAt, status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return fail('parse', `${path}: ${describeZodError(parsed.error)}`, fetchedAt, status);
    return { ok: true, data: parsed.data, fetchedAt, latencyMs: Math.max(0, fetchedAt - started) };
  }
}

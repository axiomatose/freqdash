// Harness test for the mock upstreams: spawns `server.mjs` on a random port and drives it over HTTP.
// The Kraken signing and the log parser below are independent re-implementations, on purpose.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RAW = path.join(REPO, 'test', 'fixtures', 'raw');
const SERVER = path.join(HERE, 'server.mjs');

const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(RAW, rel), 'utf8')) as T;

// ------------------------------------------------------------------------------------------ credentials

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? '').trim();
  }
  return out;
}
const env = parseEnv(fs.readFileSync(path.join(REPO, '.env.dev.example'), 'utf8'));
const CREDS = {
  votemax: { user: env.FT_BOT_1_USERNAME ?? '', pass: env.FT_BOT_1_PASSWORD ?? '' },
  dca: { user: env.FT_BOT_2_USERNAME ?? '', pass: env.FT_BOT_2_PASSWORD ?? '' },
  key: env.KRAKEN_API_KEY ?? '',
  secret: env.KRAKEN_API_SECRET ?? '',
};
type Bot = 'votemax' | 'dca';
const basic = (bot: Bot, pass?: string) =>
  `Basic ${Buffer.from(`${CREDS[bot].user}:${pass ?? CREDS[bot].pass}`).toString('base64')}`;

// ------------------------------------------------------------------------------------------ Kraken signing (test side)

function sign(pathname: string, nonce: string, body: string, secretB64: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(nonce + body)
    .digest();
  return crypto
    .createHmac('sha512', Buffer.from(secretB64, 'base64'))
    .update(Buffer.concat([Buffer.from(pathname), digest]))
    .digest('base64');
}

// ------------------------------------------------------------------------------------------ server lifecycle

interface Mock {
  base: string;
  child: ChildProcess;
  runDir: string;
}

async function startMock(extraEnv: Record<string, string> = {}): Promise<Mock> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freqdash-mock-'));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_RUN_DIR: runDir, MOCK_HANG_MS: '3000', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`mock did not start: ${out}`)), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = /MOCK_LISTENING (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once('exit', (code) => reject(new Error(`mock exited early (${code}): ${out}`)));
  });
  return { base, child, runDir };
}

async function stopMock(mock: Mock | undefined): Promise<void> {
  if (!mock) return;
  const exited = new Promise<void>((resolve) => mock.child.once('exit', () => resolve()));
  mock.child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  fs.rmSync(mock.runDir, { recursive: true, force: true });
}

let main: Mock;
let base = '';

beforeAll(async () => {
  main = await startMock({ MOCK_CLOSED_ORDERS_PAGE: '10' });
  base = main.base;
}, 30_000);

afterAll(async () => {
  await stopMock(main);
});

// ------------------------------------------------------------------------------------------ request helpers

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function control(method: string, pathname: string, body?: unknown, at = base): Promise<Response> {
  return fetch(`${at}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const setScenario = async (body: Record<string, unknown>, at = base) =>
  json(await control('POST', '/__scenario', body, at));
const setClock = async (body: Record<string, unknown>) =>
  json<{ now: number; mode: string }>(await control('POST', '/__clock', body));

async function ft(bot: Bot, endpoint: string, query = '', pass?: string, at = base): Promise<Response> {
  return fetch(`${at}/${bot}/api/v1/${endpoint}${query}`, { headers: { Authorization: basic(bot, pass) } });
}

let nonceSeed = Date.now() * 1000;
const nextNonce = () => String(++nonceSeed);

interface KrakenReply {
  error: string[];
  result: Record<string, unknown>;
}

async function kraken(
  method: string,
  params: Record<string, string> = {},
  opts: { nonce?: string; key?: string; secret?: string; tamper?: boolean; at?: string } = {},
): Promise<KrakenReply> {
  const nonce = opts.nonce ?? nextNonce();
  const body = new URLSearchParams({ nonce, ...params }).toString();
  const pathname = `/0/private/${method}`;
  const res = await fetch(`${opts.at ?? base}/kraken${pathname}`, {
    method: 'POST',
    headers: {
      'API-Key': opts.key ?? CREDS.key,
      'API-Sign': sign(pathname, nonce, body, opts.secret ?? CREDS.secret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: opts.tamper ? `${body}&extra=1` : body,
  });
  return json<KrakenReply>(res);
}

interface Order {
  opentm: number;
  closetm?: number;
  status: string;
}
const closedOrders = async (params: Record<string, string> = {}, at?: string) => {
  const reply = await kraken('ClosedOrders', params, { at });
  return reply.result as { closed: Record<string, Order>; count: number };
};
/** Every closed order, following `ofs` pages until an empty one. */
const allClosedOrders = async (): Promise<Record<string, Order>> => {
  const out: Record<string, Order> = {};
  for (let ofs = 0; ;) {
    const page = (await closedOrders({ ofs: String(ofs) })).closed;
    const ids = Object.keys(page);
    if (ids.length === 0) return out;
    Object.assign(out, page);
    ofs += ids.length;
  }
};
const openOrders = async () => (await kraken('OpenOrders')).result as { open: Record<string, Order> };

interface State {
  now: number;
  scenario: { name: string; speed: number; delayMs: number; startedAt: number };
  bots: Record<string, { availability: string }>;
  logs: Record<string, { file: string; lines: number }>;
  incident: null | {
    t0: number;
    endsAt: number;
    done: boolean;
    counts: Record<string, number>;
    totals: Record<string, number>;
    krakenOrdersVisible: number;
    votemax: {
      outageActive: string | null;
      outages: { start: number; end: number; kind: string }[];
      startupTs: number;
    };
  };
}
const state = async () => json<State>(await control('GET', '/__state'));

afterEach(async () => {
  await setClock({ mode: 'real' });
  await setScenario({ name: 'normal', speed: 1 });
  await control('DELETE', '/__received');
  await control('DELETE', '/__calls');
});

// ------------------------------------------------------------------------------------------ log parsing (test side)

interface LogRecord {
  logger: string;
  level: string;
  lines: string[];
}
const LOG_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - (\S+) - (DEBUG|INFO|WARNING|ERROR|CRITICAL) - (.*)$/;
const LOG_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3})/;

function parseRecords(text: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const m = LOG_LINE.exec(line);
    if (m?.[1] && m[2]) records.push({ logger: m[1], level: m[2], lines: [m[3] ?? ''] });
    else records.at(-1)?.lines.push(line);
  }
  return records;
}

function lineTimes(text: string, pattern: RegExp): number[] {
  return text
    .split('\n')
    .filter((l) => pattern.test(l))
    .map((l) => {
      const m = LOG_TIME.exec(l);
      const [y, mo, d, h, mi, s, ms] = (m ?? []).slice(1).map(Number);
      return Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi, s, ms);
    });
}

interface ParsedEvent {
  type: string;
  orderId?: string;
  pair?: string;
  price?: number;
  stakeUsd?: number;
  message?: string;
}

function extractEvents(records: LogRecord[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const r of records) {
    const first = r.lines[0] ?? '';
    let m: RegExpExecArray | null;
    if (r.logger === 'freqtrade.loggers' && first === 'Logfile configured') events.push({ type: 'startup' });
    else if (r.logger === 'freqtrade' && r.level === 'ERROR' && /^Fatal exception/.test(first)) {
      events.push({ type: 'fatal', message: r.lines.at(-1) });
    } else if (/Sending rpc message: .*'process died'/.test(first)) events.push({ type: 'process_died' });
    else if (
      (m = /^Order (O[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}) was created for (\S+) and status is (\w+)/.exec(first))
    ) {
      events.push({ type: 'order_created', orderId: m[1], pair: m[2] });
    } else if (
      (m =
        /^Long signal found: about create a new trade for (\S+) with stake_amount: ([\d.]+) and price: ([\d.]+)/.exec(
          first,
        ))
    ) {
      events.push({ type: 'entry_signal', pair: m[1], stakeUsd: Number(m[2]), price: Number(m[3]) });
    } else if (
      (m = /^Unable to create trade for (\S+): (.*)$/.exec(first)) &&
      (r.level === 'WARNING' || r.level === 'ERROR')
    ) {
      events.push({ type: 'order_failed', pair: m[1], message: m[2] });
    } else if (r.level === 'ERROR' || r.level === 'CRITICAL') events.push({ type: 'error', message: first });
  }
  return events;
}

interface Timeline {
  events: ParsedEvent[];
  counts: Record<string, number>;
}
const timeline = readJson<Timeline>('incident/timeline.json');

// ------------------------------------------------------------------------------------------ tests

describe('sign() helper', () => {
  it('reproduces the Kraken docs test vector (so the checks below use a correct client)', () => {
    const body = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
    const secret = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
    expect(sign('/0/private/AddOrder', '1616492376594', body, secret)).toBe(
      '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==',
    );
  });
});

describe('freqtrade bots', () => {
  it('requires HTTP Basic auth with the right bot credentials', async () => {
    expect((await fetch(`${base}/votemax/api/v1/health`)).status).toBe(401);
    expect((await ft('votemax', 'health', '', 'wrong-password')).status).toBe(401);
    expect((await fetch(`${base}/dca/api/v1/health`, { headers: { Authorization: basic('votemax') } })).status).toBe(
      401,
    );
    const ok = await ft('votemax', 'health');
    expect(ok.status).toBe(200);
    expect((await ft('dca', 'health')).status).toBe(200);
  });

  it('serves ping without credentials, like a real freqtrade API', async () => {
    const res = await fetch(`${base}/dca/api/v1/ping`);
    expect(await json(res)).toEqual({ status: 'pong' });
  });

  it('serves fresh health data on top of the fixture', async () => {
    const health = await json<{ last_process_ts: number; bot_start_ts: number; bot_startup_ts: number }>(
      await ft('votemax', 'health'),
    );
    const fixtureHealth = readJson<{ bot_start_ts: number; bot_startup_ts: number }>('freqtrade/votemax_health.json');
    expect(Math.abs(health.last_process_ts - Date.now() / 1000)).toBeLessThan(10);
    expect(health.bot_start_ts).toBe(fixtureHealth.bot_start_ts);
    expect(health.bot_startup_ts).toBe(fixtureHealth.bot_startup_ts);
  });

  it('serves the sampled endpoints', async () => {
    const status = await json<{ orders: { order_id: string }[] }[]>(await ft('votemax', 'status'));
    expect(status).toHaveLength(1);
    expect(status[0]?.orders[0]?.order_id).toBe('O6ROFS-APVH7-255LCC');
    expect(await json(await ft('dca', 'status'))).toEqual([]);
    const config = await json<{ strategy: string; state: string }>(await ft('dca', 'show_config'));
    expect(config).toMatchObject({ strategy: 'DcaBot', state: 'running' });
    expect((await json<{ whitelist: string[] }>(await ft('votemax', 'whitelist'))).whitelist).toEqual([
      'BTC/USD',
      'ETH/USD',
    ]);
    expect(await json(await ft('votemax', 'locks'))).toMatchObject({ lock_count: 0 });
    const balance = await json<{ currencies: { currency: string }[] }>(await ft('dca', 'balance'));
    expect(balance.currencies.map((c) => c.currency)).toContain('USD');
  });

  it('paginates trades with limit and offset', async () => {
    const all = await json<{
      trades: { trade_id: number }[];
      trades_count: number;
      total_trades: number;
      offset: number;
    }>(await ft('votemax', 'trades', '?limit=500'));
    expect(all.trades_count).toBe(all.trades.length);
    expect(all.total_trades).toBe(all.trades.length);
    const page = await json<{ trades: { trade_id: number }[]; offset: number; total_trades: number }>(
      await ft('votemax', 'trades', '?limit=1&offset=1'),
    );
    expect(page.trades.map((t) => t.trade_id)).toEqual([all.trades[1]?.trade_id]);
    expect(page.offset).toBe(1);
    expect(page.total_trades).toBe(all.total_trades);
    const beyond = await json<{ trades: unknown[]; trades_count: number }>(
      await ft('votemax', 'trades', `?limit=500&offset=${all.total_trades}`),
    );
    expect(beyond).toMatchObject({ trades: [], trades_count: 0 });
  });

  it('serves pair_candles (limit, empty for other timeframes) and a strategy specific plot_config', async () => {
    const candles = await json<{ length: number; data: unknown[]; columns: string[]; strategy: string }>(
      await ft('votemax', 'pair_candles', '?pair=BTC/USD&timeframe=4h&limit=2'),
    );
    expect(candles).toMatchObject({ length: 2, strategy: 'VoteMaxMulti' });
    expect(candles.data).toHaveLength(2);
    expect(candles.columns).toContain('enter_long');
    const other = await json<{ length: number; data: unknown[] }>(
      await ft('votemax', 'pair_candles', '?pair=BTC/USD&timeframe=1d'),
    );
    expect(other).toMatchObject({ length: 0, data: [] });
    expect((await ft('votemax', 'pair_candles', '?pair=DOGE/USD&timeframe=4h')).status).toBe(404);

    const votemax = await json<{ main_plot: Record<string, unknown>; subplots: Record<string, unknown> }>(
      await ft('votemax', 'plot_config'),
    );
    expect(Object.keys(votemax.main_plot)).toEqual(
      expect.arrayContaining(['ema20', 'ema50', 'support_4h', 'resistance_1w_1w']),
    );
    expect(Object.keys(votemax.subplots)).toEqual(['RSI', 'Score', 'Touches']);
    const dca = await json<{ subplots: Record<string, unknown> }>(await ft('dca', 'plot_config'));
    expect(Object.keys(dca.subplots)).toEqual(['RSI']);
  });

  it('serves /logs in the freqtrade record format', async () => {
    const logs = await json<{ log_count: number; logs: [string, number, string, string, string][] }>(
      await ft('votemax', 'logs', '?limit=5'),
    );
    expect(logs.log_count).toBe(logs.logs.length);
    expect(logs.logs.length).toBeGreaterThan(0);
    const [time, ts, logger, level, message] = logs.logs[0] ?? [];
    expect(time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(typeof ts).toBe('number');
    expect([logger, level, message].every((v) => typeof v === 'string')).toBe(true);
  });

  it('refuses writes and records them as violations', async () => {
    const res = await fetch(`${base}/votemax/api/v1/forceexit`, {
      method: 'POST',
      headers: { Authorization: basic('votemax') },
    });
    expect(res.status).toBe(405);
    const calls = await json<{ count: number; calls: { method: string; violation: string | null }[] }>(
      await control('GET', '/__calls?violations=1'),
    );
    expect(calls.count).toBe(1);
    expect(calls.calls[0]).toMatchObject({ method: 'POST' });
    expect(calls.calls[0]?.violation).toMatch(/read-only/);
  });
});

describe('Kraken public', () => {
  it('serves Time from the virtual clock, Ticker, AssetPairs and OHLC from captures', async () => {
    const time = await json<{ result: { unixtime: number; rfc1123: string } }>(
      await fetch(`${base}/kraken/0/public/Time`),
    );
    expect(Math.abs(time.result.unixtime - Date.now() / 1000)).toBeLessThan(10);
    expect(time.result.rfc1123).toMatch(/^\w{3}, \d{2} \w{3} \d{2} \d{2}:\d{2}:\d{2} \+0000$/);

    const ticker = await json<{ result: Record<string, { c: string[] }> }>(
      await fetch(`${base}/kraken/0/public/Ticker?pair=XBTUSD,ETHUSD`),
    );
    expect(Object.keys(ticker.result).sort()).toEqual(['XETHZUSD', 'XXBTZUSD']);
    const pairs = await json<{ result: Record<string, unknown> }>(
      await fetch(`${base}/kraken/0/public/AssetPairs?pair=XBT/USD`),
    );
    expect(Object.keys(pairs.result)).toEqual(['XXBTZUSD']);
    expect(
      (await json<{ error: string[] }>(await fetch(`${base}/kraken/0/public/AssetPairs?pair=NOPE`))).error,
    ).toEqual(['EQuery:Unknown asset pair']);
    const assets = await json<{ result: Record<string, { altname: string }> }>(
      await fetch(`${base}/kraken/0/public/Assets`),
    );
    expect(assets.result.XXBT?.altname).toBe('XBT');

    const ohlc = await json<{ result: { last: number; XXBTZUSD: unknown[][] } }>(
      await fetch(`${base}/kraken/0/public/OHLC?pair=XBTUSD&interval=240`),
    );
    expect(ohlc.result.XXBTZUSD).toHaveLength(721);
    expect((ohlc.result.XXBTZUSD.at(-1)?.[0] as number) > ohlc.result.last).toBe(true);
    const since = await json<{ result: { XXBTZUSD: unknown[][] } }>(
      await fetch(`${base}/kraken/0/public/OHLC?pair=XBTUSD&interval=240&since=${ohlc.result.last}`),
    );
    expect(since.result.XXBTZUSD).toHaveLength(1);
  });
});

describe('Kraken private authentication', () => {
  it('accepts a valid signature and returns the fixture data', async () => {
    const reply = await kraken('Balance');
    expect(reply.error).toEqual([]);
    expect(Object.keys(reply.result)).toEqual(['ZUSD', 'XXBT', 'XETH', 'SHIB', 'BABY']);
    const ex = await kraken('BalanceEx');
    expect(ex.result.ZUSD).toMatchObject({ balance: '1759.7846', credit: '0.0000', hold_trade: '0.0000' });
    expect((await openOrders()).open).toEqual({});
    expect((await kraken('TradeVolume', { pair: 'XBTUSD,ETHUSD' })).result).toMatchObject({
      fees: { XXBTZUSD: { fee: '0.4000' } },
    });
    expect((await kraken('Ledgers', { type: 'deposit' })).result).toEqual({ ledger: {}, count: 0 });
  });

  it('answers a bad signature with EAPI:Invalid signature and result {}', async () => {
    const wrongSecret = Buffer.from('another-secret-that-is-not-the-mock-one-------------------------').toString(
      'base64',
    );
    const reply = await kraken('Balance', {}, { secret: wrongSecret });
    expect(reply).toEqual({ error: ['EAPI:Invalid signature'], result: {} });
    expect(await kraken('Balance', {}, { tamper: true })).toEqual({ error: ['EAPI:Invalid signature'], result: {} });
    const unsigned = await fetch(`${base}/kraken/0/private/Balance`, {
      method: 'POST',
      headers: { 'API-Key': CREDS.key },
      body: `nonce=${nextNonce()}`,
    });
    expect(await json(unsigned)).toEqual({ error: ['EAPI:Invalid signature'], result: {} });
  });

  it('rejects an unknown API key', async () => {
    expect((await kraken('Balance', {}, { key: 'NOT-THE-MOCK-KEY' })).error).toEqual(['EAPI:Invalid key']);
  });

  it('signs the /0/private path, not the mock prefix', async () => {
    const nonce = nextNonce();
    const body = `nonce=${nonce}`;
    const res = await fetch(`${base}/kraken/0/private/Balance`, {
      method: 'POST',
      headers: { 'API-Key': CREDS.key, 'API-Sign': sign('/kraken/0/private/Balance', nonce, body, CREDS.secret) },
      body,
    });
    expect((await json<KrakenReply>(res)).error).toEqual(['EAPI:Invalid signature']);
  });

  it('enforces strictly increasing nonces and ignores rejected requests', async () => {
    const n = BigInt(nextNonce());
    expect((await kraken('Balance', {}, { nonce: String(n + 10n) })).error).toEqual([]);
    expect((await kraken('Balance', {}, { nonce: String(n + 10n) })).error).toEqual(['EAPI:Invalid nonce']);
    expect((await kraken('Balance', {}, { nonce: String(n + 5n) })).error).toEqual(['EAPI:Invalid nonce']);
    // a request with a bad signature must not advance the nonce
    expect((await kraken('Balance', {}, { nonce: String(n + 20n), tamper: true })).error).toEqual([
      'EAPI:Invalid signature',
    ]);
    expect((await kraken('Balance', {}, { nonce: String(n + 11n) })).error).toEqual([]);
    expect((await kraken('Balance', {}, { nonce: 'abc' })).error).toEqual(['EAPI:Invalid nonce']);
    nonceSeed = Number(n + 100n);
  });

  it('refuses non-allowlisted methods and records them as violations', async () => {
    const reply = await kraken('AddOrder', { pair: 'XBTUSD', type: 'buy', ordertype: 'market', volume: '1' });
    expect(reply.error).toEqual(['EGeneral:Permission denied']);
    const calls = await json<{ calls: { path: string; violation: string | null }[] }>(
      await control('GET', '/__calls?violations=1'),
    );
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]?.violation).toMatch(/AddOrder/);
  });
});

describe('ClosedOrders pagination', () => {
  it('pages with ofs, reports the total count and sorts newest first', async () => {
    await setScenario({ name: 'incident', speed: 1, delayMs: 0 });
    await setClock({ mode: 'manual', advanceMs: 3_000_000 });
    const pages: Record<string, Order>[] = [];
    let count = 0;
    for (let ofs = 0; ofs < 60; ofs += 10) {
      const page = await closedOrders({ ofs: String(ofs) });
      count = page.count;
      pages.push(page.closed);
    }
    expect(count).toBe(43);
    expect(pages.map((p) => Object.keys(p).length)).toEqual([10, 10, 10, 10, 3, 0]);
    const all = pages.flatMap((p) => Object.entries(p));
    expect(new Set(all.map(([txid]) => txid)).size).toBe(43);
    const closeTimes = all.map(([, o]) => o.closetm ?? 0);
    expect(closeTimes).toEqual([...closeTimes].sort((a, b) => b - a));
  });

  it('filters by start, end and closetime', async () => {
    await setScenario({ name: 'incident', speed: 1, delayMs: 0 });
    await setClock({ mode: 'manual', advanceMs: 3_000_000 });
    const all = Object.values(await allClosedOrders());
    expect(all).toHaveLength(43);
    const cutoff = all.map((o) => o.closetm ?? 0).sort((a, b) => a - b)[20] as number;
    const after = await closedOrders({ closetime: 'close', start: String(cutoff) });
    expect(after.count).toBe(all.filter((o) => (o.closetm ?? 0) > cutoff).length);
    const upTo = await closedOrders({ closetime: 'close', end: String(cutoff) });
    expect(upTo.count).toBe(all.filter((o) => (o.closetm ?? 0) <= cutoff).length);
    expect(after.count + upTo.count).toBe(43);
  });

  it('uses 50 orders per page by default', async () => {
    const plain = await startMock();
    try {
      await setScenario({ name: 'incident', speed: 1, delayMs: 0 }, plain.base);
      await control('POST', '/__clock', { mode: 'manual', advanceMs: 3_000_000 }, plain.base);
      const first = await closedOrders({ ofs: '0' }, plain.base);
      expect(first.count).toBe(43);
      expect(Object.keys(first.closed)).toHaveLength(43);
      expect(Object.keys((await closedOrders({ ofs: '40' }, plain.base)).closed)).toHaveLength(3);
    } finally {
      await stopMock(plain);
    }
  }, 30_000);

  it('answers QueryOrders for known txids only', async () => {
    const known = await kraken('QueryOrders', { txid: 'O6ROFS-APVH7-255LCC,NOPE' });
    expect(Object.keys(known.result)).toEqual(['O6ROFS-APVH7-255LCC']);
    expect((await kraken('QueryOrders', { txid: 'NOPE' })).error).toEqual(['EOrder:Unknown order']);
  });
});

describe('scenario control', () => {
  it('switches scenarios, validates the request and reports the clock', async () => {
    expect(await json(await control('GET', '/__scenario'))).toMatchObject({ name: 'normal' });
    expect((await control('POST', '/__scenario', { name: 'nope' })).status).toBe(400);
    expect((await control('POST', '/__scenario', { name: 'incident', speed: -1 })).status).toBe(400);
    expect((await control('POST', '/__scenario', { name: 'bot-down', mode: 'explode' })).status).toBe(400);
    const incident = await setScenario({ name: 'incident' });
    expect(incident).toMatchObject({ name: 'incident', speed: 6, delayMs: 3000 });
    const st = await state();
    expect(st.scenario.name).toBe('incident');
    expect(st.incident?.done).toBe(false);
    await setScenario({ name: 'normal' });
    expect((await state()).incident).toBeNull();
  });

  it('kraken-auth-error: private endpoints answer EAPI:Invalid key, public ones keep working', async () => {
    await setScenario({ name: 'kraken-auth-error' });
    expect(await kraken('Balance')).toEqual({ error: ['EAPI:Invalid key'], result: {} });
    expect((await fetch(`${base}/kraken/0/public/Time`)).status).toBe(200);
    expect((await ft('votemax', 'health')).status).toBe(200);
  });

  it('no-kraken: private endpoints are 404 and count as violations', async () => {
    await setScenario({ name: 'no-kraken' });
    const nonce = nextNonce();
    const res = await fetch(`${base}/kraken/0/private/Balance`, { method: 'POST', body: `nonce=${nonce}` });
    expect(res.status).toBe(404);
    expect((await fetch(`${base}/kraken/0/public/Ticker?pair=XBTUSD`)).status).toBe(200);
    const calls = await json<{ count: number }>(await control('GET', '/__calls?violations=1'));
    expect(calls.count).toBe(1);
  });

  it('bot-down: votemax resets the connection, dca hangs; mode overrides both', async () => {
    await setScenario({ name: 'bot-down' });
    await expect(ft('votemax', 'health')).rejects.toThrow();
    const hung = fetch(`${base}/dca/api/v1/health`, {
      headers: { Authorization: basic('dca') },
      signal: AbortSignal.timeout(400),
    });
    await expect(hung).rejects.toThrow();
    await setScenario({ name: 'bot-down', mode: '503' });
    expect((await ft('votemax', 'health')).status).toBe(503);
    expect((await ft('dca', 'ping')).status).toBe(503);
    await setScenario({ name: 'normal' });
    expect((await ft('votemax', 'health')).status).toBe(200);
  });

  it('writes no bot log lines while both bots are down', async () => {
    await setClock({ mode: 'manual', now: 1_790_700_000_000 });
    await setScenario({ name: 'bot-down' });
    await setClock({ advanceMs: 600_000 });
    const st = await state();
    expect(st.logs.votemax?.lines).toBe(0);
    expect(st.logs.dca?.lines).toBe(0);
  });
});

describe('notification sinks', () => {
  it('records Discord posts, readable and clearable through /__received', async () => {
    const discord = await fetch(`${base}/discord/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '[freqdash] hello', embeds: [{ title: 'x' }] }),
    });
    expect(discord.status).toBe(204);
    const received = await json<{
      count: number;
      discord: { body: { content: string }; path: string }[];
    }>(await control('GET', '/__received'));
    expect(received.count).toBe(1);
    expect(received.discord[0]?.body.content).toBe('[freqdash] hello');
    expect((await control('DELETE', '/__received')).status).toBe(204);
    expect((await json<{ count: number }>(await control('GET', '/__received'))).count).toBe(0);
  });
});

describe('incident replay', () => {
  const T0 = 1_790_700_000_000;
  const incidentTxids = timeline.events.filter((e) => e.type === 'order_created').map((e) => e.orderId ?? '');
  const ETH_BEFORE = 8.9e-9;

  it('compresses the crash loop: about one order every 3 s at the default speed', async () => {
    await setClock({ mode: 'manual', now: T0 });
    await setScenario({ name: 'incident', delayMs: 0 });
    await setClock({ advanceMs: 200_000 });
    const text = fs.readFileSync(path.join(main.runDir, 'votemax.log'), 'utf8');
    const times = lineTimes(text, / was created for ETH\/USD/);
    expect(times.length).toBeGreaterThanOrEqual(24);
    const gaps = times.slice(1, 24).map((t, i) => t - (times[i] ?? 0));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(2500);
    expect(mean).toBeLessThan(3500);
    // a quiet 67 minutes in the real incident are capped, so the whole replay is short
    const st = await state();
    expect(st.incident ? st.incident.endsAt - st.incident.t0 : Infinity).toBeLessThan(200_000);
  });

  it('replays the timeline progressively across bots, Kraken and the log', async () => {
    await setClock({ mode: 'manual', now: T0 });
    await setScenario({ name: 'incident', speed: 1, delayMs: 0, resetNonce: true });
    const first = incidentTxids[0] ?? '';

    // 1 s in: the first order is open on Kraken, ETH is unchanged, USD is held
    await setClock({ advanceMs: 1000 });
    const st = await state();
    expect(st.incident?.counts).toMatchObject({ ordersCreated: 1, entrySignals: 1, processDied: 1 });
    expect(Object.keys((await openOrders()).open)).toEqual([first]);
    let ex = (await kraken('BalanceEx')).result as Record<string, { balance: string; hold_trade: string }>;
    expect(Number(ex.XETH?.balance)).toBeCloseTo(ETH_BEFORE, 12);
    expect(Number(ex.ZUSD?.hold_trade)).toBeGreaterThan(30);
    expect(ex.ZUSD?.balance).toBe('1801.7694');
    expect(Object.keys((await closedOrders()).closed)).not.toContain(first);

    // 31 s in: the first order has filled
    await setClock({ advanceMs: 30_000 });
    const closed = await closedOrders({ ofs: '0' });
    expect(Object.keys(closed.closed)).toContain(first);
    ex = (await kraken('BalanceEx')).result as Record<string, { balance: string; hold_trade: string }>;
    expect(Number(ex.XETH?.balance)).toBeCloseTo(ETH_BEFORE + 0.01393687, 9);
    const dcaWallet = await json<{ currencies: { currency: string; balance: number }[] }>(await ft('dca', 'balance'));
    expect(dcaWallet.currencies.find((c) => c.currency === 'ETH')?.balance).toBeCloseTo(ETH_BEFORE + 0.01393687, 9);
    const staleWallet = await json<{ currencies: { currency: string; balance: number }[] }>(
      await ft('votemax', 'balance'),
    );
    expect(staleWallet.currencies.find((c) => c.currency === 'ETH')?.balance).toBeCloseTo(ETH_BEFORE, 12);

    // the votemax API disappears around each crash and its startup timestamp changes on each restart
    const outages = (await state()).incident?.votemax.outages ?? [];
    expect(outages.slice(0, 2).map((o) => o.kind)).toEqual(['reset', '503']);
    const [o0, o1] = outages;
    if (!o0 || !o1) throw new Error('expected two outages');
    const startupAt = async () =>
      (await json<{ bot_startup_ts: number }>(await ft('votemax', 'health'))).bot_startup_ts;
    const baseline = readJson<{ bot_startup_ts: number }>('freqtrade/votemax_health.json').bot_startup_ts;
    await setClock({ now: Math.floor((o0.start + o0.end) / 2) });
    expect((await state()).bots.votemax?.availability).toBe('reset');
    await setClock({ now: o0.end + 1 });
    const ts0 = await startupAt();
    await setClock({ now: Math.floor((o1.start + o1.end) / 2) });
    expect((await state()).bots.votemax?.availability).toBe('503');
    expect((await ft('votemax', 'health')).status).toBe(503);
    expect((await ft('dca', 'health')).status).toBe(200);
    await setClock({ now: o1.end + 1 });
    const ts1 = await startupAt();
    expect(ts0).toBeGreaterThan(baseline);
    expect(ts1).toBeGreaterThan(ts0);
  });

  it('drops the connection during a reset outage', async () => {
    await setClock({ mode: 'manual', now: T0 });
    await setScenario({ name: 'incident', speed: 1, delayMs: 0 });
    const o0 = (await state()).incident?.votemax.outages[0];
    if (!o0) throw new Error('expected an outage');
    await setClock({ now: Math.floor((o0.start + o0.end) / 2) });
    await expect(ft('votemax', 'health')).rejects.toThrow();
    expect((await ft('dca', 'health')).status).toBe(200);
  });

  it('ends with the orphan orders and the full ETH balance, while the bot never learns the txids', async () => {
    await setClock({ mode: 'manual', now: T0 });
    await setScenario({ name: 'incident', speed: 1, delayMs: 0, resetNonce: true });
    await setClock({ advanceMs: 3_000_000 });
    const st = await state();
    expect(st.incident?.done).toBe(true);
    expect(st.incident?.counts).toEqual({
      entrySignals: timeline.counts.entry_signal,
      ordersCreated: timeline.counts.order_created,
      ordersFailed: timeline.counts.order_failed,
      processDied: timeline.counts.process_died,
      fatals: timeline.counts.fatal,
      startups: timeline.counts.startup,
    });
    expect(st.incident?.krakenOrdersVisible).toBe(26);

    expect(Object.keys((await openOrders()).open)).toEqual([]);
    const closed = await closedOrders({ ofs: '0' });
    expect(closed.count).toBe(43);
    const ids = Object.keys(await allClosedOrders());
    for (const txid of [...incidentTxids, 'OWDY2Z-TVWRN-IJBALL']) expect(ids).toContain(txid);
    const ex = (await kraken('BalanceEx')).result as Record<string, { balance: string }>;
    expect(ex.XETH?.balance).toBe('0.1130240889');
    expect(ex.ZUSD?.balance).toBe('1501.1379');
    expect(ex.XXBT?.balance).toBe('0.0004674400');

    const botText = JSON.stringify([
      await json(await ft('votemax', 'status')),
      await json(await ft('votemax', 'trades', '?limit=500')),
    ]);
    for (const txid of [...incidentTxids, 'OWDY2Z-TVWRN-IJBALL']) expect(botText).not.toContain(txid);
    const dcaWallet = await json<{ currencies: { currency: string; balance: number }[] }>(await ft('dca', 'balance'));
    expect(dcaWallet.currencies.find((c) => c.currency === 'ETH')?.balance).toBeCloseTo(0.1130240889, 10);
  });

  it('writes a votemax log that parses to the same events as timeline.json, and a quiet dca log', async () => {
    await setClock({ mode: 'manual', now: T0 });
    await setScenario({ name: 'incident', speed: 1, delayMs: 0 });
    await setClock({ advanceMs: 3_000_000 });
    const votemaxText = fs.readFileSync(path.join(main.runDir, 'votemax.log'), 'utf8');
    const expected = timeline.events.map((e) => {
      const ev: ParsedEvent = { type: e.type };
      if (e.orderId) ev.orderId = e.orderId;
      if (e.pair) ev.pair = e.pair;
      if (e.type === 'entry_signal') {
        ev.price = e.price;
        ev.stakeUsd = e.stakeUsd;
      }
      if (e.message) ev.message = e.message;
      return ev;
    });
    expect(extractEvents(parseRecords(votemaxText))).toEqual(expected);
    expect(votemaxText).toMatch(/ValueError: invalid literal for int\(\) with base 10: ''\n/);

    // heartbeats keep coming in scenario time, none while the process is down; no incident events on dca
    const dcaText = fs.readFileSync(path.join(main.runDir, 'dca.log'), 'utf8');
    expect(extractEvents(parseRecords(dcaText))).toEqual([]);
    expect(dcaText.split('\n').filter((l) => l.includes('Bot heartbeat.')).length).toBeGreaterThanOrEqual(9);
    for (const line of dcaText.split('\n').filter(Boolean)) expect(line).toMatch(LOG_LINE);
    expect(votemaxText.split('\n').filter((l) => l.includes('Bot heartbeat.')).length).toBeGreaterThanOrEqual(5);
  });

  it('starts a fresh log on every scenario switch', async () => {
    await setClock({ mode: 'manual', now: T0 });
    await setScenario({ name: 'incident', speed: 1, delayMs: 0 });
    await setClock({ advanceMs: 100_000 });
    expect(fs.readFileSync(path.join(main.runDir, 'votemax.log'), 'utf8')).toContain('Fatal exception!');
    await setScenario({ name: 'normal' });
    const text = fs.readFileSync(path.join(main.runDir, 'votemax.log'), 'utf8');
    expect(text).not.toContain('Fatal exception!');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    expect(text).toContain('Bot heartbeat. PID=1');
  });

  it('keeps /logs free of the fatal record and clears it on restart', async () => {
    await setClock({ mode: 'manual', now: T0 });
    await setScenario({ name: 'incident', speed: 1, delayMs: 0 });
    await setClock({ advanceMs: 3000 });
    await setClock({ advanceMs: 10_000 });
    const logs = await json<{ logs: string[][] }>(await ft('votemax', 'logs'));
    const messages = logs.logs.map((l) => l[4] ?? '');
    expect(messages.some((m) => m.startsWith('Fatal exception'))).toBe(false);
    expect(messages).toContain('Logfile configured');
    expect(messages.some((m) => m.includes('Order OX2D7A-ROVIF-A3YVZW'))).toBe(false);
  });
});

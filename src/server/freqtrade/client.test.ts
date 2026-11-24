import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FT_ALLOWED_PATHS, FreqtradeClient } from './client';

function fixtureText(name: string): string {
  const url = new URL(`../../../test/fixtures/raw/freqtrade/${name}.json`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

const USER = 'dash-user';
const PASS = 'p@ss:w0rd/with?odd#chars';
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

interface Call {
  url: string;
  init: RequestInit;
}

function harness(respond: (call: Call) => Response | Promise<Response>, base = 'http://freqtrade-votemax:8080') {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  let clock = 1_000;
  const client = new FreqtradeClient({ url: base, username: USER, password: PASS }, fetchImpl, {
    now: () => (clock += 10),
  });
  return { client, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FreqtradeClient request shape', () => {
  it('issues only GET to allowlisted /api/v1 paths, with a Basic header and no credentials in the URL', async () => {
    const { client, calls } = harness(({ url }) => {
      if (url.includes('/status')) return json('[]');
      if (url.includes('/trades')) return json({ trades: [], trades_count: 0, offset: 0, total_trades: 0 });
      if (url.includes('/balance')) return json(fixtureText('votemax_balance'));
      if (url.includes('/whitelist')) return json(fixtureText('votemax_whitelist'));
      if (url.includes('/locks')) return json(fixtureText('votemax_locks'));
      if (url.includes('/logs')) return json(fixtureText('votemax_logs'));
      if (url.includes('/strategy/')) return json({ strategy: 'VoteMaxMulti', code: 'class VoteMaxMulti: pass' });
      if (url.includes('/plot_config')) return json({ main_plot: {}, subplots: {} });
      if (url.includes('/pair_candles')) return json(fixtureText('votemax_pair_candles_BTC_4h'));
      if (url.includes('/show_config')) return json(fixtureText('votemax_show_config'));
      if (url.includes('/health')) return json(fixtureText('votemax_health'));
      return json({ status: 'pong' });
    });

    const results = await Promise.all([
      client.ping(),
      client.health(),
      client.showConfig(),
      client.status(),
      client.trades(),
      client.balance(),
      client.whitelist(),
      client.locks(),
      client.logs(1000),
      client.plotConfig(),
      client.pairCandles('BTC/USD', '4h', 720),
      client.strategy('VoteMaxMulti'),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);

    const paths = new Set<string>();
    for (const { url, init } of calls) {
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe(AUTH);
      const parsed = new URL(url);
      expect(parsed.username).toBe('');
      expect(parsed.password).toBe('');
      expect(url).not.toContain(PASS);
      expect(url).not.toContain(encodeURIComponent(PASS));
      expect(url).not.toContain(USER);
      expect(parsed.pathname.startsWith('/api/v1/')).toBe(true);
      paths.add(parsed.pathname.slice('/api/v1/'.length).split('/')[0]!);
    }
    expect([...paths].sort()).toEqual([...FT_ALLOWED_PATHS].sort());
  });

  it('only accepts plain identifiers as strategy names', () => {
    const { client } = harness(() => json({}));
    for (const bad of ['', '../config', 'a/b', 'x?y=1', 'a b'])
      expect(() => client.strategy(bad)).toThrow('invalid strategy name');
  });

  it('keeps a base URL path prefix by string concatenation and tolerates trailing slashes', async () => {
    const { client, calls } = harness(() => json(fixtureText('votemax_health')), 'http://localhost:9999/votemax//');
    await client.health();
    expect(calls[0]!.url).toBe('http://localhost:9999/votemax/api/v1/health');
  });

  it('encodes the candle query and truncates the limit', async () => {
    const { client, calls } = harness(() => json(fixtureText('votemax_pair_candles_BTC_4h')));
    await client.pairCandles('BTC/USD', '4h', 3.9);
    expect(calls[0]!.url).toBe('http://freqtrade-votemax:8080/api/v1/pair_candles?pair=BTC%2FUSD&timeframe=4h&limit=3');
  });

  it('applies AbortSignal.timeout(8000) to every request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { client, calls } = harness(() => json({ status: 'pong' }));
    await client.ping();
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a base URL that embeds credentials, without echoing it', () => {
    let message = '';
    try {
      new FreqtradeClient({ url: 'http://u:secretpw@host:8080', username: 'a', password: 'b' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must not embed credentials/);
    expect(message).not.toContain('secretpw');
  });

  it('has no way to send anything but GET: the client exposes no mutating verbs', () => {
    const { client } = harness(() => json({}));
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter((n) => n !== 'constructor');
    expect(methods.sort()).toEqual(
      [
        'balance',
        'health',
        'locks',
        'logs',
        'pairCandles',
        'ping',
        'plotConfig',
        'showConfig',
        'status',
        'strategy',
        'trades',
        'whitelist',
      ].sort(),
    );
  });
});

describe('FreqtradeClient results', () => {
  it('returns data with fetchedAt and latency', async () => {
    const { client } = harness(() => json(fixtureText('votemax_health')));
    const res = await client.health();
    expect(res).toMatchObject({ ok: true, fetchedAt: 1_020, latencyMs: 10 });
    if (res.ok) expect(res.data.last_process_ts).toBe(1790630988);
  });

  it('maps 401 and 403 to auth', async () => {
    for (const status of [401, 403]) {
      const { client } = harness(() => json({ detail: 'Unauthorized' }, status));
      const res = await client.status();
      expect(res).toMatchObject({ ok: false, error: { kind: 'auth', status } });
    }
  });

  it('maps other HTTP errors to http, keeping the redacted detail', async () => {
    const { client } = harness(() => json({ detail: 'boom token=abc123def' }, 500));
    const res = await client.status();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('http');
      expect(res.error.status).toBe(500);
      expect(res.error.message).toContain('boom');
      expect(res.error.message).not.toContain('abc123def');
    }
  });

  it('treats a redirect as an http error instead of following it', async () => {
    const { client, calls } = harness(
      () => new Response(null, { status: 302, headers: { location: 'http://elsewhere/' } }),
    );
    const res = await client.ping();
    expect(res).toMatchObject({ ok: false, error: { kind: 'http', status: 302 } });
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('maps a network failure to network without leaking credentials', async () => {
    const { client } = harness(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 172.18.0.2:8080') });
    });
    const res = await client.health();
    expect(res).toMatchObject({ ok: false, error: { kind: 'network' } });
    if (!res.ok) {
      expect(res.error.message).toContain('ECONNREFUSED');
      expect(res.error.message).not.toContain(PASS);
    }
  });

  it('maps a timeout to timeout', async () => {
    const { client } = harness(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await client.health()).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('maps invalid JSON and wrong shapes to parse', async () => {
    const notJson = await harness(() => json('<html>nope</html>')).client.health();
    expect(notJson).toMatchObject({ ok: false, error: { kind: 'parse' } });

    const wrongShape = await harness(() => json({ trades: 'not-a-list' })).client.trades();
    expect(wrongShape).toMatchObject({ ok: false, error: { kind: 'parse' } });
    if (!wrongShape.ok) expect(wrongShape.error.message).toContain('trades');
  });
});

describe('FreqtradeClient.trades pagination', () => {
  const trade = (id: number) => ({ trade_id: id, pair: 'BTC/USD', orders: [] });

  it('walks pages of 500 until the total is reached and merges them', async () => {
    const total = 1_203;
    const { client, calls } = harness(({ url }) => {
      const q = new URL(url).searchParams;
      const offset = Number(q.get('offset'));
      const limit = Number(q.get('limit'));
      const count = Math.min(limit, total - offset);
      return json({
        trades: Array.from({ length: count }, (_, i) => trade(offset + i + 1)),
        trades_count: count,
        offset,
        total_trades: total,
      });
    });
    const res = await client.trades();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.trades).toHaveLength(total);
      expect(res.data.trades[0]!.trade_id).toBe(1);
      expect(res.data.trades[total - 1]!.trade_id).toBe(total);
      expect(res.data.total_trades).toBe(total);
    }
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '500', '1000']);
    expect(calls.every((c) => new URL(c.url).searchParams.get('limit') === '500')).toBe(true);
  });

  it('stops after one page when everything fits (real /trades sample, total adjusted to its 3 rows)', async () => {
    const page = { ...(JSON.parse(fixtureText('votemax_trades')) as Record<string, unknown>), total_trades: 3 };
    const { client, calls } = harness(() => json(page));
    const res = await client.trades();
    expect(res.ok && res.data.trades.map((t) => t.trade_id)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
  });

  it('stops on an empty page even if the reported total is larger', async () => {
    let n = 0;
    const { client, calls } = harness(() =>
      json({ trades: n++ === 0 ? [trade(1), trade(2)] : [], trades_count: 0, offset: 0, total_trades: 99 }),
    );
    const res = await client.trades();
    expect(res.ok && res.data.trades).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('uses a short page as the end when the server does not report a total', async () => {
    const { client, calls } = harness(() => json({ trades: [trade(1)] }));
    const res = await client.trades();
    expect(res.ok && res.data.trades).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('fails the whole call when a later page fails', async () => {
    let n = 0;
    const { client } = harness(() =>
      n++ === 0
        ? json({ trades: Array.from({ length: 500 }, (_, i) => trade(i + 1)), total_trades: 900 })
        : json({ detail: 'down' }, 503),
    );
    expect(await client.trades()).toMatchObject({ ok: false, error: { kind: 'http', status: 503 } });
  });

  it('never loops forever', async () => {
    const { client, calls } = harness(() =>
      json({ trades: Array.from({ length: 500 }, (_, i) => trade(i + 1)), total_trades: 10_000_000 }),
    );
    const res = await client.trades();
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(100);
  });
});

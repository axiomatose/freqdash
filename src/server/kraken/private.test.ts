import { afterEach, describe, expect, it, vi } from 'vitest';
import balanceFixture from '../../../test/fixtures/raw/kraken/private/Balance.json';
import invalidKey from '../../../test/fixtures/raw/kraken/errors/invalid_key.json';
import invalidNonce from '../../../test/fixtures/raw/kraken/errors/invalid_nonce.json';
import permissionDenied from '../../../test/fixtures/raw/kraken/errors/permission_denied.json';
import rateLimit from '../../../test/fixtures/raw/kraken/errors/rate_limit.json';
import throttled from '../../../test/fixtures/raw/kraken/errors/throttled.json';
import unavailable from '../../../test/fixtures/raw/kraken/errors/unavailable.json';
import { clearRegisteredSecrets } from '../log';
import { KrakenError } from './errors';
import { createNonceSource, NONCE_BUMP_MS } from './nonce';
import { isAllowedPrivateMethod, KrakenPrivateClient } from './private';
import { KrakenRateLimiter } from './ratelimit';
import { signRequest } from './sign';
import { KRAKEN_PRIVATE_METHODS, type KrakenFetch } from './types';

// Kraken's documented example secret (a valid base64 string), not a credential.
const SECRET = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
const API_KEY = 'test-api-key-0123456789';
const START = 1_790_000_000_000;

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

type Responder = (sent: Sent, index: number) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const ok = (result: unknown) => json({ error: [], result });

function setup(responder: Responder, options: { baseUrl?: string; persisted?: number | null } = {}) {
  const time = { now: START };
  const saved: number[] = [];
  const nonce = createNonceSource(
    () => options.persisted ?? null,
    (n) => saved.push(n),
    () => time.now,
  );
  const limiter = new KrakenRateLimiter({
    tier: 'starter',
    now: () => time.now,
    sleep: async (ms) => {
      time.now += ms;
    },
  });
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<KrakenFetch>[0], init?: Parameters<KrakenFetch>[1]) => {
    const entry: Sent = {
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: String(init?.body),
    };
    sent.push(entry);
    return responder(entry, sent.length - 1);
  });
  const client = new KrakenPrivateClient({
    apiKey: API_KEY,
    apiSecret: SECRET,
    baseUrl: options.baseUrl ?? 'https://api.kraken.com',
    nonce,
    limiter,
    fetchImpl: fetchImpl as unknown as KrakenFetch,
  });
  return { client, fetchImpl, sent, saved, limiter, time };
}

const nonceOf = (body: string): number => Number(new URLSearchParams(body).get('nonce'));

afterEach(() => clearRegisteredSecrets());

describe('endpoint allowlist', () => {
  it('is exactly the seven read-only methods', () => {
    expect([...KRAKEN_PRIVATE_METHODS].sort()).toEqual(
      ['Balance', 'BalanceEx', 'ClosedOrders', 'Ledgers', 'OpenOrders', 'QueryOrders', 'TradeVolume'].sort(),
    );
    for (const method of KRAKEN_PRIVATE_METHODS) expect(isAllowedPrivateMethod(method)).toBe(true);
  });

  it.each([
    'AddOrder',
    'AddOrderBatch',
    'EditOrder',
    'CancelOrder',
    'CancelAll',
    'CancelAllOrdersAfter',
    'Withdraw',
    'WithdrawCancel',
    'WalletTransfer',
    'AddExport',
    'GetWebSocketsToken',
    'OpenPositions',
    'balance',
    'Balance ',
    'Balance/../AddOrder',
    'constructor',
    '__proto__',
    'toString',
    '',
  ])('rejects %j before any queue, limiter, nonce or network activity', async (method) => {
    const { client, fetchImpl, saved, limiter } = setup(() => ok({}));
    const attempt = client.call(method as never, { pair: 'XBTUSD' });
    await expect(attempt).rejects.toBeInstanceOf(KrakenError);
    await expect(attempt).rejects.toMatchObject({ kind: 'forbidden' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(limiter.level()).toBe(0);
  });

  it('is enforced by the type system as well', async () => {
    const { client } = setup(() => ok({}));
    // @ts-expect-error AddOrder is not a KrakenPrivateMethod
    await expect(client.call('AddOrder', {})).rejects.toMatchObject({ kind: 'forbidden' });
    // @ts-expect-error Withdraw is not a KrakenPrivateMethod
    await expect(client.call('Withdraw', {})).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(client.call('Balance')).resolves.toEqual({});
  });

  it('does not let a rejected call break the queue', async () => {
    const { client } = setup(() => ok({ ZUSD: '1' }));
    await expect(client.call('AddOrder' as never)).rejects.toBeInstanceOf(KrakenError);
    await expect(client.call('Balance')).resolves.toEqual({ ZUSD: '1' });
  });

  it('refuses a caller-supplied nonce parameter without consuming a nonce', async () => {
    const { client, saved, fetchImpl } = setup(() => ok({}));
    await expect(client.call('Balance', { nonce: 5 })).rejects.toBeInstanceOf(TypeError);
    expect(saved).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('request format', () => {
  it('POSTs a urlencoded body whose signature covers exactly the sent bytes', async () => {
    const { client, sent } = setup(() => ok(balanceFixture.result));
    await expect(client.call('Balance')).resolves.toEqual(balanceFixture.result);

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.url).toBe('https://api.kraken.com/0/private/Balance');
    expect(request.method).toBe('POST');
    expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded; charset=utf-8');
    expect(request.headers['API-Key']).toBe(API_KEY);
    expect(request.body).toBe(`nonce=${START}`);
    expect(request.headers['API-Sign']).toBe(signRequest('/0/private/Balance', request.body, START, SECRET));
  });

  it('encodes parameters in order after the nonce, skipping undefined and null, joining arrays with commas', async () => {
    const { client, sent } = setup(() => ok({}));
    await client.call('ClosedOrders', {
      start: 1_790_000_000,
      ofs: 50,
      closetime: 'close',
      trades: true,
      txid: ['OORUYZ-2BWGK-SAYX6T', 'O3OVJH-YNYDT-L5RGHT'],
      skipped: undefined,
      alsoSkipped: null,
    });
    const request = sent[0]!;
    expect(request.body).toBe(
      `nonce=${START}&start=1790000000&ofs=50&closetime=close&trades=true` +
        '&txid=OORUYZ-2BWGK-SAYX6T%2CO3OVJH-YNYDT-L5RGHT',
    );
    expect(request.headers['API-Sign']).toBe(signRequest('/0/private/ClosedOrders', request.body, START, SECRET));
  });

  it('joins base URL and path by concatenation, keeping a dev path prefix, and signs the prefix-free path', async () => {
    const { client, sent } = setup(() => ok({}), { baseUrl: 'http://localhost:9999/kraken/' });
    await client.call('OpenOrders');
    expect(sent[0]!.url).toBe('http://localhost:9999/kraken/0/private/OpenOrders');
    expect(sent[0]!.headers['API-Sign']).toBe(signRequest('/0/private/OpenOrders', sent[0]!.body, START, SECRET));
  });

  it('validates its construction arguments', () => {
    const common = {
      nonce: createNonceSource(
        () => null,
        () => undefined,
      ),
      limiter: new KrakenRateLimiter({ tier: 'starter' }),
    };
    expect(() => new KrakenPrivateClient({ ...common, apiKey: '', apiSecret: SECRET, baseUrl: 'https://x' })).toThrow();
    expect(() => new KrakenPrivateClient({ ...common, apiKey: 'k', apiSecret: '', baseUrl: 'https://x' })).toThrow();
    expect(() => new KrakenPrivateClient({ ...common, apiKey: 'k', apiSecret: SECRET, baseUrl: 'ftp://x' })).toThrow();
  });

  it('charges Ledgers 2 points and the others 1', async () => {
    const { client, limiter } = setup(() => ok({}));
    await client.call('Ledgers', { type: 'deposit' });
    expect(limiter.level()).toBeCloseTo(2, 6);
    await client.call('Balance');
    expect(limiter.level()).toBeCloseTo(3, 6);
  });

  it('waits for the limiter instead of overrunning the budget', async () => {
    const { client, limiter, time } = setup(() => ok({}));
    for (let i = 0; i < 14; i++) await client.call('Balance');
    expect(limiter.level()).toBeLessThanOrEqual(12 + 1e-6);
    expect(time.now).toBeGreaterThan(START);
  });
});

describe('serial queue and nonces', () => {
  it('sends 5 concurrent calls one at a time with strictly increasing nonces in send order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { client, sent } = setup(async (_request, index) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Later requests answer faster: without a queue they would overtake the earlier ones.
      await new Promise((resolve) => setTimeout(resolve, 20 - index * 4));
      inFlight -= 1;
      return ok({ index });
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => client.call('Balance')));

    expect(maxInFlight).toBe(1);
    expect(results).toEqual([0, 1, 2, 3, 4].map((index) => ({ index })));
    const nonces = sent.map((request) => nonceOf(request.body));
    expect(nonces).toHaveLength(5);
    for (let i = 1; i < nonces.length; i++) expect(nonces[i]!).toBeGreaterThan(nonces[i - 1]!);
  });

  it('keeps serving the queue after a failed call', async () => {
    const { client } = setup((_request, index) => (index === 0 ? json(invalidKey) : ok({ index })));
    const first = client.call('Balance');
    const second = client.call('Balance');
    await expect(first).rejects.toMatchObject({ kind: 'auth' });
    await expect(second).resolves.toEqual({ index: 1 });
  });

  it('persists every nonce before sending it, and continues above a persisted one', async () => {
    let persisted: number[] = [];
    const persistedAtSend: number[][] = [];
    const { client, saved, sent } = setup(
      () => {
        persistedAtSend.push([...persisted]);
        return ok({});
      },
      { persisted: START + 1_000_000 },
    );
    persisted = saved;
    await client.call('Balance');
    await client.call('Balance');
    expect(saved).toEqual([START + 1_000_001, START + 1_000_002]);
    expect(sent.map((request) => nonceOf(request.body))).toEqual(saved);
    expect(persistedAtSend).toEqual([[START + 1_000_001], [START + 1_000_001, START + 1_000_002]]);
  });

  it('keeps nonces increasing when the clock runs backwards', async () => {
    const { client, sent, time } = setup(() => ok({}));
    await client.call('Balance');
    time.now -= 60_000;
    await client.call('Balance');
    expect(nonceOf(sent[1]!.body)).toBe(nonceOf(sent[0]!.body) + 1);
  });

  it('retries once with a bumped nonce after EAPI:Invalid nonce', async () => {
    const { client, sent, saved } = setup((_request, index) => (index === 0 ? json(invalidNonce) : ok({ done: true })));
    await expect(client.call('Balance')).resolves.toEqual({ done: true });
    expect(sent).toHaveLength(2);
    expect(nonceOf(sent[1]!.body)).toBeGreaterThanOrEqual(nonceOf(sent[0]!.body) + NONCE_BUMP_MS);
    expect(sent[1]!.headers['API-Sign']).toBe(
      signRequest('/0/private/Balance', sent[1]!.body, nonceOf(sent[1]!.body), SECRET),
    );
    expect(sent[1]!.headers['API-Sign']).not.toBe(sent[0]!.headers['API-Sign']);
    expect(saved).toHaveLength(3);
  });

  it('gives up with a nonce error after the single retry', async () => {
    const { client, sent } = setup(() => json(invalidNonce));
    await expect(client.call('Balance')).rejects.toMatchObject({ kind: 'nonce', krakenErrors: ['EAPI:Invalid nonce'] });
    expect(sent).toHaveLength(2);
  });
});

describe('error classes', () => {
  it.each([
    ['auth', invalidKey],
    ['permission', permissionDenied],
    ['unavailable', unavailable],
  ] as const)('%s: rejects without retrying', async (kind, body) => {
    const { client, sent } = setup(() => json(body));
    await expect(client.call('BalanceEx')).rejects.toMatchObject({
      name: 'KrakenError',
      kind,
      endpoint: 'BalanceEx',
      krakenErrors: body.error,
    });
    expect(sent).toHaveLength(1);
  });

  it('classifies unknown Kraken errors as api', async () => {
    const { client } = setup(() => json({ error: ['EGeneral:Invalid arguments'] }));
    await expect(client.call('Balance')).rejects.toMatchObject({ kind: 'api' });
  });

  it('classifies transport failures as network, redacting secrets from the reason', async () => {
    const { client } = setup(() => {
      throw new Error(`connect ECONNREFUSED while using ${API_KEY} and ${SECRET}`);
    });
    const error = await client.call('Balance').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KrakenError);
    expect(error).toMatchObject({ kind: 'network' });
    expect((error as Error).message).toContain('ECONNREFUSED');
    expect((error as Error).message).not.toContain(API_KEY);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('classifies a timeout as network', async () => {
    const { client } = setup(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(client.call('Balance')).rejects.toMatchObject({ kind: 'network' });
  });

  it('classifies gateway responses without a Kraken body by status', async () => {
    const html = () => new Response('<html>Bad Gateway</html>', { status: 502 });
    await expect(setup(html).client.call('Balance')).rejects.toMatchObject({ kind: 'unavailable', status: 502 });
    const limited = () => new Response('', { status: 429 });
    await expect(setup(limited).client.call('Balance')).rejects.toMatchObject({ kind: 'ratelimit', status: 429 });
  });

  it('rejects a 200 without the result envelope as parse', async () => {
    await expect(setup(() => new Response('nope', { status: 200 })).client.call('Balance')).rejects.toMatchObject({
      kind: 'parse',
    });
  });

  it('never puts the key, secret or signature into an error message', async () => {
    const { client, sent } = setup(() => json(invalidKey));
    const error = (await client.call('Balance').catch((e: unknown) => e)) as KrakenError;
    const text = JSON.stringify({ message: error.message, errors: error.krakenErrors, own: Object.entries(error) });
    for (const secret of [API_KEY, SECRET, sent[0]!.headers['API-Sign']!]) expect(text).not.toContain(secret);
  });

  it('does not expose credentials when the client itself is serialised', () => {
    const { client } = setup(() => ok({}));
    const text = JSON.stringify(client);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET);
  });
});

describe('rate-limit handling', () => {
  it.each([
    ['EAPI:Rate limit exceeded', rateLimit],
    ['EService:Throttled', throttled],
  ] as const)('backs off after %s and fails fast while backing off', async (_name, body) => {
    const { client, sent, time } = setup((_request, index) => (index === 0 ? json(body) : ok({ fine: true })));

    await expect(client.call('Balance')).rejects.toMatchObject({ kind: 'ratelimit', retryAfterMs: 30_000 });
    expect(sent).toHaveLength(1);

    // Inside the 30 s window nothing is sent and nothing sleeps in the queue.
    time.now += 10_000;
    await expect(client.call('Balance')).rejects.toMatchObject({ kind: 'ratelimit', retryAfterMs: 20_000 });
    expect(sent).toHaveLength(1);

    time.now += 20_000;
    await expect(client.call('Balance')).resolves.toEqual({ fine: true });
    expect(sent).toHaveLength(2);
  });

  it('doubles the back-off on consecutive rate-limit errors up to 5 minutes, and resets after a success', async () => {
    let limited = true;
    const { client, time } = setup(() => (limited ? json(rateLimit) : ok({})));
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      const error = (await client.call('Balance').catch((e: unknown) => e)) as KrakenError;
      seen.push(error.retryAfterMs!);
      time.now += error.retryAfterMs!;
    }
    expect(seen).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);

    limited = false;
    await expect(client.call('Balance')).resolves.toEqual({});
    limited = true;
    const again = (await client.call('Balance').catch((e: unknown) => e)) as KrakenError;
    expect(again.retryAfterMs).toBe(30_000);
  });

  it('treats HTTP 429 like a rate-limit error', async () => {
    const { client } = setup(() => new Response('', { status: 429 }));
    await expect(client.call('Balance')).rejects.toMatchObject({ kind: 'ratelimit', retryAfterMs: 30_000 });
  });
});

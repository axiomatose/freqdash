import { describe, expect, it, vi } from 'vitest';
import timeFixture from '../../../test/fixtures/raw/kraken/public/Time.json';
import ohlcFixture from '../../../test/fixtures/raw/kraken/public/OHLC.ETHUSD.240.json';
import { KrakenPublicClient } from './public';
import type { KrakenFetch } from './types';

function setup(respond: () => Response | Promise<Response>, baseUrl = 'https://api.kraken.com') {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<KrakenFetch>[0], init?: Parameters<KrakenFetch>[1]) => {
    calls.push({ url: String(input), init });
    return respond();
  });
  const client = new KrakenPublicClient({ baseUrl, fetchImpl: fetchImpl as unknown as KrakenFetch });
  return { client, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('KrakenPublicClient', () => {
  it('issues plain GETs to /0/public/<Method> with no credentials or body', async () => {
    const { client, calls } = setup(() => json(timeFixture));
    await expect(client.time()).resolves.toEqual(timeFixture.result);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.kraken.com/0/public/Time');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    const headers = Object.keys(init?.headers ?? {}).map((name) => name.toLowerCase());
    expect(headers).not.toContain('api-key');
    expect(headers).not.toContain('api-sign');
  });

  it('builds the query strings for each method', async () => {
    const { client, calls } = setup(() => json({ error: [], result: {} }));
    await client.assets();
    await client.assetPairs();
    await client.ticker(['XBTUSD', 'ETHUSD']);
    await client.ohlc('XBTUSD', 240);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.kraken.com/0/public/Assets',
      'https://api.kraken.com/0/public/AssetPairs',
      'https://api.kraken.com/0/public/Ticker?pair=XBTUSD%2CETHUSD',
      'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=240',
    ]);
    expect(new URL(calls[2]!.url).searchParams.get('pair')).toBe('XBTUSD,ETHUSD');
  });

  it('joins a dev base URL with a path prefix by concatenation', async () => {
    const { client, calls } = setup(() => json(timeFixture), 'http://localhost:9999/kraken/');
    await client.time();
    expect(calls[0]!.url).toBe('http://localhost:9999/kraken/0/public/Time');
  });

  it('returns the raw result, including the OHLC "last" field', async () => {
    const { client } = setup(() => json(ohlcFixture));
    const result = (await client.ohlc('ETHUSD', 240)) as Record<string, unknown>;
    expect(result.last).toBe(ohlcFixture.result.last);
  });

  it('classifies Kraken errors, gateway statuses and transport failures', async () => {
    await expect(setup(() => json({ error: ['EService:Unavailable'] })).client.time()).rejects.toMatchObject({
      kind: 'unavailable',
      endpoint: 'Time',
    });
    await expect(setup(() => json({ error: ['EGeneral:Invalid arguments'] })).client.time()).rejects.toMatchObject({
      kind: 'api',
    });
    await expect(setup(() => new Response('bad gateway', { status: 502 })).client.time()).rejects.toMatchObject({
      kind: 'unavailable',
    });
    await expect(setup(() => new Response('{}', { status: 200 })).client.time()).rejects.toMatchObject({
      kind: 'parse',
    });
    await expect(
      setup(() => {
        throw new TypeError('fetch failed');
      }).client.time(),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('requires an http(s) base URL', () => {
    expect(() => new KrakenPublicClient({ baseUrl: 'api.kraken.com' })).toThrow();
  });
});

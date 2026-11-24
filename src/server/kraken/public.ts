import 'server-only';
import { describeError } from '../log';
import { KrakenError, parseKrakenEnvelope } from './errors';
import { type KrakenFetch, type KrakenPublicMethod } from './types';

export interface KrakenPublicClientOptions {
  /** `https://api.kraken.com`, or `http://localhost:9999/kraken` in dev. Joined by string concatenation. */
  baseUrl: string;
  fetchImpl?: KrakenFetch;
  timeoutMs?: number;
}

export const DEFAULT_PUBLIC_TIMEOUT_MS = 10_000;

/**
 * Unauthenticated market-data client: plain GETs, no key, no nonce. Every method resolves with Kraken's raw `result`
 * (feed it to the normalizers) or rejects with a `KrakenError`.
 */
export class KrakenPublicClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: KrakenFetch;
  private readonly timeoutMs: number;

  constructor(options: KrakenPublicClientOptions) {
    if (!/^https?:\/\//i.test(options.baseUrl)) throw new Error('Kraken base URL must start with http:// or https://');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PUBLIC_TIMEOUT_MS;
  }

  time(): Promise<unknown> {
    return this.get('Time');
  }

  /** All assets (no filter): the catalog needs every code, including the `.F`/`.S` variants. */
  assets(): Promise<unknown> {
    return this.get('Assets');
  }

  assetPairs(): Promise<unknown> {
    return this.get('AssetPairs');
  }

  ticker(pairs: readonly string[]): Promise<unknown> {
    return this.get('Ticker', { pair: pairs.join(',') });
  }

  /** `intervalMin` is Kraken's interval in minutes: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600. */
  ohlc(pair: string, intervalMin: number): Promise<unknown> {
    return this.get('OHLC', { pair, interval: String(intervalMin) });
  }

  private async get(method: KrakenPublicMethod, query: Record<string, string> = {}): Promise<unknown> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.baseUrl}/0/public/${method}${search === '' ? '' : `?${search}`}`;
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new KrakenError('network', `${method}: request failed (${describeError(error)})`, { endpoint: method });
    }

    return parseKrakenEnvelope(method, response.status, text);
  }
}

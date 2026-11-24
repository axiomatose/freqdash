import 'server-only';
import { describeError, registerSecrets } from '../log';
import { KrakenError, parseKrakenEnvelope } from './errors';
import type { NonceSource } from './nonce';
import { krakenCost, type KrakenRateLimiter } from './ratelimit';
import { signRequest } from './sign';
import {
  KRAKEN_PRIVATE_METHODS,
  type KrakenCaller,
  type KrakenFetch,
  type KrakenParams,
  type KrakenPrivateMethod,
} from './types';

export interface KrakenPrivateClientOptions {
  apiKey: string;
  /** Base64 secret as shown by Kraken. */
  apiSecret: string;
  /** `https://api.kraken.com`, or `http://localhost:9999/kraken` in dev. Joined by string concatenation. */
  baseUrl: string;
  nonce: NonceSource;
  limiter: KrakenRateLimiter;
  fetchImpl?: KrakenFetch;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

const ALLOWED: ReadonlySet<string> = new Set(KRAKEN_PRIVATE_METHODS);

export function isAllowedPrivateMethod(method: unknown): method is KrakenPrivateMethod {
  return typeof method === 'string' && ALLOWED.has(method);
}

/** `nonce=<n>&<params>` as `application/x-www-form-urlencoded`. The very string that gets signed and sent. */
function encodeBody(nonce: number, params: KrakenParams): string {
  const search = new URLSearchParams();
  search.append('nonce', String(nonce));
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(name, Array.isArray(value) ? value.join(',') : String(value));
  }
  return search.toString();
}

/**
 * Hand-rolled, read-only client for Kraken's private REST API.
 *
 *  - Endpoint allowlist: `Balance, BalanceEx, OpenOrders, ClosedOrders, QueryOrders, TradeVolume, Ledgers`. Enforced by
 *    the parameter type and again at runtime; anything else is rejected before the queue, the limiter, the nonce or
 *    the network are touched.
 *  - One serial queue: a call starts only after the previous one finished, so nonces reach Kraken in order.
 *  - Errors are `KrakenError`s whose messages never contain the key, secret or signature.
 */
export class KrakenPrivateClient implements KrakenCaller {
  readonly #apiKey: string;
  readonly #apiSecret: string;
  private readonly baseUrl: string;
  private readonly nonce: NonceSource;
  private readonly limiter: KrakenRateLimiter;
  private readonly fetchImpl: KrakenFetch;
  private readonly timeoutMs: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: KrakenPrivateClientOptions) {
    if (!options.apiKey || !options.apiSecret) throw new Error('Kraken API key and secret are required');
    if (!/^https?:\/\//i.test(options.baseUrl)) throw new Error('Kraken base URL must start with http:// or https://');
    this.#apiKey = options.apiKey;
    this.#apiSecret = options.apiSecret;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.nonce = options.nonce;
    this.limiter = options.limiter;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Belt and braces: any error text that ever contains these gets masked by redactSecrets().
    registerSecrets([options.apiKey, options.apiSecret]);
  }

  /** Calls an allowlisted private method and resolves with Kraken's `result`. Rejects with a `KrakenError`. */
  call(method: KrakenPrivateMethod, params: KrakenParams = {}): Promise<unknown> {
    if (!isAllowedPrivateMethod(method)) {
      return Promise.reject(
        new KrakenError('forbidden', `Kraken method not allowed: ${String(method).slice(0, 40)}`, {
          endpoint: null,
        }),
      );
    }
    if (Object.hasOwn(params, 'nonce')) {
      return Promise.reject(new TypeError('the nonce is managed by the client and cannot be passed as a parameter'));
    }
    const run = this.tail.then(() => this.execute(method, params));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execute(method: KrakenPrivateMethod, params: KrakenParams): Promise<unknown> {
    const path = `/0/private/${method}`;
    let nonceRetried = false;
    for (;;) {
      // Never sleep for minutes inside the serial queue: fail fast and let the caller's job back off.
      const backoff = this.limiter.backoffRemainingMs();
      if (backoff > 0) {
        throw new KrakenError('ratelimit', `${method}: backing off ${Math.ceil(backoff / 1000)}s after a rate limit`, {
          endpoint: method,
          retryAfterMs: backoff,
        });
      }
      await this.limiter.acquire(krakenCost(method));
      // Taken after the (possibly long) limiter wait so that nonce order equals send order.
      const nonce = this.nonce.next();
      const body = encodeBody(nonce, params);
      try {
        const result = await this.send(method, path, body, signRequest(path, body, nonce, this.#apiSecret));
        this.limiter.noteSuccess();
        return result;
      } catch (error) {
        if (!(error instanceof KrakenError)) throw error;
        if (error.kind === 'nonce' && !nonceRetried) {
          nonceRetried = true;
          this.nonce.bump();
          continue;
        }
        if (error.kind === 'ratelimit') {
          throw new KrakenError('ratelimit', error.message, {
            endpoint: method,
            krakenErrors: error.krakenErrors,
            status: error.status,
            retryAfterMs: this.limiter.penalize(),
          });
        }
        throw error;
      }
    }
  }

  private async send(method: KrakenPrivateMethod, path: string, body: string, signature: string): Promise<unknown> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          Accept: 'application/json',
          'API-Key': this.#apiKey,
          'API-Sign': signature,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new KrakenError('network', `${method}: request failed (${describeError(error)})`, { endpoint: method });
    }

    return parseKrakenEnvelope(method, response.status, text);
  }
}

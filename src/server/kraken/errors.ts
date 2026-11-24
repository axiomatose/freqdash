import 'server-only';
import { redactSecrets } from '../log';
import { isRecord } from './types';

/**
 * Error classes of docs/PLAN.md section 6.3, plus three adapter-level ones:
 *  - `api`: Kraken answered with an error we do not classify (bad arguments, unknown pair, ...);
 *  - `parse`: the response was not the JSON envelope we expect;
 *  - `forbidden`: a caller asked for a method outside the allowlist (a bug, never sent).
 */
export type KrakenErrorKind =
  'auth' | 'permission' | 'nonce' | 'ratelimit' | 'unavailable' | 'network' | 'api' | 'parse' | 'forbidden';

export interface KrakenErrorOptions {
  endpoint?: string | null;
  krakenErrors?: readonly string[];
  status?: number | null;
  /** For `ratelimit`: how long the caller should stay away, in ms. */
  retryAfterMs?: number | null;
}

export class KrakenError extends Error {
  readonly kind: KrakenErrorKind;
  readonly endpoint: string | null;
  /** Kraken's own error strings (`EAPI:Invalid key`, ...): safe to store, they never echo credentials. */
  readonly krakenErrors: readonly string[];
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(kind: KrakenErrorKind, message: string, options: KrakenErrorOptions = {}) {
    // Messages end up in logs, findings and the UI: mask secrets at the source.
    super(redactSecrets(message));
    this.name = 'KrakenError';
    this.kind = kind;
    this.endpoint = options.endpoint ?? null;
    this.krakenErrors = (options.krakenErrors ?? []).map(redactSecrets);
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isKrakenError(value: unknown): value is KrakenError {
  return value instanceof KrakenError;
}

/** Kraken error strings are `<severity><category>:<type>[:<extra>]`; severity `W` is a warning, `E` an error. */
export function isErrorEntry(entry: string): boolean {
  return !entry.startsWith('W');
}

const RULES: readonly (readonly [RegExp, KrakenErrorKind])[] = [
  [/^EAPI:Invalid (key|signature)/i, 'auth'],
  [/^EGeneral:Permission denied/i, 'permission'],
  [/^EAPI:Invalid nonce/i, 'nonce'],
  [/rate limit exceeded|^EService:Throttled|^EGeneral:Temporary lockout/i, 'ratelimit'],
  [/^EService:(Unavailable|Busy)|^EGeneral:Internal error/i, 'unavailable'],
];

/** Most actionable first: a bad key beats everything else when Kraken returns several errors. */
const PRIORITY: readonly KrakenErrorKind[] = ['auth', 'permission', 'nonce', 'ratelimit', 'unavailable'];

/** Classifies the `error` array of a Kraken response. Anything unrecognised is `api`. */
export function classifyKrakenError(errors: readonly string[] | string): KrakenErrorKind {
  const list = (typeof errors === 'string' ? [errors] : errors).filter(isErrorEntry);
  const found = new Set<KrakenErrorKind>();
  for (const entry of list) {
    for (const [pattern, kind] of RULES) {
      if (pattern.test(entry)) found.add(kind);
    }
  }
  return PRIORITY.find((kind) => found.has(kind)) ?? 'api';
}

/** Fallback for responses without a usable Kraken error body (proxies, Cloudflare, gateway errors). */
export function classifyHttpStatus(status: number): KrakenErrorKind {
  if (status === 429) return 'ratelimit';
  if (status >= 500) return 'unavailable';
  return 'network';
}

/** Kinds that mean "try again later": nothing is wrong with our configuration. */
export function isTransientKind(kind: KrakenErrorKind): boolean {
  return kind === 'ratelimit' || kind === 'unavailable' || kind === 'network' || kind === 'nonce';
}

/**
 * Turns an HTTP response body into Kraken's `result`, or throws the matching KrakenError. Kraken reports API errors
 * with HTTP 200 and an `error` array, so that array wins over the status; the status classifies proxy and gateway
 * failures that carry no Kraken body. Messages hold only Kraken's error strings and the status, never the body.
 */
export function parseKrakenEnvelope(endpoint: string, status: number, text: string): unknown {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const errors =
    isRecord(json) && Array.isArray(json.error) ? json.error.filter((e): e is string => typeof e === 'string') : [];
  if (errors.some(isErrorEntry)) {
    throw new KrakenError(classifyKrakenError(errors), `${endpoint}: ${errors.join('; ')}`, {
      endpoint,
      krakenErrors: errors,
      status,
    });
  }
  if (status < 200 || status >= 300) {
    throw new KrakenError(classifyHttpStatus(status), `${endpoint}: HTTP ${status}`, { endpoint, status });
  }
  if (!isRecord(json) || !('result' in json)) {
    throw new KrakenError('parse', `${endpoint}: response is not a Kraken result envelope`, { endpoint, status });
  }
  return json.result;
}

// Browser-side fetch wrapper for the same-origin /api/* routes.
// - decodes the `{ error, message, retryAfterSec }` error shape into ApiError,
// - sends `Content-Type: application/json` on every mutating request (the server answers 415 otherwise),
// - redirects to /login on 401, and to /change-password while the password is temporary,
// - keeps a small server-clock offset so "12 s ago" labels stay right on a phone whose clock is off.
import type { ApiErrorBody, ApiErrorCode } from '@/shared/types/api';
import type { Ms } from '@/shared/types/domain';

export type ApiErrorKind = ApiErrorCode | 'network' | 'bad_response';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly retryAfterSec: number | null;

  constructor(kind: ApiErrorKind, status: number, message: string, retryAfterSec: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

const KIND_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  429: 'rate_limited',
  503: 'unavailable',
};

const DEFAULT_MESSAGE: Record<ApiErrorKind, string> = {
  unauthorized: 'Your session has expired.',
  forbidden: 'This request was refused.',
  bad_request: 'The request was not valid.',
  not_found: 'Not found.',
  rate_limited: 'Too many requests.',
  unavailable: 'The service is temporarily unavailable.',
  internal: 'Something went wrong on the server.',
  password_change_required: 'Change your temporary password first.',
  network: 'Cannot reach the dashboard server.',
  bad_response: 'The server sent an unreadable response.',
};

/** Human-readable text for an error thrown by apiFetch (or any other error). */
export function describeError(e: unknown): string {
  if (isApiError(e)) {
    const retry = e.retryAfterSec !== null ? ` Try again in ${e.retryAfterSec} s.` : '';
    return `${e.message}${e.kind === 'rate_limited' ? retry : ''}`;
  }
  return e instanceof Error && e.message ? e.message : 'Unknown error.';
}

/** Indirection so tests can observe the login redirect without navigating. */
export const authRedirect = {
  go(url: string): void {
    window.location.assign(url);
  },
};

/** `/login?next=<current relative path>`; never a protocol-relative or absolute target. */
export function loginUrl(): string {
  if (typeof window === 'undefined') return '/login';
  const { pathname, search } = window.location;
  if (pathname === '/login') return '/login';
  const here = `${pathname}${search}`;
  if (here === '/' || !here.startsWith('/') || here.startsWith('//')) return '/login';
  return `/login?next=${encodeURIComponent(here)}`;
}

let redirecting = false;

/** Test hook: forget the learned clock skew and the one-shot redirect latch. */
export function resetApiState(): void {
  serverOffsetMs = 0;
  redirecting = false;
}

function redirectToLogin(): void {
  if (typeof window === 'undefined' || redirecting || window.location.pathname === '/login') return;
  redirecting = true;
  authRedirect.go(loginUrl());
}

function redirectToChangePassword(): void {
  if (typeof window === 'undefined' || redirecting || window.location.pathname === '/change-password') return;
  redirecting = true;
  authRedirect.go('/change-password');
}

// ---- server clock -----------------------------------------------------------------------------------------------

let serverOffsetMs = 0;
/** Offsets below this are network latency, not skew: ignore them to keep labels from jittering. */
const SKEW_IGNORE_MS = 3_000;

/** Current time on the server's clock (client clock + measured skew). */
export function serverNow(): Ms {
  return Date.now() + serverOffsetMs;
}

function learnServerClock(body: unknown): void {
  if (typeof body !== 'object' || body === null || !('generatedAt' in body)) return;
  const generatedAt = body.generatedAt;
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt)) return;
  const skew = generatedAt - Date.now();
  serverOffsetMs = Math.abs(skew) < SKEW_IGNORE_MS ? 0 : skew;
}

// ---- fetch ------------------------------------------------------------------------------------------------------

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON body. A POST without one sends `{}` so strict JSON parsers on the server never see an empty body. */
  body?: unknown;
  signal?: AbortSignal;
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError';
}

async function readErrorBody(res: Response): Promise<Partial<ApiErrorBody>> {
  try {
    const data: unknown = await res.json();
    return typeof data === 'object' && data !== null ? (data as Partial<ApiErrorBody>) : {};
  } catch {
    return {};
  }
}

export async function apiFetch<T>(path: string, req: ApiRequest = {}): Promise<T> {
  const method = req.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (req.body !== undefined) body = JSON.stringify(req.body);
    else if (method === 'POST') body = '{}';
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body,
      signal: req.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError('network', 0, DEFAULT_MESSAGE.network);
  }

  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError('unauthorized', 401, DEFAULT_MESSAGE.unauthorized);
  }

  if (!res.ok) {
    const err = await readErrorBody(res);
    const kind: ApiErrorKind = err.error ?? KIND_BY_STATUS[res.status] ?? 'internal';
    if (kind === 'password_change_required') redirectToChangePassword();
    const header = Number(res.headers.get('Retry-After'));
    const retry =
      typeof err.retryAfterSec === 'number' ? err.retryAfterSec : Number.isFinite(header) && header > 0 ? header : null;
    throw new ApiError(kind, res.status, err.message || DEFAULT_MESSAGE[kind], retry);
  }

  if (res.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('bad_response', res.status, DEFAULT_MESSAGE.bad_response);
  }
  learnServerClock(data);
  return data as T;
}

/** `?a=1&b=x`, skipping undefined, null and empty values. Returns '' when nothing is set. */
export function toSearch(params: object): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    usp.set(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

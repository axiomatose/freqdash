import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import type { ApiErrorBody, ApiErrorCode } from '@/shared/types/api';
import type { Ms } from '@/shared/types/domain';
import { getConfig, type AppConfig } from '../config';
import { describeError, log } from '../log';
import { agentSession } from './agent';
import { evaluateOrigin, isJsonContentType, sanitizeNext } from './origin';
import { clientIp } from './ratelimit';
import {
  clearedSessionCookie,
  isSecureRequest,
  isWellFormedToken,
  sessionCookie,
  sessionTokensFromCookieHeader,
} from './session';

// The database-free half of authentication: CSRF checks, security headers, cookies and the proxy gate. The proxy imports
// this module only, so it never pulls the SQLite driver into its bundle. Route handlers use guard.ts, which re-exports
// all of this and adds the session lookup (`withAuth`); pages behind the login check the session in (app)/layout.tsx.
//
// Defense in depth (docs/PLAN.md section 3): the proxy gates requests early, but every route handler must ALSO be
// wrapped in `withAuth`, so a proxy bypass (see CVE-2025-29927) does not expose data.

const authLog = log.child('auth');

export type AuthConfig = AppConfig['auth'];

/** Auth settings from the process configuration. Throws ConfigError (variable names only) when it is invalid. */
export function authConfig(): AuthConfig {
  return getConfig().auth;
}

// ---- error responses -------------------------------------------------------------------------------------------

/** JSON error in the shape every API route uses: `{ error, message?, retryAfterSec? }`, never cached. */
export function apiError(
  status: number,
  error: ApiErrorCode,
  message?: string,
  extra: { retryAfterSec?: number; headers?: Record<string, string> } = {},
): Response {
  const body: ApiErrorBody = { error };
  if (message !== undefined) body.message = message;
  if (extra.retryAfterSec !== undefined) body.retryAfterSec = extra.retryAfterSec;
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra.headers } });
}

/** Thrown by the assert/require helpers; `withAuth` turns it into its `response`. */
export class GuardError extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super(`request rejected (${response.status})`);
    this.name = 'GuardError';
    this.response = response;
  }
}

/** `Set-Cookie` value that installs a session token on this request (Secure flag decided per COOKIE_SECURE). */
export function issueSessionCookie(req: Request, token: string, maxAgeMs: number): string {
  return sessionCookie(token, maxAgeMs, isSecureRequest(req.headers, req.url, authConfig().cookieSecure));
}

/** `Set-Cookie` value that logs out. */
export function clearSessionCookie(req: Request): string {
  return clearedSessionCookie(isSecureRequest(req.headers, req.url, authConfig().cookieSecure));
}

/** Address used for rate limiting (cf-connecting-ip only under TRUST_PROXY=cloudflare). */
export function getClientIp(req: Request): string {
  return clientIp(req.headers, authConfig().trustProxy);
}

// ---- CSRF ------------------------------------------------------------------------------------------------------

/** 415 unless the request declares `Content-Type: application/json` (this also forces a CORS preflight cross-origin). */
export function assertJsonContentType(req: Request): void {
  if (!isJsonContentType(req.headers.get('content-type'))) {
    throw new GuardError(apiError(415, 'bad_request', 'Content-Type must be application/json'));
  }
}

/** 403 unless the request is same-origin (see evaluateOrigin). */
export function assertSameOrigin(req: Request): void {
  const verdict = evaluateOrigin(req.headers, authConfig().appOrigins);
  if (!verdict.ok) {
    authLog.warn('cross-origin request rejected', { reason: verdict.reason, method: req.method });
    throw new GuardError(apiError(403, 'forbidden', 'Cross-origin request rejected'));
  }
}

/** The full mutating-request check: JSON content type (415), then same origin (403). */
export function assertMutating(req: Request): void {
  assertJsonContentType(req);
  assertSameOrigin(req);
}

// ---- security headers ------------------------------------------------------------------------------------------

/** Content-Security-Policy from docs/PLAN.md section 3; `'unsafe-eval'` is added for development only. */
export function buildCsp(development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Sets the security headers on `headers`; API responses additionally get `Cache-Control: no-store`. */
export function applySecurityHeaders(headers: Headers, options: { api: boolean }): void {
  headers.set('Content-Security-Policy', buildCsp(process.env.NODE_ENV !== 'production'));
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (options.api) headers.set('Cache-Control', 'no-store');
}

/** Stamps the API security headers (incl. no-store) on a finished Response, copying it when its headers are immutable. */
export function withApiHeaders(res: Response): Response {
  try {
    applySecurityHeaders(res.headers, { api: true });
    return res;
  } catch {
    const headers = new Headers(res.headers);
    applySecurityHeaders(headers, { api: true });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

// ---- proxy gate ------------------------------------------------------------------------------------------------

/** Request header the proxy sets on page requests: the path and query the browser asked for. */
export const PATH_HEADER = 'x-freqdash-path';

const PUBLIC_EXACT = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/captcha',
  '/api/health',
  '/manifest.webmanifest',
  // The Web Push service worker must be fetchable by the browser at any time (it re-checks it for updates).
  '/sw.js',
]);
const PUBLIC_PREFIXES = ['/_next/static/', '/icons/'];

function hasUnsafeSegments(pathname: string): boolean {
  if (pathname.includes('\\') || pathname.includes('//')) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded.includes('\\') || decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

/** The only paths reachable without a session (docs/PLAN.md section 3). Prefix matches refuse traversal tricks. */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) && !hasUnsafeSegments(pathname);
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

const HOST_RE = /^[a-z0-9.:[\]-]+$/i;

/**
 * Origin the browser used: APP_PUBLIC_URL when configured, else the forwarded (or Host) header, else the request URL.
 * The Location header must be absolute (Next.js rejects a relative one from the proxy in production), and behind a
 * tunnel or with HOSTNAME=0.0.0.0 `req.nextUrl.origin` is the internal address, not the public one.
 */
function publicOrigin(req: NextRequest, auth: AuthConfig): string {
  if (auth.appPublicUrl !== null) return auth.appPublicUrl;
  const first = (v: string | null): string => (v ?? '').split(',')[0]?.trim() ?? '';
  const host = first(req.headers.get('x-forwarded-host')) || first(req.headers.get('host'));
  if (host === '' || !HOST_RE.test(host)) return req.nextUrl.origin;
  const proto = first(req.headers.get('x-forwarded-proto')).toLowerCase();
  return `${proto === 'https' || proto === 'http' ? proto : req.nextUrl.protocol.replace(':', '')}://${host}`;
}

/** 307 to `page` (the login or change-password page), carrying the current path as `next`. */
function redirectWithNext(
  req: NextRequest,
  auth: AuthConfig,
  page: string,
  pathname: string,
  search: string,
): NextResponse {
  const params = new URLSearchParams(search);
  params.delete('_rsc');
  const query = params.toString();
  const target = sanitizeNext(`${pathname}${query ? `?${query}` : ''}`);
  const path = target === '/' ? page : `${page}?next=${encodeURIComponent(target)}`;
  return new NextResponse(null, {
    status: 307,
    headers: { Location: `${publicOrigin(req, auth)}${path}`, 'Cache-Control': 'no-store' },
  });
}

function unauthorizedJson(): NextResponse {
  const body: ApiErrorBody = { error: 'unauthorized' };
  return NextResponse.json(body, { status: 401, headers: { 'Cache-Control': 'no-store' } });
}

function decide(req: NextRequest, now: Ms): NextResponse {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  let auth: AuthConfig;
  try {
    auth = authConfig();
  } catch (err) {
    authLog.error('authentication is not configured', { error: describeError(err) });
    const body: ApiErrorBody = { error: 'internal' };
    return NextResponse.json(body, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }

  // Only the shape of the cookie can be checked here; whether the session is live is decided with the database by
  // withAuth (API) and (app)/layout.tsx (pages).
  const hasToken = sessionTokensFromCookieHeader(req.headers.get('cookie')).some(isWellFormedToken);
  if (!hasToken && agentSession(req, pathname, auth.agentToken, now) !== null) return NextResponse.next();
  const isPageRead = !isApiPath(pathname) && (req.method === 'GET' || req.method === 'HEAD');
  if (!hasToken) {
    return isPageRead ? redirectWithNext(req, auth, '/login', pathname, search) : unauthorizedJson();
  }
  if (!isPageRead) return NextResponse.next();
  // Pages learn their own path from this header, for the `next` of a redirect to the login or change-password page.
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

/**
 * The proxy decision: public paths pass; without a session cookie pages redirect to `/login?next=<relative path>`
 * (307) and everything else (`/api/*`, non-GET) gets 401 JSON; with one the request passes (pages carry their path in
 * PATH_HEADER). The proxy cannot see the database, so an expired or signed-out token passes here and is refused by
 * `withAuth` or the app layout. Security headers are stamped on every result.
 */
export function gateRequest(req: NextRequest, now: Ms = Date.now()): NextResponse {
  const res = decide(req, now);
  applySecurityHeaders(res.headers, { api: isApiPath(req.nextUrl.pathname) });
  return res;
}

import 'server-only';

// Pure request-shape checks shared by the guard and the login page: CSRF origin evaluation, JSON content type, and
// the post-login redirect target. No I/O and no configuration access, so they are trivially testable.

/** `application/json` with optional parameters (`; charset=utf-8`), case-insensitive. Nothing else qualifies. */
export function isJsonContentType(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^application\/json\s*(;.*)?$/i.test(value.trim());
}

export type OriginVerdict =
  { ok: true } | { ok: false; reason: 'cross-site-fetch' | 'missing-origin' | 'untrusted-origin' };

function firstListValue(value: string | null): string {
  return (value?.split(',')[0] ?? '').trim().toLowerCase();
}

/**
 * CSRF check for mutating requests (docs/PLAN.md section 3):
 *  * When the browser sent `Sec-Fetch-Site`, it is authoritative: only `same-origin` passes.
 *  * Otherwise (older browsers, scripts) an `Origin` header is required, and it must be one of `appOrigins` or match
 *    the host the request was addressed to (`X-Forwarded-Host`, else `Host`). When the tunnel reports the scheme
 *    (`X-Forwarded-Proto`) the origin's scheme must agree. A missing or `null` Origin fails closed.
 */
export function evaluateOrigin(headers: Headers, appOrigins: readonly string[]): OriginVerdict {
  const site = headers.get('sec-fetch-site');
  if (site !== null) {
    return site.trim().toLowerCase() === 'same-origin' ? { ok: true } : { ok: false, reason: 'cross-site-fetch' };
  }

  const originHeader = headers.get('origin');
  if (originHeader === null || originHeader.trim() === '') return { ok: false, reason: 'missing-origin' };
  let origin: URL;
  try {
    origin = new URL(originHeader.trim());
  } catch {
    return { ok: false, reason: 'untrusted-origin' };
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return { ok: false, reason: 'untrusted-origin' };
  if (appOrigins.includes(origin.origin)) return { ok: true };

  const hostHeader = firstListValue(headers.get('x-forwarded-host')) || firstListValue(headers.get('host'));
  if (hostHeader === '' || !/^[a-z0-9.:[\]-]+$/.test(hostHeader)) return { ok: false, reason: 'untrusted-origin' };
  const proto = firstListValue(headers.get('x-forwarded-proto'));
  if (proto !== '' && origin.protocol !== `${proto}:`) return { ok: false, reason: 'untrusted-origin' };
  let expectedHost: string;
  try {
    // Re-parsing with the origin's scheme drops a default port (":443" on https), like the Origin header does.
    expectedHost = new URL(`${origin.protocol}//${hostHeader}`).host;
  } catch {
    return { ok: false, reason: 'untrusted-origin' };
  }
  return origin.host === expectedHost ? { ok: true } : { ok: false, reason: 'untrusted-origin' };
}

const NEXT_BASE = 'http://freqdash.invalid';
const MAX_NEXT_LENGTH = 512;

/**
 * Post-login redirect target: a same-site relative path (with query) or '/'. Absolute URLs, protocol-relative
 * (`//host`), backslash and control-character tricks, and targets that make no sense after login (`/login`, `/api/*`,
 * `/_next/*`) all collapse to '/'.
 */
export function sanitizeNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_NEXT_LENGTH) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  // Browsers drop tabs/newlines and treat "\" as "/" inside URLs, so both can turn "/x" into "//host".
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return '/';

  let url: URL;
  try {
    url = new URL(raw, NEXT_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== NEXT_BASE) return '/';
  const path = url.pathname;
  if (path.startsWith('//')) return '/';
  if (/^\/(login|api|_next)(\/|$)/.test(path)) return '/';
  return `${path}${url.search}`;
}

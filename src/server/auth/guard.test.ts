import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AppConfig } from '@/server/config';
import { clearRegisteredSecrets } from '@/server/log';
import {
  applySecurityHeaders,
  apiError,
  assertJsonContentType,
  assertMutating,
  assertSameOrigin,
  buildCsp,
  clearSessionCookie,
  getClientIp,
  getSession,
  GuardError,
  isPublicPath,
  issueSessionCookie,
  requireSession,
  withAuth,
} from './guard';
import { getDb } from '@/server/db';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { SESSION_COOKIE } from './session';
import {
  activateSeededUsers,
  cookieHeader,
  DAY,
  JSON_SAME_ORIGIN,
  NOW,
  request,
  SEED_PASSWORD,
  testConfig,
  TEST_SECRET,
  tokenFor,
} from './test-support';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => state.cfg,
}));

function stdio() {
  const lines: string[] = [];
  const capture = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  return lines;
}

async function rejection(fn: () => unknown): Promise<GuardError> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GuardError);
    return err as GuardError;
  }
  throw new Error('expected a GuardError');
}

const authed = (init: Record<string, string> = {}) => ({ cookie: cookieHeader(tokenFor()), ...init });

let temp: TempDb;

beforeEach(() => {
  stdio();
  temp = installTempDb();
  activateSeededUsers();
  state.cfg = testConfig();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearRegisteredSecrets();
  temp.cleanup();
});

describe('requireSession / getSession', () => {
  it('throws 401 {error:"unauthorized"} without a cookie', async () => {
    const err = await rejection(() => requireSession(request('/api/v1/x')));
    expect(err.response.status).toBe(401);
    expect(await err.response.json()).toEqual({ error: 'unauthorized' });
    expect(err.response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects garbage, unknown, old-format and expired cookies', async () => {
    const token = tokenFor();
    const bad = [
      `${SESSION_COOKIE}=garbage`,
      `${SESSION_COOKIE}=${token.slice(0, -2)}xx`,
      `${SESSION_COOKIE}=eyJ2IjoyLCJ1aWQiOjF9.c2lnbmF0dXJl`, // a signed cookie from before server-side sessions
      cookieHeader(tokenFor({ createdAt: NOW - 31 * DAY })),
    ];
    for (const cookie of bad) {
      expect((await rejection(() => requireSession(request('/x', { headers: { cookie } })))).response.status).toBe(401);
      expect(getSession(request('/x', { headers: { cookie } }))).toBeNull();
    }
  });

  it('returns the session for a valid cookie, honoring an explicit clock', () => {
    const req = request('/x', { headers: authed() });
    expect(requireSession(req)).toEqual({
      sid: expect.any(Number),
      uid: 1,
      n: 'admin',
      pc: false,
      exp: NOW + 30 * DAY,
    });
    expect(getSession(req, NOW + 31 * DAY)).toBeNull();
  });

  it('uses the first live session when several cookies are sent', () => {
    const header = `${SESSION_COOKIE}=${'x'.repeat(43)}; ${cookieHeader(tokenFor({ uid: 2 }))}`;
    expect(getSession(request('/x', { headers: { cookie: header } }))).toMatchObject({ uid: 2, n: 'partner' });
  });

  it('takes the username and the temporary-password flag from the database', () => {
    getDb().prepare('UPDATE users SET must_change_password = 1 WHERE id = 1').run();
    expect(getSession(request('/x', { headers: authed() }))).toMatchObject({ uid: 1, n: 'admin', pc: true });
  });

  it('refuses a session that was ended, or whose user is disabled, and clears the cookie', async () => {
    const token = tokenFor();
    getDb().prepare('DELETE FROM sessions').run();
    const err = await rejection(() => requireSession(request('/x', { headers: { cookie: cookieHeader(token) } })));
    expect(err.response.status).toBe(401);
    expect(err.response.headers.get('Set-Cookie')).toMatch(/^fd_session=; Path=\/; Max-Age=0/);

    const partner = tokenFor({ uid: 2 });
    getDb().prepare('UPDATE users SET disabled = 1 WHERE id = 2').run();
    expect(getSession(request('/x', { headers: { cookie: cookieHeader(partner) } }))).toBeNull();
  });

  it('accepts the read-only agent token as a user-less session', () => {
    state.cfg = testConfig({ AGENT_API_TOKEN: 'agent-token-0123456789-0123456789-abcdef' });
    const req = request('/api/v1/summary', {
      headers: { authorization: 'Bearer agent-token-0123456789-0123456789-abcdef' },
    });
    expect(getSession(req)).toMatchObject({ sid: null, uid: null, n: 'agent' });
  });

  it('does not depend on SESSION_SECRET (rotating it signs nobody out)', () => {
    const req = request('/x', { headers: authed() });
    state.cfg = testConfig({ SESSION_SECRET: 'another-secret-value-0123456789-abcdefgh' });
    expect(getSession(req)).not.toBeNull();
  });
});

describe('cookie helpers', () => {
  it('issueSessionCookie installs the token and honors COOKIE_SECURE', () => {
    const token = 'x'.repeat(43);
    const plain = issueSessionCookie(request('/x'), token, 90 * DAY);
    expect(plain).toBe(`fd_session=${token}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax`);

    state.cfg = testConfig({ COOKIE_SECURE: 'true' });
    expect(issueSessionCookie(request('/x'), token, DAY)).toMatch(/; Secure$/);
    state.cfg = testConfig({ COOKIE_SECURE: 'auto' });
    expect(issueSessionCookie(request('/x', { headers: { 'x-forwarded-proto': 'https' } }), token, DAY)).toMatch(
      /; Secure$/,
    );
    expect(issueSessionCookie(request('/x', { headers: { 'x-forwarded-proto': 'http' } }), token, DAY)).not.toMatch(
      /Secure/,
    );
  });

  it('clearSessionCookie expires the cookie', () => {
    expect(clearSessionCookie(request('/x'))).toBe('fd_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  });

  it('getClientIp follows TRUST_PROXY', () => {
    const headers = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' };
    expect(getClientIp(request('/x', { headers }))).toBe('198.51.100.9');
    state.cfg = testConfig({ TRUST_PROXY: 'cloudflare' });
    expect(getClientIp(request('/x', { headers }))).toBe('203.0.113.7');
  });
});

describe('CSRF guards', () => {
  it('415 unless the content type is application/json', async () => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const err = await rejection(() =>
        assertJsonContentType(request('/x', { method: 'POST', headers: { 'content-type': contentType } })),
      );
      expect(err.response.status).toBe(415);
      expect(await err.response.json()).toMatchObject({ error: 'bad_request' });
    }
    expect((await rejection(() => assertJsonContentType(request('/x', { method: 'DELETE' })))).response.status).toBe(
      415,
    );
    expect(() =>
      assertJsonContentType(
        request('/x', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' } }),
      ),
    ).not.toThrow();
  });

  it('403 for cross-site fetches and for a missing or foreign Origin', async () => {
    const cases: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'http://evil.example', host: 'dash.test:8043' },
      { origin: 'null', host: 'dash.test:8043' },
      { host: 'dash.test:8043' },
      { 'sec-fetch-site': 'cross-site', origin: 'http://alt.test:8043' },
    ];
    for (const headers of cases) {
      const err = await rejection(() => assertSameOrigin(request('/x', { method: 'POST', headers })));
      expect(err.response.status).toBe(403);
      expect(await err.response.json()).toMatchObject({ error: 'forbidden' });
    }
  });

  it('allows same-origin fetches, an Origin equal to Host, and an APP_ORIGINS entry', () => {
    const ok: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin' },
      { origin: 'http://dash.test:8043', host: 'dash.test:8043' },
      {
        origin: 'https://dash.example',
        host: 'freqdash:3000',
        'x-forwarded-host': 'dash.example',
        'x-forwarded-proto': 'https',
      },
      { origin: 'http://alt.test:8043', host: 'freqdash:3000' },
    ];
    for (const headers of ok) expect(() => assertSameOrigin(request('/x', { method: 'POST', headers }))).not.toThrow();
  });

  it('assertMutating checks the content type before the origin', async () => {
    const both = request('/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' },
    });
    expect((await rejection(() => assertMutating(both))).response.status).toBe(415);
    const originOnly = request('/x', {
      method: 'POST',
      headers: { ...JSON_SAME_ORIGIN, 'sec-fetch-site': 'cross-site' },
    });
    expect((await rejection(() => assertMutating(originOnly))).response.status).toBe(403);
    expect(() => assertMutating(request('/x', { method: 'POST', headers: JSON_SAME_ORIGIN }))).not.toThrow();
  });
});

describe('security headers', () => {
  it('uses the CSP from the plan, with unsafe-eval only in development', () => {
    expect(buildCsp(false)).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    expect(buildCsp(true)).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval';");
  });

  it('sets every header, and no-store only for API responses', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const page = new Headers();
    applySecurityHeaders(page, { api: false });
    expect(page.get('Content-Security-Policy')).toBe(buildCsp(false));
    expect(page.get('X-Frame-Options')).toBe('DENY');
    expect(page.get('X-Content-Type-Options')).toBe('nosniff');
    expect(page.get('Referrer-Policy')).toBe('no-referrer');
    expect(page.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(page.get('Cache-Control')).toBeNull();

    const api = new Headers({ 'Cache-Control': 'public, max-age=60' });
    applySecurityHeaders(api, { api: true });
    expect(api.get('Cache-Control')).toBe('no-store');
    vi.unstubAllEnvs();
  });
});

describe('isPublicPath', () => {
  it.each([
    '/login',
    '/api/auth/login',
    '/api/health',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/apple-touch-icon.png',
    '/_next/static/chunks/main-abc123.js',
    '/_next/static/media/font.woff2',
    '/_next/static/chunks/app/bots/%5BbotId%5D/page-abc.js',
  ])('%s is public', (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/findings',
    '/bots/votemax',
    '/api/v1/summary',
    '/api/auth/session',
    '/api/auth/logout',
    '/api/health/extra',
    '/api/auth/login/x',
    '/login/',
    '/login/x',
    '/LOGIN',
    '/manifest.webmanifest/x',
    '/icons',
    '/_next/static',
    '/_next/image',
    '/_next/data/build/index.json',
    '/favicon.ico',
    '/icons/../api/v1/summary',
    '/icons/%2e%2e/api/v1/summary',
    '/icons/..%2fapi/v1/summary',
    '/icons/x%5c..%5capi',
    '/icons//api/v1/summary',
    '/_next/static/../../api/v1/summary',
    '/icons/%zz',
  ])('%s is protected', (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe('withAuth', () => {
  const ok = vi.fn((_req: NextRequest, _ctx: unknown) => Response.json({ ok: true }));
  const ctx = { params: Promise.resolve({}) };

  beforeEach(() => ok.mockClear());

  it('answers 401 without calling the handler, with security headers and no-store', async () => {
    const res = await withAuth(ok)(request('/api/v1/x'), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(ok).not.toHaveBeenCalled();
  });

  it('passes the session and params to the handler and stamps headers on the result', async () => {
    const wrapped = withAuth<{ id: string }>(async (_req, { session, params }) => {
      const { id } = await params;
      return Response.json({ id, name: session.n }, { headers: { 'Cache-Control': 'public, max-age=600' } });
    });
    const res = await wrapped(request('/api/v1/x/7', { headers: authed() }), { params: Promise.resolve({ id: '7' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '7', name: 'admin' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('tolerates a missing context (direct calls in tests)', async () => {
    const wrapped = withAuth(async (_req, { params }) => Response.json(await params));
    const res = await wrapped(request('/api/v1/x', { headers: authed() }), undefined as never);
    expect(await res.json()).toEqual({});
  });

  it('answers 403 password_change_required while the password is temporary, unless the route allows it', async () => {
    getDb().prepare('UPDATE users SET must_change_password = 1 WHERE id = 1').run();
    const res = await withAuth(ok)(request('/api/v1/x', { headers: authed() }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'password_change_required' });
    expect(ok).not.toHaveBeenCalled();
    const allowed = await withAuth(ok, { allowTemporaryPassword: true })(
      request('/api/v1/x', { headers: authed() }),
      ctx,
    );
    expect(allowed.status).toBe(200);
  });

  it('does not require JSON or same-origin for non-mutating routes', async () => {
    const res = await withAuth(ok)(request('/api/v1/x', { headers: authed({ 'sec-fetch-site': 'cross-site' }) }), ctx);
    expect(res.status).toBe(200);
  });

  describe('mutating routes', () => {
    const post = (headers: Record<string, string>) => request('/api/v1/x', { method: 'POST', headers });
    const wrapped = withAuth(ok, { mutating: true });

    it('401 before anything else when there is no session', async () => {
      expect((await wrapped(post(JSON_SAME_ORIGIN), ctx)).status).toBe(401);
    });

    it('415 for a non-JSON content type', async () => {
      const res = await wrapped(post(authed({ 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' })), ctx);
      expect(res.status).toBe(415);
      expect(ok).not.toHaveBeenCalled();
    });

    it('403 for a cross-site request, and for a missing Origin when Sec-Fetch-Site is absent', async () => {
      const cross = await wrapped(post(authed({ ...JSON_SAME_ORIGIN, 'sec-fetch-site': 'cross-site' })), ctx);
      expect(cross.status).toBe(403);
      expect(await cross.json()).toMatchObject({ error: 'forbidden' });
      const { 'sec-fetch-site': _omit, ...noFetchMeta } = JSON_SAME_ORIGIN;
      expect((await wrapped(post(authed(noFetchMeta)), ctx)).status).toBe(403);
      expect(ok).not.toHaveBeenCalled();
    });

    it('runs the handler for a same-origin JSON request', async () => {
      expect((await wrapped(post(authed(JSON_SAME_ORIGIN)), ctx)).status).toBe(200);
      const viaOrigin = { 'content-type': 'application/json', origin: 'http://dash.test:8043', host: 'dash.test:8043' };
      expect((await wrapped(post(authed(viaOrigin)), ctx)).status).toBe(200);
      expect(ok).toHaveBeenCalledTimes(2);
    });
  });

  it('turns a GuardError thrown inside the handler into its response', async () => {
    const wrapped = withAuth(() => {
      throw new GuardError(apiError(403, 'forbidden', 'nope'));
    });
    const res = await wrapped(request('/api/v1/x', { headers: authed() }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: 'nope' });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('turns unexpected exceptions into a generic 500 without leaking anything', async () => {
    const lines = stdio();
    const wrapped = withAuth(() => {
      throw new Error('database exploded at /srv/secret/path');
    });
    const res = await wrapped(request('/api/v1/x', { headers: authed() }), ctx);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal' });
    expect(text).not.toContain('exploded');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(lines.join('')).toContain('unhandled error in route handler');
  });

  it('lets Next.js control-flow errors (redirect, notFound) propagate instead of turning them into a 500', async () => {
    const redirectLike = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/x;307;' });
    const wrapped = withAuth(() => {
      throw redirectLike;
    });
    await expect(wrapped(request('/api/v1/x', { headers: authed() }), ctx)).rejects.toBe(redirectLike);
  });

  it('reports an unusable configuration as a generic 500', async () => {
    state.cfg = undefined as unknown as AppConfig;
    stdio();
    const res = await withAuth(ok)(request('/api/v1/x', { headers: authed() }), ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
  });

  it('copies responses whose headers are immutable', async () => {
    const wrapped = withAuth(() => Response.redirect('http://dash.test:8043/elsewhere', 302));
    const res = await wrapped(request('/api/v1/x', { headers: authed() }), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://dash.test:8043/elsewhere');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('never puts the password or session secret in logs or bodies', async () => {
    const lines = stdio();
    const bodies: string[] = [];
    const denied = await withAuth(ok, { mutating: true })(request('/api/v1/x', { method: 'POST' }), ctx);
    bodies.push(await denied.text());
    const failing = withAuth(() => {
      throw new Error('boom');
    });
    bodies.push(await (await failing(request('/api/v1/x', { headers: authed() }), ctx)).text());
    for (const text of [...lines, ...bodies]) {
      expect(text).not.toContain(SEED_PASSWORD);
      expect(text).not.toContain(TEST_SECRET);
    }
  });
});

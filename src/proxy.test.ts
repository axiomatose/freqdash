import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/server/config';
import { clearRegisteredSecrets } from '@/server/log';
import { buildCsp } from '@/server/auth/guard';
import { PATH_HEADER } from '@/server/auth/gate';
import { SESSION_COOKIE } from '@/server/auth/session';
import { cookieHeader, NOW, request, testConfig, wellFormedToken } from '@/server/auth/test-support';
import { config, proxy } from './proxy';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig, fail: false }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => {
    if (state.fail) throw new Error('SESSION_SECRET: is required');
    return state.cfg;
  },
}));

// The proxy only checks that a session cookie of the right shape is present; validity is checked with the database.
const session = (init: Record<string, string> = {}) => ({ cookie: cookieHeader(wellFormedToken()), ...init });
/** Path and query of the (absolute) Location header. */
const rel = (res: Response): string => {
  const u = new URL(res.headers.get('Location') ?? '');
  return u.pathname + u.search;
};
const passesThrough = (res: Response) => res.headers.get('x-middleware-next') === '1';

function expectSecurityHeaders(res: Response, api: boolean): void {
  expect(res.headers.get('Content-Security-Policy')).toBe(buildCsp(process.env.NODE_ENV !== 'production'));
  expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  if (api) expect(res.headers.get('Cache-Control')).toBe('no-store');
}

beforeEach(() => {
  state.cfg = testConfig();
  state.fail = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearRegisteredSecrets();
});

describe('unauthenticated page requests', () => {
  it('redirect with 307 to /login, carrying the relative path as next', () => {
    const res = proxy(request('/findings'));
    expect(res.status).toBe(307);
    expect(rel(res)).toBe('/login?next=%2Ffindings');
    expect(new URL(res.headers.get('Location') ?? '').origin).toBe('http://dash.test:8043');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expectSecurityHeaders(res, false);
  });

  it('build the Location from the forwarded host and proto, or APP_PUBLIC_URL', () => {
    const fwd = proxy(
      request('/findings', { headers: { 'x-forwarded-host': 'dash.example', 'x-forwarded-proto': 'https' } }),
    );
    expect(new URL(fwd.headers.get('Location') ?? '').origin).toBe('https://dash.example');
    state.cfg = testConfig({ APP_PUBLIC_URL: 'https://public.example' });
    expect(new URL(proxy(request('/findings')).headers.get('Location') ?? '').origin).toBe('https://public.example');
  });

  it('ignore a malformed Host header', () => {
    const res = proxy(request('/findings', { headers: { 'x-forwarded-host': 'evil.example/<x>' } }));
    expect(new URL(res.headers.get('Location') ?? '').pathname).toBe('/login');
  });

  it('omit next for the root page', () => {
    const res = proxy(request('/'));
    expect(res.status).toBe(307);
    expect(rel(res)).toBe('/login');
  });

  it('keep the query string but drop the internal _rsc parameter', () => {
    const res = proxy(request('/chart?bot=votemax&pair=ETH%2FUSD&_rsc=abc123'));
    expect(rel(res)).toBe(`/login?next=${encodeURIComponent('/chart?bot=votemax&pair=ETH%2FUSD')}`);
  });

  it('never produce an absolute or protocol-relative next', () => {
    for (const path of ['//evil.example/x', '///evil.example', '/%5Cevil.example']) {
      const location = rel(proxy(request(path)));
      expect(location.startsWith('/login')).toBe(true);
      const next = new URL(location, 'http://x.invalid').searchParams.get('next');
      expect(next === null || (next.startsWith('/') && !next.startsWith('//'))).toBe(true);
    }
    expect(rel(proxy(request('//evil.example/x')))).toBe('/login');
  });

  it('redirect HEAD requests but answer other methods with 401 JSON (a redirect would replay the body)', async () => {
    expect(proxy(request('/findings', { method: 'HEAD' })).status).toBe(307);
    const res = proxy(request('/findings', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('treat malformed and old-format cookies as no session', () => {
    const cookies = [
      `${SESSION_COOKIE}=nonsense`,
      `${SESSION_COOKIE}=${'x'.repeat(42)}`,
      `${SESSION_COOKIE}=eyJ2IjoyLCJ1aWQiOjF9.c2lnbmF0dXJl`, // a signed cookie from before server-side sessions
      `other=${'x'.repeat(43)}`,
    ];
    for (const cookie of cookies) expect(proxy(request('/', { headers: { cookie } })).status).toBe(307);
  });
});

describe('unauthenticated API requests', () => {
  it.each([
    ['GET', '/api/v1/summary'],
    ['GET', '/api/v1/bots/votemax'],
    ['POST', '/api/v1/acks'],
    ['DELETE', '/api/v1/acks/3'],
    ['GET', '/api/auth/session'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/unknown'],
  ])('%s %s -> 401 JSON', async (method, path) => {
    const res = proxy(request(path, { method }));
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expectSecurityHeaders(res, true);
  });

  it('resolve dot segments before deciding, so traversal cannot reach a protected route through a public prefix', async () => {
    for (const path of ['/icons/../api/v1/summary', '/icons/%2e%2e/api/v1/summary', '/icons/..%2fapi/v1/summary']) {
      const res = proxy(request(path));
      expect(passesThrough(res)).toBe(false);
      expect([307, 401]).toContain(res.status);
    }
  });
});

describe('public paths', () => {
  it.each([
    ['GET', '/login'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/health'],
    ['GET', '/manifest.webmanifest'],
    ['GET', '/sw.js'],
    ['GET', '/api/auth/captcha'],
    ['GET', '/icons/icon-192.png'],
    ['GET', '/_next/static/chunks/main.js'],
  ])('%s %s passes without a session and gets the security headers', (method, path) => {
    const res = proxy(request(path, { method }));
    expect(passesThrough(res)).toBe(true);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expectSecurityHeaders(res, path.startsWith('/api/'));
  });

  it('do not need a usable configuration', () => {
    state.fail = true;
    expect(passesThrough(proxy(request('/login')))).toBe(true);
    expect(passesThrough(proxy(request('/api/health')))).toBe(true);
  });
});

describe('requests with a session cookie', () => {
  it('pass through with the security headers and never set a cookie (sessions slide on the server)', () => {
    for (const path of ['/', '/api/v1/summary', '/bots/votemax', '/change-password']) {
      const res = proxy(request(path, { headers: session() }));
      expect(passesThrough(res)).toBe(true);
      expect(res.headers.getSetCookie()).toEqual([]);
      expectSecurityHeaders(res, path.startsWith('/api/'));
    }
  });

  it('hand pages their path (for the redirect `next` in the app layout), overwriting a forged value', () => {
    const res = proxy(request('/bots/votemax?tab=trades', { headers: session({ [PATH_HEADER]: '//evil.example' }) }));
    expect(res.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBe('/bots/votemax?tab=trades');
    const api = proxy(request('/api/v1/summary', { headers: session() }));
    expect(api.headers.get(`x-middleware-request-${PATH_HEADER}`)).toBeNull();
  });
});

describe('failure handling', () => {
  it('fails closed with a generic 500 when the configuration is unusable, without echoing the reason', async () => {
    state.fail = true;
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const res = proxy(request('/api/v1/summary', { headers: session() }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(passesThrough(res)).toBe(false);
    expectSecurityHeaders(res, true);
    expect(written.join('')).toContain('authentication is not configured');
  });
});

describe('matcher', () => {
  const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it('covers pages and API routes', () => {
    for (const url of [
      '/',
      '/login',
      '/findings',
      '/bots/votemax',
      '/chart?bot=a',
      '/api/health',
      '/api/v1/summary',
      '/api/auth/login',
    ]) {
      expect(runs(url)).toBe(true);
    }
  });

  it('covers public assets (they are allowlisted inside the proxy), including page-like paths that end in an extension', () => {
    for (const url of ['/manifest.webmanifest', '/icons/icon-192.png', '/bots/x.png', '/favicon.ico']) {
      expect(runs(url)).toBe(true);
    }
  });

  it('skips the build static files and optimized images', () => {
    for (const url of [
      '/_next/static/chunks/main.js',
      '/_next/static/css/app.css',
      '/_next/image?url=%2Fa.png&w=64&q=75',
    ]) {
      expect(runs(url)).toBe(false);
    }
  });
});

describe('agent bearer token', () => {
  const AGENT = 'agent-token-0123456789-abcdefghijklmnopqrstuvwxyz';
  const bearer = { authorization: `Bearer ${AGENT}` };
  beforeEach(() => {
    state.cfg = testConfig({ AGENT_API_TOKEN: AGENT });
  });

  it('lets a valid token read /api/v1/* with GET', () => {
    expect(passesThrough(proxy(request('/api/v1/summary', { headers: bearer })))).toBe(true);
  });
  it('rejects a wrong token, and the token on mutating methods, auth routes and pages', () => {
    const wrong = proxy(request('/api/v1/summary', { headers: { authorization: 'Bearer nope' } }));
    expect(wrong.status).toBe(401);
    expect(proxy(request('/api/v1/acks', { method: 'POST', headers: bearer })).status).toBe(401);
    expect(proxy(request('/api/auth/session', { headers: bearer })).status).toBe(401);
    expect(proxy(request('/status', { headers: bearer })).status).toBe(307);
  });
  it('is disabled when AGENT_API_TOKEN is not set', () => {
    state.cfg = testConfig();
    expect(proxy(request('/api/v1/summary', { headers: bearer })).status).toBe(401);
  });
});

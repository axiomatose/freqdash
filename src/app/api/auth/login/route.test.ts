import { scryptSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/server/config';
import { getDb, getUserById } from '@/server/db';
import { installTempDb, type TempDb } from '@/server/db/testing';
import { clearRegisteredSecrets } from '@/server/log';
import { CaptchaService, setCaptchaServiceForTests } from '@/server/auth/captcha';
import { configureLoginRuntimeForTests, LOGIN_FAILURE_DELAY_MS, LoginRateLimiter } from '@/server/auth/ratelimit';
import { sessionFromCookieHeader } from '@/server/auth/guard';
import { hashSessionToken } from '@/server/auth/session';
import {
  DAY,
  JSON_SAME_ORIGIN,
  NOW,
  request,
  SEED_PASSWORD,
  testConfig,
  TEST_SECRET,
} from '@/server/auth/test-support';
import { POST } from './route';

const state = vi.hoisted(() => ({ cfg: undefined as unknown as AppConfig, fail: false }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: () => {
    if (state.fail) throw new Error('SESSION_SECRET: is required');
    return state.cfg;
  },
}));

const WRONG = 'definitely-the-wrong-password-42';
const CAPTCHA_TEXT = 'ACD34';
const GOOD = { username: 'admin', password: SEED_PASSWORD };
const clock = { now: NOW };
const sleep = vi.fn((_ms: number) => Promise.resolve());
let output: string[];
let temp: TempDb;
let captcha: CaptchaService;

function login(
  body: unknown,
  headers: Record<string, string> = {},
  { raw = false }: { raw?: boolean } = {},
): Promise<Response> {
  return POST(
    request('/api/auth/login', {
      method: 'POST',
      headers: { ...JSON_SAME_ORIGIN, ...headers },
      body: raw ? String(body) : JSON.stringify(body),
    }),
  );
}

/** A solved captcha for the next request (ignored by the server while none is required). */
const solved = () => ({ captchaId: captcha.issue().id, captchaAnswer: CAPTCHA_TEXT.toLowerCase() });
/** A wrong password that gets past the captcha, so it counts against the rate limiter. */
const guess = (headers: Record<string, string> = {}, username = 'admin') =>
  login({ username, password: WRONG, ...solved() }, headers);

const fromIp = (ip: string) => ({ 'x-forwarded-for': ip });

/** The seed password hashed at the lowest accepted cost (2^10), so dozens of logins per test stay fast. */
function cheapSeedHash(): string {
  const salt = Buffer.alloc(16, 3);
  const key = scryptSync(SEED_PASSWORD, salt, 32, { N: 1024, r: 8, p: 1 });
  return `scrypt$10$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
const tokenOf = (res: Response) => /fd_session=([^;]+)/.exec(res.headers.getSetCookie()[0]!)![1]!;
const sessionOf = (res: Response) => sessionFromCookieHeader(`fd_session=${tokenOf(res)}`, NOW);

beforeEach(() => {
  state.cfg = testConfig();
  state.fail = false;
  temp = installTempDb();
  getDb().prepare('UPDATE users SET password_hash = ?').run(cheapSeedHash());
  clock.now = NOW;
  sleep.mockReset();
  configureLoginRuntimeForTests({ limiter: new LoginRateLimiter({ now: () => clock.now }), sleep });
  captcha = new CaptchaService({ now: () => clock.now, text: () => CAPTCHA_TEXT });
  setCaptchaServiceForTests(captcha);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  output = [];
  const capture = (chunk: unknown): boolean => {
    output.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  configureLoginRuntimeForTests(null);
  setCaptchaServiceForTests(null);
  clearRegisteredSecrets();
  temp.cleanup();
});

describe('POST /api/auth/login: success', () => {
  it('answers 200 with the temporary-password flag and a session cookie with the required flags', async () => {
    const res = await login(GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mustChangePassword: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    // The cookie lives until the session's absolute end (90 days); the idle timeout is enforced on the server.
    expect(cookies[0]).toMatch(/^fd_session=[\w-]{43}; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Lax$/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('starts a server-side session for the user (idle end = now + 30 d), storing only the token hash', async () => {
    const res = await login(
      { username: '  PARTNER ', password: SEED_PASSWORD },
      { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36', ...fromIp('203.0.113.4') },
    );
    expect(sessionOf(res)).toEqual({ sid: expect.any(Number), uid: 2, n: 'partner', pc: true, exp: NOW + 30 * DAY });
    const row = getDb().prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    expect(row).toMatchObject({ user_id: 2, label: 'Windows · Chrome', ip: '203.0.113.4' });
    expect(row.token_hash).toBe(hashSessionToken(tokenOf(res)));
    expect(getUserById(2)?.lastLoginAt).toBe(NOW);
  });

  it('every sign-in is its own session', async () => {
    const a = tokenOf(await login(GOOD));
    const b = tokenOf(await login(GOOD));
    expect(a).not.toBe(b);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
  });

  it('a permanent password signs in without the flag', async () => {
    getDb().prepare('UPDATE users SET must_change_password = 0 WHERE id = 1').run();
    const res = await login(GOOD);
    expect(await res.json()).toEqual({ mustChangePassword: false });
    expect(sessionOf(res)?.pc).toBe(false);
  });

  it('honors SESSION_MAX_AGE_DAYS', async () => {
    state.cfg = testConfig({ SESSION_MAX_AGE_DAYS: '3' });
    const res = await login(GOOD);
    expect(sessionOf(res)?.exp).toBe(NOW + 3 * 86_400_000);
  });

  it('sets Secure per COOKIE_SECURE: true, auto behind https, auto over plain http', async () => {
    state.cfg = testConfig({ COOKIE_SECURE: 'true' });
    expect((await login(GOOD)).headers.getSetCookie()[0]).toMatch(/; Secure$/);
    state.cfg = testConfig({ COOKIE_SECURE: 'auto' });
    const tunnel = await login(GOOD, { 'x-forwarded-proto': 'https' });
    expect(tunnel.headers.getSetCookie()[0]).toMatch(/; Secure$/);
    const lan = await login(GOOD);
    expect(lan.headers.getSetCookie()[0]).not.toMatch(/Secure/);
    state.cfg = testConfig({ COOKIE_SECURE: 'false' });
    const off = await login(GOOD, { 'x-forwarded-proto': 'https' });
    expect(off.headers.getSetCookie()[0]).not.toMatch(/Secure/);
  });

  it('carries the security headers', async () => {
    const res = await login(GOOD);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('refuses a disabled account with the same answer as a wrong password', async () => {
    getDb().prepare('UPDATE users SET disabled = 1 WHERE id = 2').run();
    const res = await login({ username: 'partner', password: SEED_PASSWORD });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Incorrect username or password.' });
  });
});

describe('POST /api/auth/login: wrong password', () => {
  it('answers 401 after the fixed 400 ms delay and sets no cookie', async () => {
    let release: () => void = () => {};
    sleep.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    let settled = false;
    const pending = login({ username: 'admin', password: WRONG }).then((res) => {
      settled = true;
      return res;
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    expect(sleep).toHaveBeenCalledWith(LOGIN_FAILURE_DELAY_MS);
    expect(LOGIN_FAILURE_DELAY_MS).toBe(400);
    expect(settled).toBe(false); // the response waits for the delay
    release();
    const res = await pending;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Incorrect username or password.' });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers an unknown username exactly like a wrong password', async () => {
    const unknown = await login({ username: 'mallory', password: WRONG }, fromIp('198.51.100.1'));
    const wrong = await login({ username: 'partner', password: WRONG }, fromIp('198.51.100.2'));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it('does not delay successful logins or rate-limited refusals', async () => {
    await login(GOOD);
    for (let i = 0; i < 5; i += 1) await guess();
    sleep.mockClear();
    expect((await guess()).status).toBe(429);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login: captcha after two wrong passwords', () => {
  it('hands out a captcha with the second failure and requires it from then on', async () => {
    const first = await login({ username: 'admin', password: WRONG });
    expect(await first.json()).toEqual({ error: 'unauthorized', message: 'Incorrect username or password.' });

    const second = (await (await login({ username: 'admin', password: WRONG })).json()) as {
      captcha?: { id: string; image: string; expiresAt: number };
    };
    expect(second.captcha?.image).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);

    // The right password alone is not enough now; this does not count as a password attempt.
    const missing = await login(GOOD);
    expect(missing.status).toBe(401);
    const body = (await missing.json()) as { message: string; captcha?: { id: string } };
    expect(body.message).toBe('Type the characters in the image.');
    expect(body.captcha?.id).toEqual(expect.any(String));
    expect(missing.headers.getSetCookie()).toEqual([]);

    const wrongCaptcha = await login({ ...GOOD, captchaId: body.captcha!.id, captchaAnswer: 'XXXXX' });
    expect(((await wrongCaptcha.json()) as { message: string }).message).toMatch(/did not match/);

    const ok = await login({ ...GOOD, ...solved() });
    expect(ok.status).toBe(200);
    // Success forgives the failures: no captcha next time.
    expect((await login(GOOD)).status).toBe(200);
  });

  it('a captcha is single-use, expires after 5 minutes and is not case-sensitive', async () => {
    for (let i = 0; i < 2; i += 1) await login({ username: 'admin', password: WRONG });
    const reused = solved();
    expect((await login({ ...GOOD, ...reused, captchaAnswer: ' a c d 3 4 ' })).status).toBe(200);
    for (let i = 0; i < 2; i += 1) await login({ username: 'admin', password: WRONG, ...solved() });
    expect((await login({ ...GOOD, ...reused })).status).toBe(401);
    const stale = solved();
    clock.now += 5 * 60_000;
    expect((await login({ ...GOOD, ...stale })).status).toBe(401);
  });

  it('tracks the username across addresses and the address across usernames', async () => {
    await login({ username: 'partner', password: WRONG }, fromIp('198.51.100.1'));
    await login({ username: 'partner', password: WRONG }, fromIp('198.51.100.2'));
    const otherIp = await login({ username: 'partner', password: SEED_PASSWORD }, fromIp('198.51.100.3'));
    expect(((await otherIp.json()) as { captcha?: unknown }).captcha).toBeDefined();

    await login({ username: 'a', password: WRONG }, fromIp('198.51.100.9'));
    await login({ username: 'b', password: WRONG }, fromIp('198.51.100.9'));
    const sameIp = await login({ username: 'admin', password: SEED_PASSWORD }, fromIp('198.51.100.9'));
    expect(sameIp.status).toBe(401);
    expect((await login(GOOD, fromIp('198.51.100.10'))).status).toBe(200);
  });

  it('forgets failures after 15 minutes', async () => {
    for (let i = 0; i < 2; i += 1) await login({ username: 'admin', password: WRONG });
    clock.now += 15 * 60_000;
    expect((await login(GOOD)).status).toBe(200);
  });
});

describe('POST /api/auth/login: rate limiting', () => {
  it('locks an address after 5 failures with 429, Retry-After and retryAfterSec', async () => {
    for (let i = 0; i < 5; i += 1) expect((await guess(fromIp('198.51.100.1'))).status).toBe(401);
    const res = await guess(fromIp('198.51.100.1'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(await res.json()).toEqual({
      error: 'rate_limited',
      message: 'Too many failed attempts.',
      retryAfterSec: 900,
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses even the correct password while locked, and reports the remaining time', async () => {
    for (let i = 0; i < 5; i += 1) await guess(fromIp('198.51.100.1'));
    clock.now += 5 * 60_000;
    const res = await login({ ...GOOD, ...solved() }, fromIp('198.51.100.1'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('unlocks after 15 minutes', async () => {
    for (let i = 0; i < 5; i += 1) await guess(fromIp('198.51.100.1'));
    clock.now += 15 * 60_000;
    expect((await login(GOOD, fromIp('198.51.100.1'))).status).toBe(200);
  });

  it('keeps addresses apart', async () => {
    for (let i = 0; i < 5; i += 1) await guess(fromIp('198.51.100.1'), 'nobody');
    expect((await login(GOOD, fromIp('198.51.100.2'))).status).toBe(200);
  });

  it('missing captchas never lock anyone out', async () => {
    for (let i = 0; i < 2; i += 1) await login({ username: 'admin', password: WRONG }, fromIp('198.51.100.1'));
    for (let i = 0; i < 10; i += 1) expect((await login(GOOD, fromIp('198.51.100.1'))).status).toBe(401);
    expect((await login({ ...GOOD, ...solved() }, fromIp('198.51.100.1'))).status).toBe(200);
  });

  it('locks everyone after 20 failures across addresses (global lock)', async () => {
    for (let i = 0; i < 20; i += 1) expect((await guess(fromIp(`203.0.113.${i + 1}`), `u${i}`)).status).toBe(401);
    const res = await login({ ...GOOD, ...solved() }, fromIp('192.0.2.200'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    clock.now += 15 * 60_000;
    expect((await login(GOOD, fromIp('192.0.2.200'))).status).toBe(200);
  });

  it('with TRUST_PROXY=cloudflare keys on cf-connecting-ip, so rotating x-forwarded-for does not help', async () => {
    state.cfg = testConfig({ TRUST_PROXY: 'cloudflare' });
    for (let i = 0; i < 5; i += 1) {
      await guess({ 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-for': `198.51.100.${i + 1}` });
    }
    const res = await guess({ 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-for': '198.51.100.99' });
    expect(res.status).toBe(429);
  });

  it('with TRUST_PROXY=none a forged cf-connecting-ip is ignored', async () => {
    for (let i = 0; i < 5; i += 1) {
      await guess({ 'cf-connecting-ip': `203.0.113.${i + 1}`, 'x-forwarded-for': '198.51.100.7' });
    }
    const res = await guess({ 'cf-connecting-ip': '203.0.113.99', 'x-forwarded-for': '198.51.100.7' });
    expect(res.status).toBe(429);
  });

  it('a burst of parallel guesses cannot exceed the limit', async () => {
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 0));
    sleep.mockImplementation(() => gate);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => login({ username: 'admin', password: WRONG }, fromIp('198.51.100.1'))),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });
});

describe('POST /api/auth/login: request validation', () => {
  it('415 unless the content type is application/json', async () => {
    const res = await login(
      `username=admin&password=${SEED_PASSWORD}`,
      { 'content-type': 'application/x-www-form-urlencoded' },
      { raw: true },
    );
    expect(res.status).toBe(415);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('403 for cross-site requests and for a missing or foreign Origin', async () => {
    expect((await login(GOOD, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const noMeta = { 'content-type': 'application/json', host: 'dash.test:8043' };
    const post = (extra: Record<string, string>) =>
      POST(
        request('/api/auth/login', {
          method: 'POST',
          headers: { ...noMeta, ...extra },
          body: JSON.stringify(GOOD),
        }),
      );
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ origin: 'http://dash.test:8043' })).status).toBe(200);
    expect((await post({ origin: 'http://alt.test:8043' })).status).toBe(200);
  });

  it('does not count CSRF or validation rejections as password failures', async () => {
    for (let i = 0; i < 10; i += 1)
      await login({ username: 'admin', password: WRONG }, { 'sec-fetch-site': 'cross-site' });
    for (let i = 0; i < 10; i += 1) await login({ nope: true });
    expect((await login(GOOD)).status).toBe(200);
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a JSON array', '[]'],
    ['no password', JSON.stringify({ username: 'admin' })],
    ['no username', JSON.stringify({ password: SEED_PASSWORD })],
    ['blank username', JSON.stringify({ username: '   ', password: SEED_PASSWORD })],
    ['empty password', JSON.stringify({ username: 'admin', password: '' })],
    ['non-string password', JSON.stringify({ username: 'admin', password: 12345678 })],
    ['username over 32 characters', JSON.stringify({ username: 'x'.repeat(33), password: SEED_PASSWORD })],
    ['empty body', ''],
  ])('400 bad_request for %s', async (_label, body) => {
    const res = await login(body, {}, { raw: true });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe('bad_request');
    expect(json.message).not.toContain(SEED_PASSWORD);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('413 for an oversized body', async () => {
    const res = await login(JSON.stringify({ username: 'admin', password: 'x'.repeat(10_000) }), {}, { raw: true });
    expect(res.status).toBe(413);
  });

  it('500 with a generic body when the configuration is unusable', async () => {
    state.fail = true;
    const res = await login(GOOD);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe('POST /api/auth/login: secrecy', () => {
  it('never puts the password (right or wrong), the session secret or a config value in a response body or log', async () => {
    const bodies: string[] = [];
    const responses = [
      await login(GOOD, fromIp('198.51.100.1')),
      await login({ username: 'admin', password: WRONG }, fromIp('198.51.100.2')),
      await login({ username: 'admin', password: WRONG }, { 'sec-fetch-site': 'cross-site' }),
      await login('{broken', {}, { raw: true }),
    ];
    for (let i = 0; i < 5; i += 1) await guess(fromIp('198.51.100.3'));
    responses.push(await login({ ...GOOD, ...solved() }, fromIp('198.51.100.3')));
    state.fail = true;
    responses.push(await login(GOOD));
    for (const res of responses) bodies.push(await res.text());

    expect(output.join('')).toContain('login failed');
    expect(output.join('')).toContain('login ok');
    for (const text of [...output, ...bodies]) {
      expect(text).not.toContain(SEED_PASSWORD);
      expect(text).not.toContain(WRONG);
      expect(text).not.toContain(TEST_SECRET);
    }
    for (const res of responses) {
      for (const cookie of res.headers.getSetCookie()) expect(cookie).not.toContain(TEST_SECRET);
    }
  });
});

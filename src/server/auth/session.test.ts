import { describe, expect, it } from 'vitest';
import {
  clearedSessionCookie,
  generateSessionToken,
  hashSessionToken,
  isSecureRequest,
  isWellFormedToken,
  maxAgeMsFromDays,
  SESSION_COOKIE,
  sessionCookie,
  sessionTokensFromCookieHeader,
} from './session';
import { DAY } from './test-support';

describe('session tokens', () => {
  it('are 256-bit base64url strings, different every time', () => {
    const a = generateSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(generateSessionToken()).not.toBe(a);
  });

  it('are stored as a SHA-256 hash, never as themselves', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toBe(token);
    expect(hashSessionToken(token)).toBe(hash);
  });

  it.each([
    [undefined, false],
    [null, false],
    ['', false],
    ['x'.repeat(42), false],
    ['x'.repeat(44), false],
    [`${'x'.repeat(42)}=`, false],
    [`${'x'.repeat(42)}.`, false],
    ['eyJ2IjoyfQ.c2ln', false], // the old signed format
    ['x'.repeat(43), true],
  ])('isWellFormedToken(%j) = %s', (token, expected) => {
    expect(isWellFormedToken(token)).toBe(expected);
  });

  it('converts days to milliseconds', () => {
    expect(maxAgeMsFromDays(30)).toBe(30 * DAY);
  });
});

describe('cookies', () => {
  it('sets HttpOnly, SameSite=Lax, Path=/ and Max-Age, without Secure by default', () => {
    const value = sessionCookie('tok.en', 30 * DAY, false);
    expect(value).toBe(`${SESSION_COOKIE}=tok.en; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax`);
    expect(value).not.toMatch(/Secure/);
  });

  it('adds Secure when asked', () => {
    expect(sessionCookie('t', DAY, true)).toMatch(/; Secure$/);
  });

  it('clears with Max-Age=0 and an empty value, keeping the same flags', () => {
    expect(clearedSessionCookie(false)).toBe(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    expect(clearedSessionCookie(true)).toMatch(/; Secure$/);
  });

  describe('isSecureRequest', () => {
    const h = (forwarded?: string) => new Headers(forwarded === undefined ? {} : { 'x-forwarded-proto': forwarded });

    it('COOKIE_SECURE=true always sets Secure and false never does', () => {
      expect(isSecureRequest(h('http'), 'http://x/', true)).toBe(true);
      expect(isSecureRequest(h('https'), 'https://x/', false)).toBe(false);
    });

    it('auto: Secure only behind https (X-Forwarded-Proto), so LAN http still works', () => {
      expect(isSecureRequest(h('https'), 'http://x/', 'auto')).toBe(true);
      expect(isSecureRequest(h('HTTPS'), 'http://x/', 'auto')).toBe(true);
      expect(isSecureRequest(h('https, http'), 'http://x/', 'auto')).toBe(true);
      expect(isSecureRequest(h('http'), 'http://x/', 'auto')).toBe(false);
      expect(isSecureRequest(h('http, https'), 'http://x/', 'auto')).toBe(false);
      expect(isSecureRequest(h(), 'http://x/', 'auto')).toBe(false);
    });

    it('auto: falls back to the URL scheme when there is no forwarded header', () => {
      expect(isSecureRequest(h(), 'https://x/', 'auto')).toBe(true);
      expect(isSecureRequest(h(), 'not a url', 'auto')).toBe(false);
    });
  });

  describe('reading the Cookie header', () => {
    it('finds fd_session among other cookies and ignores look-alikes', () => {
      const header = `theme=dark; x_fd_session=nope; ${SESSION_COOKIE}=abc.def ; other=1`;
      expect(sessionTokensFromCookieHeader(header)).toEqual(['abc.def']);
      expect(sessionTokensFromCookieHeader(null)).toEqual([]);
      expect(sessionTokensFromCookieHeader('novalue')).toEqual([]);
    });
  });
});

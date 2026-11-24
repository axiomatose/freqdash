import { describe, expect, it } from 'vitest';
import { evaluateOrigin, isJsonContentType, sanitizeNext } from './origin';

const h = (init: Record<string, string>) => new Headers(init);
const APP = ['http://alt.test:8043', 'https://dash.example.com'];

describe('isJsonContentType', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/JSON;charset=UTF-8', true],
    ['  application/json  ', true],
    ['text/plain', false],
    ['application/x-www-form-urlencoded', false],
    ['multipart/form-data; boundary=x', false],
    ['application/jsonp', false],
    ['application/json-patch+json', false],
    ['text/plain; application/json', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%j -> %s', (value, expected) => {
    expect(isJsonContentType(value)).toBe(expected);
  });
});

describe('evaluateOrigin', () => {
  describe('Sec-Fetch-Site present', () => {
    it('accepts same-origin, even without an Origin header', () => {
      expect(evaluateOrigin(h({ 'sec-fetch-site': 'same-origin' }), APP)).toEqual({ ok: true });
      expect(evaluateOrigin(h({ 'sec-fetch-site': ' Same-Origin ' }), APP)).toEqual({ ok: true });
    });

    it.each(['cross-site', 'same-site', 'none', ''])('rejects %j', (value) => {
      expect(evaluateOrigin(h({ 'sec-fetch-site': value }), APP)).toEqual({ ok: false, reason: 'cross-site-fetch' });
    });

    it('is authoritative: a trusted-looking Origin does not rescue a cross-site fetch', () => {
      const headers = h({ 'sec-fetch-site': 'cross-site', origin: 'http://alt.test:8043', host: 'alt.test:8043' });
      expect(evaluateOrigin(headers, APP)).toEqual({ ok: false, reason: 'cross-site-fetch' });
    });
  });

  describe('no Sec-Fetch-Site', () => {
    it('fails closed without an Origin', () => {
      expect(evaluateOrigin(h({ host: 'dash.test' }), APP)).toEqual({ ok: false, reason: 'missing-origin' });
      expect(evaluateOrigin(h({ origin: '  ', host: 'dash.test' }), APP)).toEqual({
        ok: false,
        reason: 'missing-origin',
      });
    });

    it('rejects null, malformed and non-http origins', () => {
      for (const origin of ['null', 'not a url', 'file:///etc/passwd', 'chrome-extension://abc']) {
        expect(evaluateOrigin(h({ origin, host: 'dash.test' }), APP)).toEqual({
          ok: false,
          reason: 'untrusted-origin',
        });
      }
    });

    it('accepts an origin listed in APP_ORIGINS', () => {
      expect(evaluateOrigin(h({ origin: 'http://alt.test:8043', host: 'other:1' }), APP)).toEqual({ ok: true });
      expect(evaluateOrigin(h({ origin: 'https://dash.example.com' }), APP)).toEqual({ ok: true });
    });

    it('accepts an origin equal to Host', () => {
      expect(evaluateOrigin(h({ origin: 'http://dash.test:8043', host: 'dash.test:8043' }), [])).toEqual({ ok: true });
      expect(evaluateOrigin(h({ origin: 'http://DASH.test:8043', host: 'dash.TEST:8043' }), [])).toEqual({ ok: true });
    });

    it('prefers X-Forwarded-Host over Host (first value of a list)', () => {
      const headers = h({
        origin: 'https://public.example',
        host: 'freqdash:3000',
        'x-forwarded-host': 'public.example, internal',
        'x-forwarded-proto': 'https',
      });
      expect(evaluateOrigin(headers, [])).toEqual({ ok: true });
    });

    it('requires the scheme to agree with X-Forwarded-Proto when the tunnel reports it', () => {
      const base = { host: 'public.example', 'x-forwarded-proto': 'https' };
      expect(evaluateOrigin(h({ ...base, origin: 'http://public.example' }), [])).toEqual({
        ok: false,
        reason: 'untrusted-origin',
      });
      expect(evaluateOrigin(h({ ...base, origin: 'https://public.example' }), [])).toEqual({ ok: true });
    });

    it('ignores default ports when comparing', () => {
      expect(evaluateOrigin(h({ origin: 'https://public.example', host: 'public.example:443' }), [])).toEqual({
        ok: true,
      });
    });

    it('rejects a different host, different port, and look-alike hosts', () => {
      for (const origin of [
        'http://evil.example',
        'http://dash.test:9999',
        'http://dash.test.evil.example:8043',
        'http://evildash.test:8043',
      ]) {
        expect(evaluateOrigin(h({ origin, host: 'dash.test:8043' }), [])).toEqual({
          ok: false,
          reason: 'untrusted-origin',
        });
      }
    });

    it('rejects when the addressed host is missing or malformed', () => {
      expect(evaluateOrigin(h({ origin: 'http://dash.test' }), [])).toEqual({ ok: false, reason: 'untrusted-origin' });
      expect(evaluateOrigin(h({ origin: 'http://dash.test', host: 'dash.test/evil' }), [])).toEqual({
        ok: false,
        reason: 'untrusted-origin',
      });
    });
  });
});

describe('sanitizeNext', () => {
  it.each([
    ['/', '/'],
    ['/findings', '/findings'],
    ['/bots/votemax', '/bots/votemax'],
    ['/chart?bot=votemax&pair=ETH%2FUSD&tf=4h', '/chart?bot=votemax&pair=ETH%2FUSD&tf=4h'],
    ['/trades#frag', '/trades'],
    ['/a/../b', '/b'],
  ])('keeps the relative path %j -> %j', (input, expected) => {
    expect(sanitizeNext(input)).toBe(expected);
  });

  it.each([
    ['https://evil.example/x'],
    ['http://evil.example'],
    ['//evil.example/x'],
    ['///evil.example'],
    ['/\\evil.example'],
    ['\\\\evil.example'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['/..//evil.example'],
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['evil.example'],
    ['relative/path'],
    ['?x=1'],
    [''],
  ])('collapses %j to "/"', (input) => {
    expect(sanitizeNext(input)).toBe('/');
  });

  it('collapses targets that make no sense after login', () => {
    for (const input of ['/login', '/login?next=/x', '/login/', '/api/v1/summary', '/api', '/_next/static/x.js']) {
      expect(sanitizeNext(input)).toBe('/');
    }
    expect(sanitizeNext('/loginfo')).toBe('/loginfo');
  });

  it('handles missing, non-string and oversized input', () => {
    expect(sanitizeNext(undefined)).toBe('/');
    expect(sanitizeNext(null)).toBe('/');
    expect(sanitizeNext(`/${'a'.repeat(600)}`)).toBe('/');
  });
});

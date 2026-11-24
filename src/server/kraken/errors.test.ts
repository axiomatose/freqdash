import { describe, expect, it } from 'vitest';
import { clearRegisteredSecrets, registerSecrets } from '../log';
import invalidKey from '../../../test/fixtures/raw/kraken/errors/invalid_key.json';
import invalidNonce from '../../../test/fixtures/raw/kraken/errors/invalid_nonce.json';
import invalidSignature from '../../../test/fixtures/raw/kraken/errors/invalid_signature.json';
import permissionDenied from '../../../test/fixtures/raw/kraken/errors/permission_denied.json';
import rateLimit from '../../../test/fixtures/raw/kraken/errors/rate_limit.json';
import throttled from '../../../test/fixtures/raw/kraken/errors/throttled.json';
import unavailable from '../../../test/fixtures/raw/kraken/errors/unavailable.json';
import {
  classifyHttpStatus,
  classifyKrakenError,
  isErrorEntry,
  isKrakenError,
  isTransientKind,
  KrakenError,
  parseKrakenEnvelope,
} from './errors';

describe('classifyKrakenError', () => {
  it.each([
    ['invalid_key', invalidKey, 'auth'],
    ['invalid_signature', invalidSignature, 'auth'],
    ['permission_denied', permissionDenied, 'permission'],
    ['invalid_nonce', invalidNonce, 'nonce'],
    ['rate_limit', rateLimit, 'ratelimit'],
    ['throttled', throttled, 'ratelimit'],
    ['unavailable', unavailable, 'unavailable'],
  ] as const)('classifies the %s fixture as %s', (_name, body, kind) => {
    expect(classifyKrakenError(body.error)).toBe(kind);
  });

  it.each([
    ['EService:Busy', 'unavailable'],
    ['EGeneral:Internal error', 'unavailable'],
    ['EOrder:Rate limit exceeded', 'ratelimit'],
    ['EGeneral:Temporary lockout', 'ratelimit'],
    ['EGeneral:Invalid arguments', 'api'],
    ['EQuery:Unknown asset pair', 'api'],
    ['something else entirely', 'api'],
  ] as const)('classifies %s as %s', (message, kind) => {
    expect(classifyKrakenError(message)).toBe(kind);
    expect(classifyKrakenError([message])).toBe(kind);
  });

  it('picks the most actionable class when several errors are present', () => {
    expect(classifyKrakenError(['EService:Unavailable', 'EAPI:Invalid key'])).toBe('auth');
    expect(classifyKrakenError(['EService:Unavailable', 'EAPI:Invalid nonce'])).toBe('nonce');
    expect(classifyKrakenError(['EGeneral:Invalid arguments', 'EAPI:Rate limit exceeded'])).toBe('ratelimit');
  });

  it('ignores warnings (severity W)', () => {
    expect(isErrorEntry('WGeneral:Something')).toBe(false);
    expect(isErrorEntry('EGeneral:Something')).toBe(true);
    expect(classifyKrakenError(['WService:Unavailable'])).toBe('api');
  });
});

describe('classifyHttpStatus / isTransientKind', () => {
  it('maps gateway statuses', () => {
    expect(classifyHttpStatus(429)).toBe('ratelimit');
    expect(classifyHttpStatus(502)).toBe('unavailable');
    expect(classifyHttpStatus(503)).toBe('unavailable');
    expect(classifyHttpStatus(403)).toBe('network');
    expect(classifyHttpStatus(404)).toBe('network');
  });

  it('separates transient from configuration problems', () => {
    for (const kind of ['ratelimit', 'unavailable', 'network', 'nonce'] as const)
      expect(isTransientKind(kind)).toBe(true);
    for (const kind of ['auth', 'permission', 'api', 'parse', 'forbidden'] as const)
      expect(isTransientKind(kind)).toBe(false);
  });
});

describe('KrakenError', () => {
  it('carries kind and details, and redacts registered secrets from the message', () => {
    registerSecrets(['s3cr3t-value-123']);
    try {
      const error = new KrakenError('network', 'failed for s3cr3t-value-123', {
        endpoint: 'Balance',
        krakenErrors: ['EAPI:Invalid key'],
        status: 200,
        retryAfterMs: 5,
      });
      expect(error.message).not.toContain('s3cr3t-value-123');
      expect(error).toMatchObject({
        name: 'KrakenError',
        kind: 'network',
        endpoint: 'Balance',
        krakenErrors: ['EAPI:Invalid key'],
        status: 200,
        retryAfterMs: 5,
      });
      expect(isKrakenError(error)).toBe(true);
      expect(isKrakenError(new Error('x'))).toBe(false);
    } finally {
      clearRegisteredSecrets();
    }
  });

  it('defaults optional fields to null', () => {
    const error = new KrakenError('api', 'x');
    expect([error.endpoint, error.status, error.retryAfterMs, error.krakenErrors]).toEqual([null, null, null, []]);
  });
});

describe('parseKrakenEnvelope', () => {
  const ok = (result: unknown) => JSON.stringify({ error: [], result });

  it('returns the result of a successful response', () => {
    expect(parseKrakenEnvelope('Time', 200, ok({ unixtime: 1 }))).toEqual({ unixtime: 1 });
  });

  it('lets the Kraken error array win over the HTTP status', () => {
    const fn = () => parseKrakenEnvelope('Balance', 200, JSON.stringify(invalidKey));
    expect(fn).toThrow(KrakenError);
    try {
      fn();
    } catch (error) {
      expect(error).toMatchObject({
        kind: 'auth',
        endpoint: 'Balance',
        krakenErrors: ['EAPI:Invalid key'],
        status: 200,
      });
    }
  });

  it('classifies error bodies that arrive with a failing status', () => {
    expect(() => parseKrakenEnvelope('Balance', 503, JSON.stringify(unavailable))).toThrow(/EService:Unavailable/);
  });

  it('treats a warning-only error array with a result as success', () => {
    const body = JSON.stringify({ error: ['WGeneral:Deprecated'], result: { a: 1 } });
    expect(parseKrakenEnvelope('Time', 200, body)).toEqual({ a: 1 });
  });

  it('classifies bodiless gateway failures by status and never echoes the body', () => {
    try {
      parseKrakenEnvelope('OpenOrders', 502, '<html>Bad gateway, secret token=abc123</html>');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ kind: 'unavailable', status: 502 });
      expect((error as Error).message).toBe('OpenOrders: HTTP 502');
    }
    expect(() => parseKrakenEnvelope('X', 429, '')).toThrow(expect.objectContaining({ kind: 'ratelimit' }));
  });

  it('rejects a 200 that is not a result envelope', () => {
    for (const text of ['not json', '[]', '{"error":[]}', '"x"']) {
      expect(() => parseKrakenEnvelope('Time', 200, text)).toThrow(expect.objectContaining({ kind: 'parse' }));
    }
  });
});

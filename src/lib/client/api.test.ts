// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, authRedirect, describeError, loginUrl, resetApiState, serverNow, toSearch } from './api';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetApiState();
  window.history.replaceState(null, '', '/trades?bot=dca');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('apiFetch success paths', () => {
  it('GETs same-origin without a content type and returns the JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hello: 'world' }));
    const data = await apiFetch<{ hello: string }>('/api/v1/summary');
    expect(data).toEqual({ hello: 'world' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('sends Content-Type: application/json and a JSON body on POST', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiFetch('/api/v1/acks', { method: 'POST', body: { kind: 'asset', subjects: ['ETH'] } });
    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ kind: 'asset', subjects: ['ETH'] }));
  });

  it('sends {} for a bodyless POST and no body for DELETE, both with the JSON content type', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await apiFetch('/api/auth/logout', { method: 'POST' });
    await apiFetch('/api/v1/acks/3', { method: 'DELETE' });
    const post = fetchMock.mock.calls[0]?.[1];
    const del = fetchMock.mock.calls[1]?.[1];
    expect(post?.body).toBe('{}');
    expect(del?.body).toBeUndefined();
    expect((del?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiFetch<void>('/api/v1/acks/3', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('apiFetch errors', () => {
  it('decodes the { error, message, retryAfterSec } shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'rate_limited', message: 'Slow down', retryAfterSec: 42 }, { status: 429 }),
    );
    const err = await apiFetch('/api/v1/summary').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.kind).toBe('rate_limited');
    expect(api.status).toBe(429);
    expect(api.message).toBe('Slow down');
    expect(api.retryAfterSec).toBe(42);
    expect(describeError(api)).toBe('Slow down Try again in 42 s.');
  });

  it('falls back to the Retry-After header and to status-derived kinds', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 429, headers: { 'Retry-After': '30' } }));
    const rl = (await apiFetch('/x').catch((e: unknown) => e)) as ApiError;
    expect(rl.kind).toBe('rate_limited');
    expect(rl.retryAfterSec).toBe(30);

    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
    expect(((await apiFetch('/x').catch((e: unknown) => e)) as ApiError).kind).toBe('not_found');

    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const server = (await apiFetch('/x').catch((e: unknown) => e)) as ApiError;
    expect(server.kind).toBe('internal');
    expect(server.retryAfterSec).toBeNull();
  });

  it('maps a network failure to kind "network"', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = (await apiFetch('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('network');
    expect(err.status).toBe(0);
  });

  it('lets aborts through untouched', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValue(abort);
    await expect(apiFetch('/x')).rejects.toBe(abort);
  });

  it('flags an unreadable success body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
    expect(((await apiFetch('/x').catch((e: unknown) => e)) as ApiError).kind).toBe('bad_response');
  });
});

describe('401 handling', () => {
  it('redirects to /login with the current path as next, once', async () => {
    const go = vi.spyOn(authRedirect, 'go').mockImplementation(() => {});
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, { status: 401 }));
    const err = (await apiFetch('/api/v1/summary').catch((e: unknown) => e)) as ApiError;
    await apiFetch('/api/v1/overview').catch(() => {});
    expect(err.kind).toBe('unauthorized');
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith('/login?next=%2Ftrades%3Fbot%3Ddca');
  });

  it('does not redirect when already on the login page', async () => {
    window.history.replaceState(null, '', '/login');
    const go = vi.spyOn(authRedirect, 'go').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await apiFetch('/api/v1/summary').catch(() => {});
    expect(go).not.toHaveBeenCalled();
  });

  it('builds relative login targets', () => {
    window.history.replaceState(null, '', '/');
    expect(loginUrl()).toBe('/login');
    window.history.replaceState(null, '', '/findings#a');
    expect(loginUrl()).toBe('/login?next=%2Ffindings');
  });
});

describe('server clock', () => {
  it('learns a large skew from generatedAt and ignores small ones', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ generatedAt: Date.now() + 60_000 }));
    await apiFetch('/x');
    expect(Math.abs(serverNow() - (Date.now() + 60_000))).toBeLessThan(500);

    fetchMock.mockResolvedValue(jsonResponse({ generatedAt: Date.now() - 800 }));
    await apiFetch('/x');
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);
  });
});

describe('toSearch', () => {
  it('skips empty values and encodes the rest', () => {
    expect(toSearch({})).toBe('');
    expect(toSearch({ bot: 'dca', pair: 'BTC/USD', since: undefined, status: '', limit: 0 })).toBe(
      '?bot=dca&pair=BTC%2FUSD&limit=0',
    );
  });
});

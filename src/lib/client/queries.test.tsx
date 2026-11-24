// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_REFETCH_MS } from '@/shared/constants';
import { ApiError, authRedirect, resetApiState } from './api';
import {
  ACK_KEYS,
  FINDING_KEYS,
  queryKeys,
  shouldRetry,
  useCreateAcks,
  useLogout,
  useNotifyTest,
  useRevokeAck,
  useSilence,
  useSummary,
  useTrades,
  useUnsilence,
} from './queries';

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const lastInit = (): RequestInit => fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
const lastUrl = (): string => String(fetchMock.mock.calls.at(-1)?.[0]);
const headersOf = (init: RequestInit): Record<string, string> => init.headers as Record<string, string>;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetApiState();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('read hooks', () => {
  it('poll every 10 s, only while the tab is visible, and keep previous data', async () => {
    fetchMock.mockResolvedValue(json({ generatedAt: 1 }));
    const { qc, wrapper } = setup();
    renderHook(() => useSummary(), { wrapper });
    await waitFor(() => expect(qc.getQueryData(queryKeys.summary)).toBeDefined());
    const options = qc.getQueryCache().find({ queryKey: queryKeys.summary })?.observers[0]?.options;
    expect(options?.refetchInterval).toBe(CLIENT_REFETCH_MS);
    expect(options?.refetchIntervalInBackground).toBe(false);
    expect(options?.placeholderData).toBe(keepPreviousData);
    expect(lastUrl()).toBe('/api/v1/summary');
  });

  it('lets a caller override or stop the poll', async () => {
    fetchMock.mockResolvedValue(json({}));
    const { qc, wrapper } = setup();
    renderHook(() => useSummary({ refetchInterval: false }), { wrapper });
    await waitFor(() => expect(qc.getQueryData(queryKeys.summary)).toBeDefined());
    expect(qc.getQueryCache().find({ queryKey: queryKeys.summary })?.observers[0]?.options.refetchInterval).toBe(false);
  });

  it('serialises filters into the query string and skips empty ones', async () => {
    fetchMock.mockResolvedValue(json({ trades: [] }));
    const { wrapper } = setup();
    renderHook(() => useTrades({ bot: 'dca', status: 'open', pair: undefined, limit: 50 }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastUrl()).toBe('/api/v1/trades?bot=dca&status=open&limit=50');
  });

  it('keeps showing the previous result while a new filter loads', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockResolvedValueOnce(json({ total: 1 }));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((res) => (release = res)));
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ bot }: { bot: string }) => useTrades({ bot }), {
      wrapper,
      initialProps: { bot: 'votemax' },
    });
    await waitFor(() => expect(result.current.data).toEqual({ total: 1 }));

    rerender({ bot: 'dca' });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data).toEqual({ total: 1 });

    await act(async () => release(json({ total: 2 })));
    await waitFor(() => expect(result.current.data).toEqual({ total: 2 }));
    expect(result.current.isPlaceholderData).toBe(false);
  });
});

describe('shouldRetry', () => {
  it('never retries 4xx answers and retries network/5xx twice', () => {
    expect(shouldRetry(0, new ApiError('not_found', 404, 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError('forbidden', 403, 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError('network', 0, 'x'))).toBe(true);
    expect(shouldRetry(1, new ApiError('internal', 500, 'x'))).toBe(true);
    expect(shouldRetry(2, new ApiError('internal', 500, 'x'))).toBe(false);
  });
});

describe('mutations', () => {
  it('useSilence POSTs JSON with the note and invalidates findings, summary and overview', async () => {
    fetchMock.mockResolvedValue(json({ finding: { id: 3 } }));
    const { qc, wrapper } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSilence(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 3, note: 'known' });
    });
    expect(lastUrl()).toBe('/api/v1/findings/3/silence');
    expect(lastInit().method).toBe('POST');
    expect(headersOf(lastInit())['Content-Type']).toBe('application/json');
    expect(lastInit().body).toBe(JSON.stringify({ note: 'known' }));
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([...FINDING_KEYS]);
  });

  it('useSilence without a note sends an empty JSON object', async () => {
    fetchMock.mockResolvedValue(json({ finding: { id: 3 } }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useSilence(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 3 });
    });
    expect(lastInit().body).toBe('{}');
  });

  it('useUnsilence POSTs to the unsilence route with the JSON content type', async () => {
    fetchMock.mockResolvedValue(json({ finding: { id: 3 } }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useUnsilence(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 3 });
    });
    expect(lastUrl()).toBe('/api/v1/findings/3/unsilence');
    expect(headersOf(lastInit())['Content-Type']).toBe('application/json');
  });

  it('useCreateAcks sends one request with every subject and invalidates the ack-related queries', async () => {
    fetchMock.mockResolvedValue(json({ acks: [] }));
    const { qc, wrapper } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateAcks(), { wrapper });
    const body = {
      kind: 'kraken_order' as const,
      subjects: ['O1', 'O2', 'O3'],
      label: 'manual' as const,
      note: 'bought by hand',
    };
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toBe('/api/v1/acks');
    expect(JSON.parse(String(lastInit().body))).toEqual(body);
    expect(headersOf(lastInit())['Content-Type']).toBe('application/json');
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([...ACK_KEYS]);
  });

  it('useRevokeAck DELETEs /acks/:id (204) with the JSON content type', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { wrapper } = setup();
    const { result } = renderHook(() => useRevokeAck(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 9 });
    });
    expect(lastUrl()).toBe('/api/v1/acks/9');
    expect(lastInit().method).toBe('DELETE');
    expect(headersOf(lastInit())['Content-Type']).toBe('application/json');
  });

  it('useNotifyTest POSTs and refreshes status', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    const { qc, wrapper } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useNotifyTest(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(lastUrl()).toBe('/api/v1/notify/test');
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([queryKeys.status]);
  });

  it('surfaces the server error shape from a failed mutation', async () => {
    fetchMock.mockResolvedValue(json({ error: 'forbidden', message: 'Cross-origin request refused' }, 403));
    const { wrapper } = setup();
    const { result } = renderHook(() => useSilence(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 1 }).catch(() => {});
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.kind).toBe('forbidden');
    expect(result.current.error?.message).toBe('Cross-origin request refused');
  });

  it('useLogout POSTs, clears the cache and goes to /login', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const go = vi.spyOn(authRedirect, 'go').mockImplementation(() => {});
    const { qc, wrapper } = setup();
    qc.setQueryData(queryKeys.summary, { generatedAt: 1 });
    const { result } = renderHook(() => useLogout(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(lastUrl()).toBe('/api/auth/logout');
    expect(headersOf(lastInit())['Content-Type']).toBe('application/json');
    expect(qc.getQueryData(queryKeys.summary)).toBeUndefined();
    expect(go).toHaveBeenCalledWith('/login');
  });
});

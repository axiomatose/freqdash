// Typed TanStack Query v5 hooks for every /api/v1 route, plus the mutations.
// Reads poll every CLIENT_REFETCH_MS, pause while the tab is hidden, and keep the previous data on screen while
// a new key loads (placeholderData: keepPreviousData) so pages never flash back to skeletons.
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { CLIENT_REFETCH_MS } from '@/shared/constants';
import type {
  AcksResponse,
  BotDetailResponse,
  CreateAcksBody,
  EquityRange,
  EquityResponse,
  FindingResponse,
  FindingsResponse,
  FindingsStatusFilter,
  KrakenOrdersMatchFilter,
  KrakenOrdersResponse,
  NotifyTestResponse,
  OverviewResponse,
  PositionsResponse,
  SessionResponse,
  StatusResponse,
  SummaryResponse,
  TradesResponse,
  TradesStatusFilter,
} from '@/shared/types/api';
import type { StrategiesResponse } from '@/shared/types/strategy';
import type { BotId, ChartData, Ms, Pair, Severity } from '@/shared/types/domain';
import { apiFetch, authRedirect, isApiError, toSearch, type ApiError } from './api';

export interface QueryOpts {
  enabled?: boolean;
  /** Override the 10 s poll (pass false to stop polling). */
  refetchInterval?: number | false;
}

export interface TradesParams {
  bot?: BotId;
  pair?: Pair;
  status?: TradesStatusFilter;
  since?: Ms;
  limit?: number;
  offset?: number;
}
export interface KrakenOrdersParams {
  since?: Ms;
  pair?: Pair;
  match?: KrakenOrdersMatchFilter;
  limit?: number;
}
export interface FindingsParams {
  status?: FindingsStatusFilter;
  severity?: Severity;
  limit?: number;
}
export interface ChartParams {
  bot: BotId;
  pair: Pair;
  tf: string;
  limit?: number;
}

export const queryKeys = {
  summary: ['summary'] as const,
  overview: ['overview'] as const,
  positions: ['positions'] as const,
  bot: (botId: BotId) => ['bot', botId] as const,
  trades: (p: TradesParams) => ['trades', p] as const,
  krakenOrders: (p: KrakenOrdersParams) => ['kraken-orders', p] as const,
  findings: (p: FindingsParams) => ['findings', p] as const,
  acks: ['acks'] as const,
  equity: (range: EquityRange) => ['equity', range] as const,
  chart: (p: ChartParams) => ['chart', p] as const,
  status: ['status'] as const,
  strategies: (p: { code?: boolean; assumedFee?: number }) => ['strategies', p] as const,
  session: ['session'] as const,
};

/** 4xx answers are final (retrying a 404 or 403 changes nothing); network and 5xx errors get two retries. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

const poll = {
  refetchInterval: CLIENT_REFETCH_MS,
  // Also the library default; explicit because "paused when the tab is hidden" is a stated requirement.
  refetchIntervalInBackground: false,
  placeholderData: keepPreviousData,
  staleTime: 5_000,
  retry: shouldRetry,
} as const;

function pollWith(opts: QueryOpts | undefined) {
  return {
    ...poll,
    ...(opts?.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
    ...(opts?.enabled !== undefined ? { enabled: opts.enabled } : {}),
  };
}

// ---- query option factories (also usable for prefetching and in tests) ---------------------------------------------

function makeQuery<T>(queryKey: readonly unknown[], path: string) {
  return queryOptions<T, ApiError, T, readonly unknown[]>({
    queryKey,
    queryFn: ({ signal }) => apiFetch<T>(path, { signal }),
  });
}

export const summaryQuery = () => makeQuery<SummaryResponse>(queryKeys.summary, '/api/v1/summary');
export const overviewQuery = () => makeQuery<OverviewResponse>(queryKeys.overview, '/api/v1/overview');
export const positionsQuery = () => makeQuery<PositionsResponse>(queryKeys.positions, '/api/v1/positions');
export const botQuery = (botId: BotId) =>
  makeQuery<BotDetailResponse>(queryKeys.bot(botId), `/api/v1/bots/${encodeURIComponent(botId)}`);
export const tradesQuery = (p: TradesParams) =>
  makeQuery<TradesResponse>(queryKeys.trades(p), `/api/v1/trades${toSearch(p)}`);
export const krakenOrdersQuery = (p: KrakenOrdersParams) =>
  makeQuery<KrakenOrdersResponse>(queryKeys.krakenOrders(p), `/api/v1/kraken/orders${toSearch(p)}`);
export const findingsQuery = (p: FindingsParams) =>
  makeQuery<FindingsResponse>(queryKeys.findings(p), `/api/v1/findings${toSearch(p)}`);
export const acksQuery = () => makeQuery<AcksResponse>(queryKeys.acks, '/api/v1/acks');
export const equityQuery = (range: EquityRange) =>
  makeQuery<EquityResponse>(queryKeys.equity(range), `/api/v1/equity${toSearch({ range })}`);
export const chartQuery = (p: ChartParams) => makeQuery<ChartData>(queryKeys.chart(p), `/api/v1/chart${toSearch(p)}`);
export const strategiesQuery = (p: { code?: boolean; assumedFee?: number }) =>
  makeQuery<StrategiesResponse>(
    queryKeys.strategies(p),
    `/api/v1/strategies${toSearch({ ...(p.code ? { code: '1' } : {}), ...(p.assumedFee === undefined ? {} : { assumedFee: p.assumedFee }) })}`,
  );
export const statusQuery = () => makeQuery<StatusResponse>(queryKeys.status, '/api/v1/status');

// ---- read hooks ----------------------------------------------------------------------------------------------------

export function useSummary(opts?: QueryOpts): UseQueryResult<SummaryResponse, ApiError> {
  return useQuery({ ...summaryQuery(), ...pollWith(opts) });
}
export function useOverview(opts?: QueryOpts): UseQueryResult<OverviewResponse, ApiError> {
  return useQuery({ ...overviewQuery(), ...pollWith(opts) });
}
export function usePositions(opts?: QueryOpts): UseQueryResult<PositionsResponse, ApiError> {
  return useQuery({ ...positionsQuery(), ...pollWith(opts) });
}
export function useBot(botId: BotId, opts?: QueryOpts): UseQueryResult<BotDetailResponse, ApiError> {
  return useQuery({ ...botQuery(botId), ...pollWith(opts) });
}
export function useTrades(params: TradesParams = {}, opts?: QueryOpts): UseQueryResult<TradesResponse, ApiError> {
  return useQuery({ ...tradesQuery(params), ...pollWith(opts) });
}
export function useKrakenOrders(
  params: KrakenOrdersParams = {},
  opts?: QueryOpts,
): UseQueryResult<KrakenOrdersResponse, ApiError> {
  return useQuery({ ...krakenOrdersQuery(params), ...pollWith(opts) });
}
export function useFindings(params: FindingsParams = {}, opts?: QueryOpts): UseQueryResult<FindingsResponse, ApiError> {
  return useQuery({ ...findingsQuery(params), ...pollWith(opts) });
}
export function useAcks(opts?: QueryOpts): UseQueryResult<AcksResponse, ApiError> {
  return useQuery({ ...acksQuery(), ...pollWith(opts) });
}
export function useEquity(range: EquityRange, opts?: QueryOpts): UseQueryResult<EquityResponse, ApiError> {
  return useQuery({ ...equityQuery(range), ...pollWith(opts) });
}
export function useChart(params: ChartParams, opts?: QueryOpts): UseQueryResult<ChartData, ApiError> {
  return useQuery({ ...chartQuery(params), ...pollWith(opts) });
}
export function useStrategies(
  params: { code?: boolean; assumedFee?: number } = {},
  opts?: QueryOpts,
): UseQueryResult<StrategiesResponse, ApiError> {
  return useQuery({ ...strategiesQuery(params), ...pollWith({ refetchInterval: 60_000, ...opts }) });
}
export function useStatus(opts?: QueryOpts): UseQueryResult<StatusResponse, ApiError> {
  return useQuery({ ...statusQuery(), ...pollWith(opts) });
}
/** Who is logged in. Fetched once (the name does not change while the page is open). */
export function useSession(): UseQueryResult<SessionResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => apiFetch<SessionResponse>('/api/auth/session', { signal }),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

// ---- mutations -----------------------------------------------------------------------------------------------------

type Key = readonly unknown[];
/** Everything a silence or unsilence can change: the list, the shell badges and the overview summary. */
export const FINDING_KEYS: readonly Key[] = [['findings'], ['summary'], ['overview']];
/** An acknowledgement also changes allocation, order matching and the findings that were derived from them. */
export const ACK_KEYS: readonly Key[] = [
  ['acks'],
  ['findings'],
  ['summary'],
  ['overview'],
  ['positions'],
  ['kraken-orders'],
  ['trades'],
  ['bot'],
];

export function invalidateKeys(qc: QueryClient, keys: readonly Key[]): Promise<unknown> {
  return Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

export function useSilence(): UseMutationResult<FindingResponse, ApiError, { id: number; note?: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }) =>
      apiFetch<FindingResponse>(`/api/v1/findings/${id}/silence`, { method: 'POST', body: note ? { note } : {} }),
    onSuccess: () => invalidateKeys(qc, FINDING_KEYS),
  });
}

export function useUnsilence(): UseMutationResult<FindingResponse, ApiError, { id: number }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => apiFetch<FindingResponse>(`/api/v1/findings/${id}/unsilence`, { method: 'POST' }),
    onSuccess: () => invalidateKeys(qc, FINDING_KEYS),
  });
}

export function useCreateAcks(): UseMutationResult<AcksResponse, ApiError, CreateAcksBody> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<AcksResponse>('/api/v1/acks', { method: 'POST', body }),
    onSuccess: () => invalidateKeys(qc, ACK_KEYS),
  });
}

export function useRevokeAck(): UseMutationResult<void, ApiError, { id: number }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => apiFetch<void>(`/api/v1/acks/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateKeys(qc, ACK_KEYS),
  });
}

export function useNotifyTest(): UseMutationResult<NotifyTestResponse, ApiError, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<NotifyTestResponse>('/api/v1/notify/test', { method: 'POST' }),
    onSuccess: () => invalidateKeys(qc, [queryKeys.status]),
  });
}

export function useResetKillswitch(): UseMutationResult<{ ok: true }, ApiError, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: true }>('/api/v1/killswitch/reset', { method: 'POST' }),
    onSuccess: () => invalidateKeys(qc, [queryKeys.status, queryKeys.summary]),
  });
}

export function useLogout(): UseMutationResult<void, ApiError, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),
    // Whatever the server said, drop every cached payload and land on the login page.
    onSettled: () => {
      qc.clear();
      authRedirect.go('/login');
    },
  });
}

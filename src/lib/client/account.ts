'use client';

// Browser side of the account settings: the signed-in user's sessions.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { SessionsResponse } from '@/shared/types/api';
import { ApiError, apiFetch, authRedirect } from './api';

const key = ['sessions'] as const;

export function useSessions(enabled = true): UseQueryResult<SessionsResponse, ApiError> {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiFetch<SessionsResponse>('/api/v1/sessions', { signal }),
    enabled,
  });
}

/** Ends one session; ending the current one lands on the login page. */
export function useEndSession(): UseMutationResult<void, ApiError, { id: number; current: boolean }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => apiFetch<void>(`/api/v1/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, { current }) => {
      if (current) {
        qc.clear();
        authRedirect.go('/login');
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useEndOtherSessions(): UseMutationResult<{ ended: number }, ApiError, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ended: number }>('/api/v1/sessions', { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

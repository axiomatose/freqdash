'use client';

// Browser side of the built-in assistant: settings and memories hooks, and the streaming chat client.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AgentChatBody,
  AgentConversation,
  AgentConversationResponse,
  AgentEvent,
  AgentMemory,
  AgentStatusResponse,
} from '@/shared/types/agent';
import { ApiError, apiFetch, authRedirect, loginUrl } from './api';

export interface SettingsData {
  values: Record<string, string | number | boolean | null>;
  secretsSet: Record<string, boolean>;
  updatedAt: number | null;
}

export type SettingsPatch = Record<string, string | number | boolean | null>;

const keys = {
  settings: ['settings'] as const,
  agentStatus: ['agent-status'] as const,
  conversations: ['agent-conversations'] as const,
  conversation: (id: string) => ['agent-conversation', id] as const,
  memories: ['agent-memories'] as const,
};

export function useSettings(enabled = true): UseQueryResult<SettingsData, ApiError> {
  return useQuery({
    queryKey: keys.settings,
    queryFn: ({ signal }) => apiFetch<SettingsData>('/api/v1/settings', { signal }),
    enabled,
  });
}

export function useUpdateSettings(): UseMutationResult<SettingsData, ApiError, SettingsPatch> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch) => apiFetch<SettingsData>('/api/v1/settings', { method: 'PUT', body: patch }),
    onSuccess: (data) => {
      qc.setQueryData(keys.settings, data);
      void qc.invalidateQueries({ queryKey: keys.agentStatus });
    },
  });
}

export type ConnectionTest = { ok: true; reply: string } | { ok: false; error: string };

export function useTestAgent(): UseMutationResult<
  ConnectionTest,
  ApiError,
  { baseUrl?: string; apiKey?: string; model?: string }
> {
  return useMutation({
    mutationFn: (body) => apiFetch<ConnectionTest>('/api/v1/settings/agent/test', { method: 'POST', body }),
  });
}

export type ModelList = { ok: true; models: string[] } | { ok: false; error: string };

/** The provider's model list for the endpoint in the settings form (the saved key is used when none is typed). */
export function useModelList(args: {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}): UseQueryResult<ModelList, ApiError> {
  return useQuery({
    queryKey: ['agent-models', args.baseUrl, args.apiKey],
    queryFn: ({ signal }) =>
      apiFetch<ModelList>('/api/v1/settings/agent/models', {
        method: 'POST',
        body: { baseUrl: args.baseUrl, ...(args.apiKey ? { apiKey: args.apiKey } : {}) },
        signal,
      }),
    enabled: args.enabled,
    staleTime: 60_000,
    gcTime: 0, // the typed key is part of the query key: do not keep it around
    retry: false,
  });
}

export function useAgentStatus(): UseQueryResult<AgentStatusResponse, ApiError> {
  return useQuery({
    queryKey: keys.agentStatus,
    queryFn: ({ signal }) => apiFetch<AgentStatusResponse>('/api/v1/agent/status', { signal }),
    staleTime: 10_000,
  });
}

export function useConversations(): UseQueryResult<{ conversations: AgentConversation[] }, ApiError> {
  return useQuery({
    queryKey: keys.conversations,
    queryFn: ({ signal }) =>
      apiFetch<{ conversations: AgentConversation[] }>('/api/v1/agent/conversations', { signal }),
  });
}

export function useDeleteConversation(): UseMutationResult<void, ApiError, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiFetch<void>(`/api/v1/agent/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.conversations }),
  });
}

export function fetchConversation(id: string): Promise<AgentConversationResponse> {
  return apiFetch<AgentConversationResponse>(`/api/v1/agent/conversations/${id}`);
}

export function useMemories(enabled = true): UseQueryResult<{ memories: AgentMemory[] }, ApiError> {
  return useQuery({
    queryKey: keys.memories,
    queryFn: ({ signal }) => apiFetch<{ memories: AgentMemory[] }>('/api/v1/agent/memories', { signal }),
    enabled,
  });
}

export function useAddMemory(): UseMutationResult<unknown, ApiError, { content: string; tags?: string[] }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch('/api/v1/agent/memories', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.memories }),
  });
}

export function useDeleteMemory(): UseMutationResult<void, ApiError, number> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiFetch<void>(`/api/v1/agent/memories/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.memories }),
  });
}

export function invalidateAgentData(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: keys.conversations });
  void qc.invalidateQueries({ queryKey: keys.memories });
  // The assistant can change findings and acknowledgements: refresh what the rest of the app shows.
  for (const k of ['findings', 'summary', 'overview', 'acks']) void qc.invalidateQueries({ queryKey: [k] });
}

// ---- streaming ------------------------------------------------------------------------------------------------------

/** Parses `data: {json}` blocks out of a text stream. Exported for tests. */
export function parseSseBlocks(buffer: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.search(/\r?\n\r?\n/)) !== -1) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx).replace(/^\r?\n\r?\n/, '');
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    try {
      events.push(JSON.parse(data) as AgentEvent);
    } catch {
      // ignore a malformed block
    }
  }
  return { events, rest };
}

/** Sends one chat request and reports every event as it arrives. Resolves when the stream ends. */
export async function streamAgent(
  body: AgentChatBody,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/v1/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) return;
    onEvent({ type: 'error', message: 'Cannot reach the dashboard server.' });
    void err;
    return;
  }
  if (res.status === 401) {
    authRedirect.go(loginUrl());
    return;
  }
  if (!res.ok || res.body === null) {
    let message = `The assistant could not start (HTTP ${res.status}).`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) message = j.message;
    } catch {
      // keep the generic message
    }
    onEvent({ type: 'error', message });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(buffer);
      buffer = parsed.rest;
      for (const e of parsed.events) onEvent(e);
    }
  } catch (err) {
    if (!signal?.aborted)
      onEvent({ type: 'error', message: 'The connection dropped while the assistant was answering.' });
    void err;
  }
}

import type { AgentEvent, AgentMessage, PendingApproval } from '@/shared/types/agent';

// The chat's view model: what the page shows, built from persisted messages and updated by streamed events.

export type ToolStatus = 'running' | 'awaiting' | 'ok' | 'error' | 'declined';

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      args: string;
      status: ToolStatus;
      summary: string | null;
      approval: PendingApproval | null;
    }
  | { kind: 'error'; id: string; message: string };

export interface ChatState {
  items: ChatItem[];
  busy: boolean;
  phase: 'idle' | 'thinking' | 'tool' | 'writing';
  label: string;
  pending: PendingApproval[];
}

export const initialChat: ChatState = { items: [], busy: false, phase: 'idle', label: '', pending: [] };

let counter = 0;
export const nextId = (p: string): string => `${p}-${++counter}`;

function statusOfResult(content: string | null): { status: ToolStatus; summary: string } {
  let parsed: unknown = null;
  try {
    parsed = content === null ? null : JSON.parse(content);
  } catch {
    // plain text result
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const o = parsed as Record<string, unknown>;
    if ('denied' in o) return { status: 'declined', summary: 'Declined' };
    if ('skipped' in o) return { status: 'declined', summary: 'Skipped' };
    if (typeof o.error === 'string') return { status: 'error', summary: o.error };
  }
  const text = content ?? '';
  return { status: 'ok', summary: text.length > 160 ? `${text.slice(0, 157)}…` : text };
}

/** Persisted messages to chat items; `pending` marks the calls that still wait for a decision. */
export function itemsFromMessages(messages: AgentMessage[], pending: PendingApproval[]): ChatItem[] {
  const results = new Map(
    messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => [m.toolCallId as string, m]),
  );
  const waiting = new Map(pending.map((p) => [p.callId, p]));
  const out: ChatItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ kind: 'user', id: `m${m.id}`, text: m.content ?? '' });
    else if (m.role === 'assistant') {
      if (m.content) out.push({ kind: 'assistant', id: `m${m.id}`, text: m.content, streaming: false });
      for (const c of m.toolCalls ?? []) {
        const r = results.get(c.id);
        const ap = waiting.get(c.id) ?? null;
        const res = r ? statusOfResult(r.content) : null;
        out.push({
          kind: 'tool',
          id: c.id,
          name: c.name,
          args: c.arguments,
          status: res ? res.status : ap ? 'awaiting' : 'error',
          summary: res ? res.summary : ap ? ap.summary : 'No result',
          approval: r ? null : ap,
        });
      }
    }
  }
  return out;
}

function finishStreaming(items: ChatItem[]): ChatItem[] {
  return items.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i));
}

/** Folds one streamed event into the state. Pure, so the whole state machine is unit tested. */
export function applyEvent(s: ChatState, e: AgentEvent): ChatState {
  switch (e.type) {
    case 'conversation':
      return s;
    case 'done':
      return { ...s, items: finishStreaming(s.items), busy: false, phase: 'idle', label: '' };
    case 'status':
      return { ...s, phase: e.phase, label: e.label };
    case 'delta': {
      const last = s.items.at(-1);
      if (last?.kind === 'assistant' && last.streaming) {
        return { ...s, items: [...s.items.slice(0, -1), { ...last, text: last.text + e.text }] };
      }
      return { ...s, items: [...s.items, { kind: 'assistant', id: nextId('a'), text: e.text, streaming: true }] };
    }
    case 'tool_call':
      return {
        ...s,
        items: [
          ...finishStreaming(s.items),
          {
            kind: 'tool',
            id: e.callId,
            name: e.name,
            args: e.arguments,
            status: 'running',
            summary: null,
            approval: null,
          },
        ],
      };
    case 'tool_result':
      return {
        ...s,
        items: s.items.map((i) =>
          i.kind === 'tool' && i.id === e.callId
            ? {
                ...i,
                status: e.ok ? 'ok' : /declined|skipped/i.test(e.summary) ? 'declined' : 'error',
                summary: e.summary,
                approval: null,
              }
            : i,
        ),
        pending: s.pending.filter((p) => p.callId !== e.callId),
      };
    case 'approval':
      return {
        ...s,
        pending: e.calls,
        items: s.items.map((i) => {
          const ap = e.calls.find((c) => c.callId === i.id);
          return i.kind === 'tool' && ap ? { ...i, status: 'awaiting', summary: ap.summary, approval: ap } : i;
        }),
      };
    case 'error':
      return {
        ...s,
        items: [...finishStreaming(s.items), { kind: 'error', id: nextId('e'), message: e.message }],
        busy: false,
        phase: 'idle',
        label: '',
      };
  }
}

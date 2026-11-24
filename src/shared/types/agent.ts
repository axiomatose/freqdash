import type { Ms } from './domain';

// Built-in assistant: persisted conversations and memories, and the events streamed to the browser.

export interface AgentToolCall {
  id: string;
  name: string;
  /** JSON text exactly as the model produced it. */
  arguments: string;
}

export interface AgentMessage {
  id: number;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls: AgentToolCall[] | null;
  toolCallId: string | null;
  /** Tool name, on `tool` messages. */
  name: string | null;
  createdAt: Ms;
}

export interface AgentConversation {
  id: string;
  title: string;
  createdAt: Ms;
  updatedAt: Ms;
}

export interface AgentMemory {
  id: number;
  content: string;
  tags: string[];
  conversationId: string | null;
  createdAt: Ms;
  updatedAt: Ms;
}

export type ToolRisk = 'read' | 'write' | 'danger';

export interface PendingApproval {
  callId: string;
  name: string;
  arguments: string;
  risk: Exclude<ToolRisk, 'read'>;
  /** Human-readable one-liner of what the action does. */
  summary: string;
}

/** Server-sent events of POST /api/v1/agent/chat. */
export type AgentEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'status'; phase: 'thinking' | 'tool' | 'writing'; label: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; name: string; ok: boolean; summary: string }
  | { type: 'approval'; calls: PendingApproval[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface AgentConversationResponse {
  conversation: AgentConversation;
  messages: AgentMessage[];
  /** Tool calls of the last assistant message that still wait for a decision. */
  pending: PendingApproval[];
}

export interface AgentChatBody {
  conversationId?: string;
  /** A new user message; omit when resuming after approvals. */
  message?: string;
  /** Decisions for the pending tool calls, keyed by call id. */
  approvals?: Record<string, 'approve' | 'deny'>;
}

export interface AgentStatusResponse {
  enabled: boolean;
  /** A key and a model are both set. */
  configured: boolean;
  model: string | null;
  autoApprove: boolean;
}

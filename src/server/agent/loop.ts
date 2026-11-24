import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { AgentEvent, AgentMessage, AgentToolCall, PendingApproval } from '@/shared/types/agent';
import { appendMessage, createConversation, getConversation, listMemories, listMessages } from '../db';
import { describeError, log } from '../log';
import { LlmError, streamChat, type ChatMessage } from './openai';
import { buildSystemPrompt, type PromptInput } from './prompt';
import { TOOL_BY_NAME, serializeResult, toolSpecs, type ToolContext, type ToolDef } from './tools';

// One assistant turn: call the model, run its tools, repeat until it answers. Every message is persisted, so a turn can
// pause for the owner's approval and resume later from the database alone.

export interface AgentSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  autoApprove: boolean;
  maxSteps: number;
  notes: string;
}

export interface AgentDeps {
  settings: AgentSettings;
  ctx: ToolContext;
  tools?: ReadonlyMap<string, ToolDef>;
  llm?: typeof streamChat;
  prompt: () => Pick<PromptInput, 'mode' | 'modeReason' | 'botNames'>;
  now?: () => number;
}

export interface RunInput {
  conversationId?: string | undefined;
  message?: string | undefined;
  approvals?: Record<string, 'approve' | 'deny'> | undefined;
}

const RECENT_KEEP = 40;
const OLD_RESULT_CHARS = 1_500;
const active = new Set<string>();

const LABEL: Record<string, string> = {
  get_summary: 'Checking the summary',
  get_overview: 'Reading the overview',
  get_bot: 'Looking at a bot',
  list_trades: 'Going through trades',
  list_kraken_orders: 'Checking Kraken orders',
  list_findings: 'Reading findings',
  get_finding: 'Reading a finding',
  get_equity: 'Looking at equity history',
  get_status: 'Checking data sources',
  get_killswitch: 'Checking the killswitch',
  list_acks: 'Reading acknowledgements',
  get_strategies: 'Reading strategies',
  get_chart: 'Looking at the chart',
  list_events: 'Reading bot events',
  recall_memories: 'Recalling memories',
  save_memory: 'Saving a memory',
  delete_memory: 'Forgetting a memory',
};
export const toolLabel = (name: string): string => LABEL[name] ?? 'Working';

/** Tool calls of the last assistant message that have no tool message yet. */
export function pendingCalls(messages: readonly AgentMessage[]): AgentToolCall[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
    if (messages[i]?.role === 'user') return [];
  }
  const calls = messages[lastAssistant]?.toolCalls;
  if (!calls) return [];
  const answered = new Set(messages.slice(lastAssistant + 1).map((m) => m.toolCallId));
  return calls.filter((c) => !answered.has(c.id));
}

function parseArgs(tool: ToolDef, raw: string): { ok: true; args: unknown } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return { ok: false, error: 'The arguments were not valid JSON.' };
  }
  const parsed = (tool.params as z.ZodType).safeParse(json);
  if (parsed.success) return { ok: true, args: parsed.data };
  return {
    ok: false,
    error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}`,
  };
}

function approvalFor(call: AgentToolCall, tool: ToolDef, args: unknown): PendingApproval {
  return {
    callId: call.id,
    name: call.name,
    arguments: call.arguments,
    risk: tool.risk === 'danger' ? 'danger' : 'write',
    summary: tool.summarize ? tool.summarize(args as never) : `Run ${call.name}`,
  };
}

/** Whether a call may run without asking. */
export function needsApproval(tool: ToolDef, autoApprove: boolean): boolean {
  if (tool.risk === 'read' || tool.alwaysAllowed) return false;
  if (tool.risk === 'danger') return true;
  return !autoApprove;
}

function toChat(messages: AgentMessage[]): ChatMessage[] {
  const recent = messages.slice(-RECENT_KEEP);
  // A tool result whose assistant message fell out of the window would be rejected by the API: drop such leftovers.
  while (recent.length > 0 && recent[0]?.role === 'tool') recent.shift();
  const keepFull = new Set(recent.slice(-6).map((m) => m.id));
  return recent.map((m): ChatMessage => {
    if (m.role === 'user') return { role: 'user', content: m.content ?? '' };
    if (m.role === 'tool') {
      const c = m.content ?? '';
      return {
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content:
          keepFull.has(m.id) || c.length <= OLD_RESULT_CHARS
            ? c
            : `${c.slice(0, OLD_RESULT_CHARS)}…[older result shortened]`,
      };
    }
    return {
      role: 'assistant',
      content: m.content,
      ...(m.toolCalls
        ? {
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: 'function' as const,
              function: { name: t.name, arguments: t.arguments },
            })),
          }
        : {}),
    };
  });
}

function resultSummary(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export async function* runAgent(input: RunInput, deps: AgentDeps, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const now = deps.now ?? Date.now;
  const tools = deps.tools ?? TOOL_BY_NAME;
  const llm = deps.llm ?? streamChat;
  const s = deps.settings;

  let conversationId = input.conversationId;
  if (conversationId !== undefined && getConversation(conversationId) === null) {
    yield { type: 'error', message: 'That conversation no longer exists.' };
    return;
  }
  if (conversationId === undefined) {
    if (!input.message?.trim()) {
      yield { type: 'error', message: 'Type a message to start.' };
      return;
    }
    const c = createConversation(randomUUID(), input.message, now());
    conversationId = c.id;
    yield { type: 'conversation', id: c.id, title: c.title };
  }
  if (active.has(conversationId)) {
    yield { type: 'error', message: 'This conversation is already busy. Wait for the current answer.' };
    return;
  }
  active.add(conversationId);
  const ctx: ToolContext = { ...deps.ctx, conversationId };

  try {
    let messages = listMessages(conversationId);
    let pending = pendingCalls(messages);

    if (input.message?.trim()) {
      // A new message while actions still wait: those actions are dropped, never run late.
      for (const c of pending) {
        appendMessage(
          conversationId,
          {
            role: 'tool',
            toolCallId: c.id,
            name: c.name,
            content: JSON.stringify({ skipped: 'The owner sent a new message instead of deciding.' }),
          },
          now(),
        );
        yield { type: 'tool_result', callId: c.id, name: c.name, ok: false, summary: 'Skipped' };
      }
      appendMessage(conversationId, { role: 'user', content: input.message.trim() }, now());
      pending = [];
    } else if (pending.length > 0) {
      const decisions = input.approvals ?? {};
      const stillWaiting: PendingApproval[] = [];
      for (const c of pending) {
        const tool = tools.get(c.name);
        const decision = decisions[c.id];
        if (tool === undefined || decision === undefined) {
          if (tool !== undefined) {
            const parsed = parseArgs(tool, c.arguments);
            if (parsed.ok) stillWaiting.push(approvalFor(c, tool, parsed.args));
          }
          continue;
        }
        if (decision === 'deny') {
          appendMessage(
            conversationId,
            {
              role: 'tool',
              toolCallId: c.id,
              name: c.name,
              content: JSON.stringify({ denied: 'The owner declined this action.' }),
            },
            now(),
          );
          yield { type: 'tool_result', callId: c.id, name: c.name, ok: false, summary: 'Declined' };
          continue;
        }
        const parsed = parseArgs(tool, c.arguments);
        yield { type: 'status', phase: 'tool', label: toolLabel(c.name) };
        let content: string;
        let ok = true;
        let summary = 'Done';
        if (!parsed.ok) {
          content = JSON.stringify({ error: parsed.error });
          ok = false;
          summary = parsed.error;
        } else {
          try {
            const value = await tool.run(parsed.args as never, ctx);
            content = serializeResult(value);
            summary = resultSummary(value);
          } catch (err) {
            ok = false;
            summary = describeError(err);
            content = JSON.stringify({ error: summary });
          }
        }
        appendMessage(conversationId, { role: 'tool', toolCallId: c.id, name: c.name, content }, now());
        yield { type: 'tool_result', callId: c.id, name: c.name, ok, summary };
      }
      if (stillWaiting.length > 0) {
        yield { type: 'approval', calls: stillWaiting };
        yield { type: 'done' };
        return;
      }
    }

    messages = listMessages(conversationId);
    if (messages.length === 0 || messages.at(-1)?.role === 'assistant') {
      yield { type: 'done' };
      return;
    }

    const specs = toolSpecs();
    for (let step = 0; step < s.maxSteps; step++) {
      yield { type: 'status', phase: 'thinking', label: 'Thinking' };
      const p = deps.prompt();
      const system = buildSystemPrompt({
        ...p,
        now: now(),
        notes: s.notes,
        memories: listMemories({ limit: 30 }),
        autoApprove: s.autoApprove,
      });
      const history = toChat(listMessages(conversationId));

      let text = '';
      let calls: AgentToolCall[] = [];
      let started = false;
      for await (const ev of llm({
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        messages: [{ role: 'system', content: system }, ...history],
        tools: specs,
        ...(signal ? { signal } : {}),
      })) {
        if (ev.type === 'text') {
          if (!started) {
            started = true;
            yield { type: 'status', phase: 'writing', label: 'Writing' };
          }
          text += ev.text;
          yield { type: 'delta', text: ev.text };
        } else {
          calls = ev.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
        }
      }
      appendMessage(conversationId, { role: 'assistant', content: text === '' ? null : text, toolCalls: calls }, now());
      if (calls.length === 0) {
        yield { type: 'done' };
        return;
      }

      const waiting: PendingApproval[] = [];
      for (const c of calls) {
        const tool = tools.get(c.name);
        yield { type: 'tool_call', callId: c.id, name: c.name, arguments: c.arguments };
        if (tool === undefined) {
          appendMessage(
            conversationId,
            {
              role: 'tool',
              toolCallId: c.id,
              name: c.name,
              content: JSON.stringify({ error: `Unknown tool ${c.name}.` }),
            },
            now(),
          );
          yield { type: 'tool_result', callId: c.id, name: c.name, ok: false, summary: 'Unknown tool' };
          continue;
        }
        const parsed = parseArgs(tool, c.arguments);
        if (!parsed.ok) {
          appendMessage(
            conversationId,
            { role: 'tool', toolCallId: c.id, name: c.name, content: JSON.stringify({ error: parsed.error }) },
            now(),
          );
          yield { type: 'tool_result', callId: c.id, name: c.name, ok: false, summary: parsed.error };
          continue;
        }
        if (needsApproval(tool, s.autoApprove)) {
          waiting.push(approvalFor(c, tool, parsed.args));
          continue;
        }
        yield { type: 'status', phase: 'tool', label: toolLabel(c.name) };
        let content: string;
        let ok = true;
        let summary: string;
        try {
          const value = await tool.run(parsed.args as never, ctx);
          content = serializeResult(value);
          summary = resultSummary(value);
        } catch (err) {
          ok = false;
          summary = describeError(err);
          content = JSON.stringify({ error: summary });
        }
        appendMessage(conversationId, { role: 'tool', toolCallId: c.id, name: c.name, content }, now());
        yield { type: 'tool_result', callId: c.id, name: c.name, ok, summary };
      }
      if (waiting.length > 0) {
        yield { type: 'approval', calls: waiting };
        yield { type: 'done' };
        return;
      }
    }
    yield {
      type: 'error',
      message: `I stopped after ${s.maxSteps} steps without finishing. Ask me to continue, or narrow the question.`,
    };
  } catch (err) {
    if (signal?.aborted) return;
    log.warn('assistant turn failed', { err: describeError(err) });
    yield {
      type: 'error',
      message: err instanceof LlmError ? err.message : `Something went wrong: ${describeError(err)}`,
    };
  } finally {
    active.delete(conversationId);
  }
}

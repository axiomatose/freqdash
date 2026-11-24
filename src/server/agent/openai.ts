import { describeError, redactSecrets } from '../log';

// Minimal client for OpenAI-compatible Chat Completions with streaming and tool calls. No SDK on purpose: the endpoint
// is configurable (OpenAI, Azure-style gateways, local servers) and only a small part of the protocol is needed.

export interface ChatToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type LlmEvent =
  { type: 'text'; text: string } | { type: 'done'; toolCalls: LlmToolCall[]; finishReason: string | null };

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolSpec[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** `data:` payloads of a server-sent-events body. Tolerates CRLF, comments and events split across chunks. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data !== '') yield data;
      }
    }
    const rest = buffer
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (rest !== '') yield rest;
  } finally {
    reader.releaseLock();
  }
}

interface Delta {
  content?: string | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}
interface Chunk {
  choices?: { delta?: Delta; finish_reason?: string | null }[];
  error?: { message?: string };
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

async function failureMessage(res: Response): Promise<string> {
  let detail = '';
  try {
    const j = (await res.json()) as { error?: { message?: string } | string };
    detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? '');
  } catch {
    // not JSON
  }
  const base = res.status === 401 || res.status === 403 ? 'The API rejected the key' : `The API answered ${res.status}`;
  return redactSecrets(detail ? `${base}: ${detail.slice(0, 300)}` : base);
}

/** Streams one model turn: text deltas as they arrive, then the tool calls (if any) once complete. */
export async function* streamChat(o: ChatOptions): AsyncGenerator<LlmEvent> {
  const f = o.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 120_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await f(endpoint(o.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({
        model: o.model,
        messages: o.messages,
        stream: true,
        ...(o.tools && o.tools.length > 0 ? { tools: o.tools, tool_choice: 'auto' } : {}),
      }),
      signal,
    });
  } catch (err) {
    throw new LlmError(`Could not reach the API: ${describeError(err)}`);
  }
  if (!res.ok) throw new LlmError(await failureMessage(res), res.status);
  if (res.body === null) throw new LlmError('The API returned no body');

  const calls = new Map<number, LlmToolCall>();
  let finish: string | null = null;
  try {
    for await (const data of sseData(res.body)) {
      if (data.trim() === '[DONE]') break;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new LlmError(redactSecrets(chunk.error.message ?? 'The API reported an error'));
      const choice = chunk.choices?.[0];
      if (choice === undefined) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) yield { type: 'text', text: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(i, cur);
      }
    }
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError(`The connection to the API broke: ${describeError(err)}`);
  }
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ ...c, id: c.id || `call_${i}_${Date.now().toString(36)}` }))
    .filter((c) => c.name !== '');
  yield { type: 'done', toolCalls, finishReason: finish };
}

/** One small non-streaming request, used by the "Test connection" button. */
export async function pingModel(
  o: Omit<ChatOptions, 'messages' | 'tools'>,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  try {
    let reply = '';
    for await (const ev of streamChat({
      ...o,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      timeoutMs: 30_000,
    })) {
      if (ev.type === 'text') reply += ev.text;
    }
    return { ok: true, reply: reply.trim().slice(0, 80) };
  } catch (err) {
    return { ok: false, error: err instanceof LlmError ? err.message : describeError(err) };
  }
}

/** The model ids the provider offers (`GET {baseUrl}/models`). Tolerates `{data:[...]}`, `{models:[...]}` and a bare array. */
export async function listModels(o: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const f = o.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(15_000);
  try {
    const res = await f(`${o.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${o.apiKey}` },
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    });
    if (!res.ok) return { ok: false, error: await failureMessage(res) };
    const j = (await res.json()) as unknown;
    const list = Array.isArray(j)
      ? j
      : Array.isArray((j as { data?: unknown }).data)
        ? (j as { data: unknown[] }).data
        : Array.isArray((j as { models?: unknown }).models)
          ? (j as { models: unknown[] }).models
          : [];
    const ids = new Set<string>();
    for (const m of list) {
      const id =
        typeof m === 'string' ? m : ((m as { id?: unknown; name?: unknown }).id ?? (m as { name?: unknown }).name);
      if (typeof id === 'string' && id.trim() !== '') ids.add(id.replace(/^models\//, '').trim());
    }
    return { ok: true, models: [...ids].sort((a, b) => a.localeCompare(b)).slice(0, 500) };
  } catch (err) {
    return { ok: false, error: `Could not load the model list: ${redactSecrets(describeError(err))}` };
  }
}

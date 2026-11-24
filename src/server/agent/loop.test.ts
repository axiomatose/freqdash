import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentEvent } from '@/shared/types/agent';
import { closeDb } from '../db/client';
import { listMemories, listMessages } from '../db';
import { installTempDb, type TempDb } from '../db/testing';
import { needsApproval, pendingCalls, runAgent, type AgentDeps, type RunInput } from './loop';
import { LlmError, type ChatMessage, type LlmEvent, type LlmToolCall } from './openai';
import { defineTool, type ToolDef } from './tools';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => {
  temp.cleanup();
  closeDb();
});

const ran: string[] = [];
const tools = new Map<string, ToolDef>(
  [
    defineTool({
      name: 'get_thing',
      description: 'd',
      risk: 'read',
      params: z.object({ id: z.number().default(1) }),
      run: (a) => (ran.push(`get_thing:${a.id}`), { thing: a.id }),
    }),
    defineTool({
      name: 'silence_it',
      description: 'd',
      risk: 'write',
      params: z.object({ id: z.number() }),
      summarize: (a) => `Silence #${a.id}`,
      run: (a) => (ran.push(`silence_it:${a.id}`), { silenced: a.id }),
    }),
    defineTool({
      name: 'reset_it',
      description: 'd',
      risk: 'danger',
      params: z.object({}),
      summarize: () => 'Reset',
      run: () => (ran.push('reset_it'), { reset: true }),
    }),
    defineTool({
      name: 'note_it',
      description: 'd',
      risk: 'write',
      alwaysAllowed: true,
      params: z.object({ text: z.string() }),
      run: (a) => (ran.push(`note_it:${a.text}`), { ok: true }),
    }),
    defineTool({
      name: 'boom',
      description: 'd',
      risk: 'read',
      params: z.object({}),
      run: () => {
        throw new Error('exploded');
      },
    }),
  ].map((t) => [t.name, t]),
);

const call = (id: string, name: string, args: unknown = {}): LlmToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
type Script = (LlmEvent[] | Error)[];

function fakeLlm(script: Script) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const llm = async function* (o: { messages: ChatMessage[] }): AsyncGenerator<LlmEvent> {
    seen.push(o.messages);
    const step = script[i++];
    if (step === undefined) throw new Error('script exhausted');
    if (step instanceof Error) throw step;
    for (const e of step) yield e;
  };
  return { llm: llm as unknown as AgentDeps['llm'], seen };
}
const say = (text: string): LlmEvent[] => [
  { type: 'text', text },
  { type: 'done', toolCalls: [], finishReason: 'stop' },
];
const use = (...calls: LlmToolCall[]): LlmEvent[] => [{ type: 'done', toolCalls: calls, finishReason: 'tool_calls' }];

function deps(llm: AgentDeps['llm'], over: Partial<AgentDeps['settings']> = {}): AgentDeps {
  return {
    settings: {
      baseUrl: 'https://x/v1',
      apiKey: 'k'.repeat(10),
      model: 'm',
      autoApprove: false,
      maxSteps: 6,
      notes: '',
      ...over,
    },
    ctx: { view: () => ({}) as never, now: () => 1000, conversationId: null, by: 'Ada' },
    tools,
    llm,
    prompt: () => ({ mode: 'kraken', modeReason: null, botNames: ['VoteMax'] }),
    now: () => 1000,
  };
}
async function run(input: RunInput, d: AgentDeps): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of runAgent(input, d)) out.push(e);
  return out;
}
const conv = (events: AgentEvent[]) => (events.find((e) => e.type === 'conversation') as { id: string }).id;
const types = (events: AgentEvent[]) => events.map((e) => e.type);

beforeEach(() => {
  ran.length = 0;
});

describe('runAgent', () => {
  it('answers, streams the text and stores the conversation', async () => {
    const { llm, seen } = fakeLlm([say('Hello there')]);
    const events = await run({ message: 'hi' }, deps(llm));
    expect(types(events)).toEqual(['conversation', 'status', 'status', 'delta', 'done']);
    const msgs = listMessages(conv(events));
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there'],
    ]);
    expect(seen[0]?.[0]).toMatchObject({ role: 'system' });
    expect((seen[0]?.[0] as { content: string }).content).toContain('Data mode: kraken');
  });

  it('runs read tools immediately and feeds the result back to the model', async () => {
    const { llm, seen } = fakeLlm([use(call('c1', 'get_thing', { id: 7 })), say('It is 7.')]);
    const events = await run({ message: 'what is the thing' }, deps(llm));
    expect(ran).toEqual(['get_thing:7']);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, name: 'get_thing' });
    const second = seen[1]!;
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: '{"thing":7}' });
    expect(listMessages(conv(events)).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('holds a write action for approval, then runs it on approve and continues', async () => {
    const { llm } = fakeLlm([use(call('c1', 'silence_it', { id: 3 })), say('Silenced.')]);
    const d = deps(llm);
    const first = await run({ message: 'silence 3' }, d);
    expect(ran).toEqual([]);
    expect(first.find((e) => e.type === 'approval')).toMatchObject({
      calls: [{ callId: 'c1', risk: 'write', summary: 'Silence #3' }],
    });
    expect(types(first).at(-1)).toBe('done');

    const id = conv(first);
    expect(pendingCalls(listMessages(id)).map((c) => c.id)).toEqual(['c1']);
    const second = await run({ conversationId: id, approvals: { c1: 'approve' } }, d);
    expect(ran).toEqual(['silence_it:3']);
    expect(second.find((e) => e.type === 'delta')).toMatchObject({ text: 'Silenced.' });
    expect(pendingCalls(listMessages(id))).toEqual([]);
  });

  it('a denied action never runs, and the model is told', async () => {
    const { llm, seen } = fakeLlm([use(call('c1', 'silence_it', { id: 3 })), say('Okay, left alone.')]);
    const d = deps(llm);
    const id = conv(await run({ message: 'silence 3' }, d));
    await run({ conversationId: id, approvals: { c1: 'deny' } }, d);
    expect(ran).toEqual([]);
    expect(seen[1]?.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('declined') });
  });

  it('auto-approve runs writes but never danger tools', async () => {
    const { llm } = fakeLlm([use(call('c1', 'silence_it', { id: 1 }), call('c2', 'reset_it')), say('unused')]);
    const events = await run({ message: 'go' }, deps(llm, { autoApprove: true }));
    expect(ran).toEqual(['silence_it:1']);
    expect(events.find((e) => e.type === 'approval')).toMatchObject({ calls: [{ callId: 'c2', risk: 'danger' }] });
    expect(needsApproval(tools.get('reset_it')!, true)).toBe(true);
    expect(needsApproval(tools.get('silence_it')!, true)).toBe(false);
    expect(needsApproval(tools.get('silence_it')!, false)).toBe(true);
    expect(needsApproval(tools.get('note_it')!, false)).toBe(false);
    expect(needsApproval(tools.get('get_thing')!, false)).toBe(false);
  });

  it('saves-style tools that are always allowed run without asking', async () => {
    const { llm } = fakeLlm([use(call('c1', 'note_it', { text: 'x' })), say('Noted.')]);
    await run({ message: 'remember x' }, deps(llm));
    expect(ran).toEqual(['note_it:x']);
  });

  it('a new message drops the actions that were still waiting', async () => {
    const { llm } = fakeLlm([use(call('c1', 'silence_it', { id: 3 })), say('Fine.')]);
    const d = deps(llm);
    const id = conv(await run({ message: 'silence 3' }, d));
    await run({ conversationId: id, message: 'actually never mind' }, d);
    expect(ran).toEqual([]);
    const msgs = listMessages(id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    expect(msgs[2]?.content).toContain('skipped');
  });

  it('reports invalid arguments, unknown tools and throwing tools back to the model without crashing', async () => {
    const { llm, seen } = fakeLlm([
      use(call('a', 'silence_it', { id: 'nope' }), call('b', 'nothing'), call('c', 'boom')),
      say('done'),
    ]);
    const events = await run({ message: 'go' }, deps(llm));
    const results = events.filter((e) => e.type === 'tool_result') as { ok: boolean; summary: string }[];
    expect(results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(results[0]?.summary).toMatch(/Invalid arguments/);
    expect(results[2]?.summary).toContain('exploded');
    expect(seen[1]?.filter((m) => m.role === 'tool')).toHaveLength(3);
    expect(ran).toEqual([]);
  });

  it('stops after maxSteps with a clear message', async () => {
    const { llm } = fakeLlm([use(call('1', 'get_thing')), use(call('2', 'get_thing')), use(call('3', 'get_thing'))]);
    const events = await run({ message: 'loop' }, deps(llm, { maxSteps: 3 }));
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('3 steps') });
  });

  it('turns model errors into an error event and keeps the user message for a retry', async () => {
    const d = deps(fakeLlm([new LlmError('The API rejected the key', 401)]).llm);
    const events = await run({ message: 'hi' }, d);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'The API rejected the key' });
    const id = conv(events);
    expect(listMessages(id).map((m) => m.role)).toEqual(['user']);
    const retry = await run({ conversationId: id }, deps(fakeLlm([say('back')]).llm));
    expect(retry.find((e) => e.type === 'delta')).toMatchObject({ text: 'back' });
  });

  it('rejects an unknown conversation, an empty start, and a second run on a busy conversation', async () => {
    const { llm } = fakeLlm([say('x')]);
    expect((await run({ conversationId: 'nope', message: 'hi' }, deps(llm)))[0]).toMatchObject({ type: 'error' });
    expect((await run({}, deps(llm)))[0]).toMatchObject({ type: 'error' });

    const first = await run({ message: 'start' }, deps(fakeLlm([say('ok')]).llm));
    const cid = conv(first);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async function* (): AsyncGenerator<LlmEvent> {
      await gate;
      yield* say('late');
    } as unknown as AgentDeps['llm'];
    const a = run({ conversationId: cid, message: 'slow one' }, deps(slow));
    await new Promise((r) => setTimeout(r, 20));
    const b = await run({ conversationId: cid, message: 'twice' }, deps(fakeLlm([say('x')]).llm));
    expect(b[0]).toMatchObject({ type: 'error', message: expect.stringContaining('busy') });
    release();
    await a;
    // Once the first run is over the conversation is free again.
    const c = await run({ conversationId: cid, message: 'thrice' }, deps(fakeLlm([say('y')]).llm));
    expect(c.find((e) => e.type === 'delta')).toMatchObject({ text: 'y' });
  });

  it('saves a memory through the real tool path and shows it in the next prompt', async () => {
    const { addMemory } = await import('../db');
    addMemory({ content: 'Owner prefers short answers' }, 5);
    const { llm, seen } = fakeLlm([say('ok')]);
    await run({ message: 'hi' }, deps(llm));
    expect((seen[0]?.[0] as { content: string }).content).toContain('Owner prefers short answers');
    expect(listMemories()).toHaveLength(1);
  });

  it('trims long histories without starting on a tool message', async () => {
    const d = deps(fakeLlm(Array.from({ length: 1 }, () => say('x'))).llm);
    const id = conv(await run({ message: 'first' }, d));
    const { appendMessage } = await import('../db');
    for (let i = 0; i < 60; i++) {
      appendMessage(
        id,
        { role: 'assistant', content: `a${i}`, toolCalls: [{ id: `t${i}`, name: 'get_thing', arguments: '{}' }] },
        2000 + i,
      );
      appendMessage(id, { role: 'tool', toolCallId: `t${i}`, name: 'get_thing', content: 'r'.repeat(3000) }, 2000 + i);
    }
    appendMessage(id, { role: 'assistant', content: 'end' }, 3000);
    const { llm, seen } = fakeLlm([say('after')]);
    await run({ conversationId: id, message: 'next' }, deps(llm));
    const sent = seen[0]!.slice(1);
    expect(sent[0]?.role).not.toBe('tool');
    expect(sent.length).toBeLessThanOrEqual(41);
    expect(sent.length).toBeGreaterThan(30);
    const shortened = sent.filter((m) => m.role === 'tool' && (m as { content: string }).content.includes('shortened'));
    expect(shortened.length).toBeGreaterThan(0);
  });
});

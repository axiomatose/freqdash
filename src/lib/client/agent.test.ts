import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@/shared/types/agent';
import { parseSseBlocks, streamAgent } from './agent';

const enc = new TextEncoder();
const sse = (e: AgentEvent) => `data: ${JSON.stringify(e)}\n\n`;
function stream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('parseSseBlocks', () => {
  it('returns complete events and keeps the partial rest', () => {
    const a = sse({ type: 'delta', text: 'a' });
    const r = parseSseBlocks(`${a}data: {"type":"del`);
    expect(r.events).toEqual([{ type: 'delta', text: 'a' }]);
    expect(r.rest).toBe('data: {"type":"del');
    expect(parseSseBlocks(`${r.rest}ta","text":"b"}\n\n`).events).toEqual([{ type: 'delta', text: 'b' }]);
  });

  it('skips malformed blocks and handles CRLF', () => {
    expect(parseSseBlocks('data: not json\r\n\r\ndata: {"type":"done"}\r\n\r\n').events).toEqual([{ type: 'done' }]);
  });
});

describe('streamAgent', () => {
  it('delivers events across chunk boundaries', async () => {
    const full = sse({ type: 'delta', text: 'Hi' }) + sse({ type: 'done' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream([full.slice(0, 10), full.slice(10)]), { status: 200 })),
    );
    const seen: AgentEvent[] = [];
    await streamAgent({ message: 'x' }, (e) => seen.push(e));
    expect(seen).toEqual([{ type: 'delta', text: 'Hi' }, { type: 'done' }]);
  });

  it('reports an HTTP error with the server message, and a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'unavailable', message: 'The assistant is turned off.' }), {
            status: 409,
          }),
      ),
    );
    const a: AgentEvent[] = [];
    await streamAgent({ message: 'x' }, (e) => a.push(e));
    expect(a).toEqual([{ type: 'error', message: 'The assistant is turned off.' }]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('failed'))),
    );
    const b: AgentEvent[] = [];
    await streamAgent({ message: 'x' }, (e) => b.push(e));
    expect(b[0]).toMatchObject({ type: 'error' });
  });

  it('sends JSON with the body it was given', async () => {
    const f = vi.fn(async () => new Response(stream([sse({ type: 'done' })]), { status: 200 }));
    vi.stubGlobal('fetch', f);
    await streamAgent({ conversationId: 'c', approvals: { a: 'approve' } }, () => {});
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ conversationId: 'c', approvals: { a: 'approve' } });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});

import { describe, expect, it } from 'vitest';
import { LlmError, listModels, pingModel, sseData, streamChat, type LlmEvent } from './openai';

const enc = new TextEncoder();
function body(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const respond = (chunks: string[], status = 200) =>
  (async () =>
    new Response(status === 200 ? body(chunks) : JSON.stringify({ error: { message: 'bad things' } }), {
      status,
    })) as unknown as typeof fetch;

async function collect(gen: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const base = {
  baseUrl: 'https://api.example/v1/',
  apiKey: 'sk-test-key-1234',
  model: 'm',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('sseData', () => {
  it('splits events across chunks, handles CRLF, comments and a trailing event', async () => {
    const out: string[] = [];
    for await (const d of sseData(body(['data: {"a":1}\r\n\r\n: keep-alive\n\ndat', 'a: {"b":2}\n\ndata: tail'])))
      out.push(d);
    expect(out).toEqual(['{"a":1}', '{"b":2}', 'tail']);
  });
});

describe('streamChat', () => {
  it('yields text deltas then a done event', async () => {
    const events = await collect(
      streamChat({
        ...base,
        fetchImpl: respond([
          sse({ choices: [{ delta: { content: 'Hel' } }] }),
          sse({ choices: [{ delta: { content: 'lo' } }] }),
          sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ]),
      }),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'done', toolCalls: [], finishReason: 'stop' },
    ]);
  });

  it('assembles tool calls that arrive in fragments, in index order', async () => {
    const events = await collect(
      streamChat({
        ...base,
        fetchImpl: respond([
          sse({
            choices: [
              { delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'get_status', arguments: '{}' } }] } },
            ],
          }),
          sse({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_bo', arguments: '{"botId":' } }] } },
            ],
          }),
          sse({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { name: 't', arguments: '"dca"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          'data: [DONE]\n\n',
        ]),
      }),
    );
    expect(events.at(-1)).toEqual({
      type: 'done',
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'c1', name: 'get_bot', arguments: '{"botId":"dca"}' },
        { id: 'c2', name: 'get_status', arguments: '{}' },
      ],
    });
  });

  it('sends the key as a bearer token, joins the URL, and includes tools only when given', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(body(['data: [DONE]\n\n']));
    }) as unknown as typeof fetch;
    await collect(streamChat({ ...base, fetchImpl }));
    expect(seen!.url).toBe('https://api.example/v1/chat/completions');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key-1234');
    expect(JSON.parse(seen!.init.body as string)).not.toHaveProperty('tools');
    await collect(
      streamChat({
        ...base,
        fetchImpl,
        tools: [{ type: 'function', function: { name: 'x', description: 'd', parameters: {} } }],
      }),
    );
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ tool_choice: 'auto', stream: true });
  });

  it('turns HTTP failures into LlmError with a safe message', async () => {
    await expect(collect(streamChat({ ...base, fetchImpl: respond([], 401) }))).rejects.toThrow(
      /rejected the key: bad things/,
    );
    await expect(collect(streamChat({ ...base, fetchImpl: respond([], 500) }))).rejects.toMatchObject({ status: 500 });
    const failing = (async () => {
      throw new Error('ECONNREFUSED sk-test-key-1234');
    }) as unknown as typeof fetch;
    const err = await collect(streamChat({ ...base, fetchImpl: failing })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
  });

  it('surfaces an error object inside the stream', async () => {
    await expect(
      collect(streamChat({ ...base, fetchImpl: respond([sse({ error: { message: 'overloaded' } })]) })),
    ).rejects.toThrow('overloaded');
  });
});

describe('pingModel', () => {
  it('reports the reply, or the error', async () => {
    expect(
      await pingModel({
        ...base,
        fetchImpl: respond([sse({ choices: [{ delta: { content: 'ready' } }] }), 'data: [DONE]\n\n']),
      }),
    ).toEqual({ ok: true, reply: 'ready' });
    const r = await pingModel({ ...base, fetchImpl: respond([], 401) });
    expect(r.ok).toBe(false);
  });
});

describe('listModels', () => {
  const json = (o: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(o), { status })) as unknown as typeof fetch;
  const args = { baseUrl: 'https://api.example/v1/', apiKey: 'sk-test-key-1234' };

  it('reads OpenAI-style, {models} and bare-array lists, sorted, de-duplicated and without a models/ prefix', async () => {
    expect(await listModels({ ...args, fetchImpl: json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }) })).toEqual({
      ok: true,
      models: ['a', 'b'],
    });
    expect(await listModels({ ...args, fetchImpl: json({ models: [{ name: 'models/gem-1' }] }) })).toEqual({
      ok: true,
      models: ['gem-1'],
    });
    expect(await listModels({ ...args, fetchImpl: json(['x', 'y']) })).toEqual({ ok: true, models: ['x', 'y'] });
  });

  it('calls {baseUrl}/models with the key', async () => {
    let seen: { url: string; auth: string } | null = null;
    await listModels({
      ...args,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, auth: (init.headers as Record<string, string>).Authorization as string };
        return new Response('{"data":[]}');
      }) as unknown as typeof fetch,
    });
    expect(seen).toEqual({ url: 'https://api.example/v1/models', auth: 'Bearer sk-test-key-1234' });
  });

  it('reports a rejected key and an unreachable host without leaking the key', async () => {
    const bad = await listModels({ ...args, fetchImpl: json({ error: { message: 'no' } }, 401) });
    expect(bad).toEqual({ ok: false, error: 'The API rejected the key: no' });
    const down = await listModels({
      ...args,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(down.ok).toBe(false);
  });
});

// A scripted stand-in for an OpenAI-compatible chat completions endpoint (POST /openai/v1/chat/completions).
// It streams like the real thing (SSE, tool calls, small delays) so the assistant UI can be exercised end to end
// without a key. The "model" is a few keyword rules over the last user message; nothing here is intelligent.
//
//   "silence"    -> asks to call silence_finding {id:1}            (a write: the UI must ask for approval)
//   "remember"   -> calls save_memory                              (runs without asking)
//   "reset"      -> calls reset_killswitch                         (danger: always asks)
//   "wrong|status|bots|balance|anything" -> calls get_summary, then answers with a small table
//   anything else -> a short streamed answer
// After a tool result the reply is a short markdown summary that mentions what came back.

const REQUIRED_KEY = /^Bearer\s+\S{8,}$/;

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function lastOf(messages, role) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === role) return messages[i];
  return null;
}

function plan(messages) {
  const last = messages.at(-1);
  if (last?.role === 'tool') {
    const call = lastOf(messages.slice(0, -1), 'assistant')?.tool_calls?.find((c) => c.id === last.tool_call_id);
    const name = call?.function?.name ?? 'tool';
    let data = {};
    try {
      data = JSON.parse(last.content);
    } catch {
      // plain text
    }
    if (name === 'get_summary') {
      const f = data.findings ?? {};
      const bots = (data.bots ?? []).map((b) => `| ${b.name} | ${b.status} |`).join('\n');
      return {
        text:
          `Here is where things stand (mode: **${data.mode ?? 'unknown'}**).\n\n` +
          `- Critical findings: **${f.critical ?? 0}**, warnings: **${f.warning ?? 0}**\n` +
          `- Account total: **$${(data.accountTotalUsd ?? 0).toFixed(2)}**\n\n` +
          `| Bot | Status |\n|---|---|\n${bots}\n\nWant me to look into any of it?`,
      };
    }
    if (last.content.includes('declined')) return { text: 'Okay, I left it alone.' };
    return { text: `Done. The result: \`${last.content.slice(0, 120)}\`` };
  }
  const q = (lastOf(messages, 'user')?.content ?? '').toLowerCase();
  const call = (name, args) => ({ tool: { name, arguments: JSON.stringify(args) } });
  if (q.includes('reset')) return call('reset_killswitch', {});
  if (q.includes('silence')) return call('silence_finding', { id: 1, note: 'checked, expected' });
  if (q.includes('remember'))
    return call('save_memory', { content: 'The owner asked me to remember this setup detail.', tags: ['prefs'] });
  if (/wrong|status|bots|balance|anything|how/.test(q)) return call('get_summary', {});
  return {
    text: 'I can look at your bots, the Kraken account, fees and findings. Ask me something specific and I will check the live data first.',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openaiChat(req, res, body, send) {
  if (!REQUIRED_KEY.test(req.headers.authorization ?? '')) {
    return send(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } });
  }
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return send(res, 400, { error: { message: 'invalid JSON' } });
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const p = plan(messages);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  await sleep(700); // a visible "thinking" moment
  if (p.tool) {
    res.write(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${Date.now().toString(36)}`,
            type: 'function',
            function: { name: p.tool.name, arguments: '' },
          },
        ],
      }),
    );
    const args = p.tool.arguments;
    for (let i = 0; i < args.length; i += 12) {
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 12) } }] }));
      await sleep(20);
    }
    res.write(chunk({}, 'tool_calls'));
  } else {
    const words = p.text.split(/(?<=\s)/);
    for (const w of words) {
      res.write(chunk({ content: w }));
      await sleep(35);
    }
    res.write(chunk({}, 'stop'));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function openaiModels(req, res, send) {
  if (!REQUIRED_KEY.test(req.headers.authorization ?? '')) {
    return send(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } });
  }
  return send(res, 200, {
    object: 'list',
    data: [
      { id: 'mock-large', object: 'model' },
      { id: 'mock-small', object: 'model' },
    ],
  });
}

import { z } from 'zod';
import { withAuth, apiError } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { runAgent } from '@/server/agent/loop';
import { agentDeps, loadAgentSettings } from '@/server/agent/service';
import { isResponse, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';
// A long answer streams for a while; never let the platform cut the response short.
export const maxDuration = 300;

const body = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8000).optional(),
  approvals: z.record(z.string().max(100), z.enum(['approve', 'deny'])).optional(),
});

export const POST = withAuth(
  async (req, { session }) => {
    const denied = forbidAgentToken(session);
    if (denied) return denied;
    const parsed = await parseBody(req, body);
    if (isResponse(parsed)) return parsed;
    const loaded = loadAgentSettings();
    if (!loaded.ok) {
      return apiError(
        409,
        'unavailable',
        loaded.reason === 'disabled'
          ? 'The assistant is turned off. Enable it in Settings.'
          : loaded.reason === 'no-key'
            ? 'The assistant has no API key yet. Add one in Settings.'
            : 'No model is chosen yet. Pick one in Settings.',
      );
    }

    const controller = new AbortController();
    req.signal.addEventListener('abort', () => controller.abort());
    const encoder = new TextEncoder();
    const events = runAgent(parsed, agentDeps(loaded.settings, session.n), controller.signal);
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        try {
          for await (const ev of events) c.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // the client went away or the turn failed after it had started: nothing left to tell anyone
        } finally {
          try {
            c.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        controller.abort();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  },
  { mutating: true },
);

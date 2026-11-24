import { z } from 'zod';
import { apiError, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { MemoryLimitError, addMemory, listMemories } from '@/server/db';
import { isResponse, ok, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';

export const GET = withAuth((_req, { session }) => forbidAgentToken(session) ?? ok({ memories: listMemories() }));

const body = z.object({
  content: z.string().trim().min(1).max(1500),
  tags: z.array(z.string().max(30)).max(8).optional(),
});

export const POST = withAuth(
  async (req, { session }) => {
    const denied = forbidAgentToken(session);
    if (denied) return denied;
    const parsed = await parseBody(req, body);
    if (isResponse(parsed)) return parsed;
    try {
      return ok({
        memory: addMemory({ content: parsed.content, ...(parsed.tags ? { tags: parsed.tags } : {}) }, Date.now()),
      });
    } catch (err) {
      if (err instanceof MemoryLimitError) return apiError(409, 'bad_request', err.message);
      throw err;
    }
  },
  { mutating: true },
);

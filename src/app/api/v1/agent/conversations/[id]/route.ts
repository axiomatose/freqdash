import { apiError, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { pendingCalls } from '@/server/agent/loop';
import { TOOL_BY_NAME } from '@/server/agent/tools';
import { deleteConversation, getConversation, listMessages } from '@/server/db';
import { ok } from '@/server/views/http';
import type { AgentConversationResponse, PendingApproval } from '@/shared/types/agent';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

export const GET = withAuth<{ id: string }>(async (_req, { params, session }) => {
  const denied = forbidAgentToken(session);
  if (denied) return denied;
  const { id } = await params;
  const conversation = UUID.test(id) ? getConversation(id) : null;
  if (conversation === null) return apiError(404, 'not_found', 'unknown conversation');
  const messages = listMessages(id);
  const pending: PendingApproval[] = pendingCalls(messages).flatMap((c) => {
    const tool = TOOL_BY_NAME.get(c.name);
    if (tool === undefined || tool.risk === 'read') return [];
    let summary = `Run ${c.name}`;
    try {
      summary = tool.summarize ? tool.summarize(JSON.parse(c.arguments || '{}') as never) : summary;
    } catch {
      // keep the generic summary
    }
    return [
      {
        callId: c.id,
        name: c.name,
        arguments: c.arguments,
        risk: tool.risk === 'danger' ? ('danger' as const) : ('write' as const),
        summary,
      },
    ];
  });
  const body: AgentConversationResponse = { conversation, messages, pending };
  return ok(body);
});

export const DELETE = withAuth<{ id: string }>(
  async (_req, { params, session }) => {
    const denied = forbidAgentToken(session);
    if (denied) return denied;
    const { id } = await params;
    if (!UUID.test(id) || !deleteConversation(id)) return apiError(404, 'not_found', 'unknown conversation');
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  },
  { mutating: true },
);

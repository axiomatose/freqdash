import { withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { getSetting } from '@/server/settings';
import { ok } from '@/server/views/http';
import type { AgentStatusResponse } from '@/shared/types/agent';

export const dynamic = 'force-dynamic';

export const GET = withAuth((_req, { session }) => {
  const denied = forbidAgentToken(session);
  if (denied) return denied;
  const model = getSetting('agent.model');
  const body: AgentStatusResponse = {
    enabled: getSetting('agent.enabled'),
    configured: getSetting('agent.apiKey') !== null && model !== null,
    model,
    autoApprove: getSetting('agent.autoApprove'),
  };
  return ok(body);
});

import { z } from 'zod';
import { apiError, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { listModels } from '@/server/agent/openai';
import { getSetting } from '@/server/settings';
import { SETTING_DEFS } from '@/server/settings/registry';
import { isResponse, ok, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';

// The provider's model list for the endpoint in the form; the saved key is used when none is typed (it never goes to the browser).
const body = z.object({
  baseUrl: SETTING_DEFS['agent.baseUrl'].schema.optional(),
  apiKey: SETTING_DEFS['agent.apiKey'].schema.optional(),
});

export const POST = withAuth(
  async (req, { session }) => {
    const denied = forbidAgentToken(session);
    if (denied) return denied;
    const parsed = await parseBody(req, body);
    if (isResponse(parsed)) return parsed;
    const apiKey = parsed.apiKey ?? getSetting('agent.apiKey');
    if (apiKey === null) return apiError(400, 'bad_request', 'No API key saved or entered.');
    return ok(await listModels({ baseUrl: parsed.baseUrl ?? getSetting('agent.baseUrl'), apiKey }));
  },
  { mutating: true },
);

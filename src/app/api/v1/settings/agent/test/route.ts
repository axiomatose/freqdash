import { z } from 'zod';
import { withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { pingModel } from '@/server/agent/openai';
import { getSetting } from '@/server/settings';
import { SETTING_DEFS } from '@/server/settings/registry';
import { apiError } from '@/server/auth/guard';
import { isResponse, ok, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';

// "Test connection": tries the values in the form, falling back to what is saved (so the stored key is never sent to the browser).
const body = z.object({
  baseUrl: SETTING_DEFS['agent.baseUrl'].schema.optional(),
  apiKey: SETTING_DEFS['agent.apiKey'].schema.optional(),
  model: SETTING_DEFS['agent.model'].schema.optional(),
});

export const POST = withAuth(
  async (req, { session }) => {
    const denied = forbidAgentToken(session);
    if (denied) return denied;
    const parsed = await parseBody(req, body);
    if (isResponse(parsed)) return parsed;
    const apiKey = parsed.apiKey ?? getSetting('agent.apiKey');
    if (apiKey === null) return apiError(400, 'bad_request', 'No API key saved or entered.');
    const model = parsed.model ?? getSetting('agent.model');
    if (model === null) return apiError(400, 'bad_request', 'Choose a model first.');
    return ok(await pingModel({ baseUrl: parsed.baseUrl ?? getSetting('agent.baseUrl'), apiKey, model }));
  },
  { mutating: true },
);

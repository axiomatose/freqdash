import { z } from 'zod';
import { apiError, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { SETTING_KEYS, SettingsError, settingsView, updateSettings, type SettingKey } from '@/server/settings';
import { isResponse, ok, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';

// Only known keys, each validated by its own schema in updateSettings; `null` clears a key back to its default.
const body = z.object(Object.fromEntries(SETTING_KEYS.map((k) => [k, z.unknown().optional()]))).strict();

export const GET = withAuth((_req, { session }) => forbidAgentToken(session) ?? ok(settingsView()));

export const PUT = withAuth(
  async (req, { session }) => {
    const denied = forbidAgentToken(session);
    if (denied) return denied;
    const parsed = await parseBody(req, body);
    if (isResponse(parsed)) return parsed;
    const patch: Partial<Record<SettingKey, unknown>> = {};
    for (const k of SETTING_KEYS) if (parsed[k] !== undefined) patch[k] = parsed[k];
    try {
      updateSettings(patch, session.n, Date.now());
    } catch (err) {
      if (err instanceof SettingsError) return apiError(400, 'bad_request', err.message);
      throw err;
    }
    return ok(settingsView());
  },
  { mutating: true },
);

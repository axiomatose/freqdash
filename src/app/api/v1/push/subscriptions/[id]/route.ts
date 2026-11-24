import { z } from 'zod';
import { apiError, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { deletePushSubscription, getPushSubscription, updatePushPrefs } from '@/server/db';
import { mergePrefs, prefsSchema, toDevice } from '@/server/push/views';
import { isResponse, ok, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';

const idOf = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

/** Changes one of the user's devices' preferences. */
export const PUT = withAuth<{ id: string }>(
  async (req, { params, session }) => {
    const denied = forbidAgentToken(session);
    if (denied !== null || session.uid === null) return denied as Response;
    const id = idOf((await params).id);
    const current = id === null ? null : getPushSubscription(id);
    if (current === null || current.userId !== session.uid) return apiError(404, 'not_found', 'unknown device');
    const body = await parseBody(req, z.object({ prefs: prefsSchema }).strict());
    if (isResponse(body)) return body;
    const updated = updatePushPrefs(current.id, session.uid, mergePrefs(current.prefs, body.prefs));
    if (updated === null) return apiError(404, 'not_found', 'unknown device');
    return ok({ device: toDevice(updated) });
  },
  { mutating: true },
);

/** Removes one of the user's devices (the browser should also unsubscribe locally). */
export const DELETE = withAuth<{ id: string }>(
  async (_req, { params, session }) => {
    const denied = forbidAgentToken(session);
    if (denied !== null || session.uid === null) return denied as Response;
    const id = idOf((await params).id);
    if (id === null || !deletePushSubscription(id, session.uid)) return apiError(404, 'not_found', 'unknown device');
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  },
  { mutating: true },
);

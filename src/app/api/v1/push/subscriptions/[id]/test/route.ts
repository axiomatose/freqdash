import { apiError, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { getPushSubscription } from '@/server/db';
import { getPushService } from '@/server/push/service';
import { ok } from '@/server/views/http';

export const dynamic = 'force-dynamic';

/** Sends a test notification to one of the user's devices and reports whether the push service took it. */
export const POST = withAuth<{ id: string }>(
  async (_req, { params, session }) => {
    const denied = forbidAgentToken(session);
    if (denied !== null || session.uid === null) return denied as Response;
    const raw = (await params).id;
    const sub = /^\d{1,9}$/.test(raw) ? getPushSubscription(Number(raw)) : null;
    if (sub === null || sub.userId !== session.uid) return apiError(404, 'not_found', 'unknown device');
    const result = await getPushService().sendTestTo(sub);
    if (result.delivered > 0) return ok({ ok: true });
    return ok({
      ok: false,
      error:
        result.attempted === 0
          ? 'Web push is not available.'
          : (result.error ?? 'The push service no longer knows this device. Enable notifications again.'),
    });
  },
  { mutating: true },
);

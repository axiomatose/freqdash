import { apiError, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { upsertPushSubscription } from '@/server/db';
import { isAllowedPushEndpoint } from '@/server/push/send';
import { getPushService } from '@/server/push/service';
import { DEFAULT_PUSH_PREFS, mergePrefs, subscribeSchema, toDevice } from '@/server/push/views';
import { isResponse, ok, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';

/** Registers this browser's push subscription for the signed-in user (or takes it over from another user). */
export const POST = withAuth(
  async (req, { session }) => {
    const denied = forbidAgentToken(session);
    if (denied !== null || session.uid === null) return denied as Response;
    if (getPushService().publicKey() === null) return apiError(503, 'unavailable', 'Web push is not available.');
    const body = await parseBody(req, subscribeSchema);
    if (isResponse(body)) return body;
    if (!isAllowedPushEndpoint(body.subscription.endpoint)) {
      return apiError(400, 'bad_request', 'This browser’s push service is not supported.');
    }
    const record = upsertPushSubscription(
      {
        userId: session.uid,
        endpoint: body.subscription.endpoint,
        p256dh: body.subscription.keys.p256dh,
        auth: body.subscription.keys.auth,
        label: body.label && body.label !== '' ? body.label : null,
        prefs: mergePrefs(DEFAULT_PUSH_PREFS, body.prefs),
      },
      Date.now(),
    );
    return ok({ device: toDevice(record) });
  },
  { mutating: true },
);

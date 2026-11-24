import { withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { pushStatus } from '@/server/push/views';
import { ok } from '@/server/views/http';

export const dynamic = 'force-dynamic';

/** Web Push status for the signed-in user: the VAPID public key and their devices. */
export const GET = withAuth((_req, { session }) => {
  const denied = forbidAgentToken(session);
  if (denied !== null || session.uid === null) return denied as Response;
  return ok(pushStatus(session.uid));
});

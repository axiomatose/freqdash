import { apiError, clearSessionCookie, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { deleteSession } from '@/server/db';

export const dynamic = 'force-dynamic';

/** Ends one of the signed-in user's sessions. Ending the current one signs this browser out. */
export const DELETE = withAuth<{ id: string }>(
  async (req, { params, session }) => {
    const denied = forbidAgentToken(session);
    if (denied !== null || session.uid === null) return denied as Response;
    const { id } = await params;
    if (!/^\d{1,12}$/.test(id) || !deleteSession(Number(id), session.uid)) {
      return apiError(404, 'not_found', 'unknown session');
    }
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    if (Number(id) === session.sid) headers.append('Set-Cookie', clearSessionCookie(req));
    return new Response(null, { status: 204, headers });
  },
  { mutating: true },
);

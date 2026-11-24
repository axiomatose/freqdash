import { clearSessionCookie, withAuth } from '@/server/auth/guard';
import { deleteSession } from '@/server/db';

export const dynamic = 'force-dynamic';

// Signing out ends this session on the server (the token stops working everywhere, not just in this browser) and
// removes the cookie. Other sessions of the user are listed, and can be ended, under Settings > Account.
export const POST = withAuth(
  (req, { session }) => {
    if (session.sid !== null) deleteSession(session.sid);
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', clearSessionCookie(req));
    return new Response(null, { status: 204, headers });
  },
  { mutating: true, allowTemporaryPassword: true },
);

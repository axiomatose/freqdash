import { z } from 'zod';
import { describeError, log } from '@/server/log';
import { apiError, authConfig, getClientIp, issueSessionCookie, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { hashPassword, MAX_USER_PASSWORD_LENGTH, passwordProblem, verifyPassword } from '@/server/auth/password';
import { getLoginRateLimiter, loginFailureDelay } from '@/server/auth/ratelimit';
import { endUserSessions, sessionPolicy, startSession } from '@/server/auth/sessions';
import { getUserById, setUserPassword } from '@/server/db';

export const dynamic = 'force-dynamic';

const authLog = log.child('auth');

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z
    .string()
    .min(1)
    .max(MAX_USER_PASSWORD_LENGTH * 4),
});

// Change the signed-in user's password (also the way out of a temporary one). The current password is required and
// checked under the login rate limiter. On success every session of the user ends and this browser gets a new one.
export const POST = withAuth(
  async (req, { session }) => {
    const denied = forbidAgentToken(session);
    if (denied) return denied;
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return apiError(400, 'bad_request', 'Body must be valid JSON');
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return apiError(400, 'bad_request', 'Expected { currentPassword, newPassword }');
    const { currentPassword, newPassword } = parsed.data;

    const user = session.uid === null ? null : getUserById(session.uid);
    if (user === null) return apiError(401, 'unauthorized');

    const ip = getClientIp(req);
    const admission = getLoginRateLimiter().admit(ip);
    if (!admission.allowed) {
      return apiError(429, 'rate_limited', 'Too many failed attempts.', {
        retryAfterSec: admission.retryAfterSec,
        headers: { 'Retry-After': String(admission.retryAfterSec) },
      });
    }
    let ok = false;
    try {
      ok = await verifyPassword(currentPassword, user.passwordHash);
    } finally {
      admission.finish(ok);
    }
    if (!ok) {
      authLog.warn('password change refused: wrong current password', { ip, user: user.username });
      await loginFailureDelay();
      return apiError(400, 'bad_request', 'The current password is not correct.');
    }

    const problem = passwordProblem(newPassword, { username: user.username, current: currentPassword });
    if (problem !== null) return apiError(400, 'bad_request', problem);

    const now = Date.now();
    let updated;
    try {
      updated = setUserPassword(user.id, await hashPassword(newPassword), false, now);
    } catch (err) {
      authLog.error('password change failed', { user: user.username, error: describeError(err) });
      return apiError(500, 'internal');
    }
    if (updated === null) return apiError(401, 'unauthorized');

    // Every session of the user ends, this one included; this browser continues with a fresh token.
    const ended = endUserSessions(updated.id);
    const started = startSession(
      updated,
      { userAgent: req.headers.get('user-agent'), ip },
      now,
      sessionPolicy(authConfig().sessionMaxAgeDays),
    );
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', issueSessionCookie(req, started.token, started.cookieMaxAgeMs));
    authLog.info('password changed', { ip, user: updated.username, sessionsEnded: ended });
    return new Response(null, { status: 204, headers });
  },
  { mutating: true, allowTemporaryPassword: true },
);

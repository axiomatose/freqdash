import type { NextRequest } from 'next/server';
import { z } from 'zod';
import type { ApiErrorBody } from '@/shared/types/api';
import { describeError, log } from '@/server/log';
import { captchaKeys, getCaptchaService } from '@/server/auth/captcha';
import {
  apiError,
  assertMutating,
  authConfig,
  getClientIp,
  GuardError,
  issueSessionCookie,
  withApiHeaders,
} from '@/server/auth/guard';
import { DUMMY_HASH, verifyPassword } from '@/server/auth/password';
import { getLoginRateLimiter, loginFailureDelay } from '@/server/auth/ratelimit';
import { MAX_NAME_LENGTH } from '@/server/auth/session';
import { sessionPolicy, startSession } from '@/server/auth/sessions';
import { getUserByUsername, recordLogin } from '@/server/db';

export const dynamic = 'force-dynamic';

const authLog = log.child('auth');
const MAX_BODY_CHARS = 4096;

const bodySchema = z.object({
  username: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  password: z.string().min(1).max(1024),
  captchaId: z.string().max(64).optional(),
  captchaAnswer: z.string().max(32).optional(),
});

type Body = z.infer<typeof bodySchema>;

async function readBody(req: NextRequest): Promise<Body | Response> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_CHARS) return apiError(413, 'bad_request', 'Request body too large');
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return apiError(413, 'bad_request', 'Request body too large');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return apiError(400, 'bad_request', 'Body must be valid JSON');
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return apiError(400, 'bad_request', 'Expected { username: string, password: string }');
  return parsed.data;
}

/** 401 that hands the client a fresh captcha when the next attempt needs one. */
function unauthorized(message: string, withCaptcha: boolean): Response {
  const body: ApiErrorBody = { error: 'unauthorized', message };
  if (withCaptcha) body.captcha = getCaptchaService().issue();
  return Response.json(body, { status: 401, headers: { 'Cache-Control': 'no-store' } });
}

// Public, mutating and rate limited. The password is checked with scrypt (an unknown username costs the same as a known
// one, so timing does not reveal which accounts exist), a wrong one costs a fixed delay, and a locked-out client is
// refused before its password is looked at. After two failures for the address or the username, a captcha must be
// solved first; a missing or wrong captcha does not count as a password attempt. Nothing secret is logged or echoed.
export async function POST(req: NextRequest): Promise<Response> {
  try {
    assertMutating(req);
    const auth = authConfig();

    const body = await readBody(req);
    if (body instanceof Response) return withApiHeaders(body);

    const ip = getClientIp(req);
    const admission = getLoginRateLimiter().admit(ip);
    if (!admission.allowed) {
      authLog.warn('login refused: too many failed attempts', { ip, scope: admission.scope });
      return withApiHeaders(
        apiError(429, 'rate_limited', 'Too many failed attempts.', {
          retryAfterSec: admission.retryAfterSec,
          headers: { 'Retry-After': String(admission.retryAfterSec) },
        }),
      );
    }

    const captcha = getCaptchaService();
    const keys = captchaKeys(ip, body.username);
    if (captcha.required(keys) && !captcha.verify(body.captchaId, body.captchaAnswer)) {
      admission.release();
      const given = body.captchaId !== undefined || body.captchaAnswer !== undefined;
      return withApiHeaders(
        unauthorized(
          given ? 'The characters did not match. Try this new image.' : 'Type the characters in the image.',
          true,
        ),
      );
    }

    let user = null;
    let ok = false;
    try {
      user = getUserByUsername(body.username);
      const valid = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
      ok = valid && user !== null && !user.disabled;
    } finally {
      admission.finish(ok);
    }

    if (!ok || user === null) {
      captcha.recordFailure(keys);
      authLog.warn('login failed', { ip });
      await loginFailureDelay();
      return withApiHeaders(unauthorized('Incorrect username or password.', captcha.required(keys)));
    }

    captcha.recordSuccess(keys);
    const now = Date.now();
    recordLogin(user.id, now);
    const started = startSession(
      user,
      { userAgent: req.headers.get('user-agent'), ip },
      now,
      sessionPolicy(auth.sessionMaxAgeDays),
    );
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', issueSessionCookie(req, started.token, started.cookieMaxAgeMs));
    authLog.info('login ok', { ip, user: user.username, temporaryPassword: user.mustChangePassword });
    return withApiHeaders(Response.json({ mustChangePassword: user.mustChangePassword }, { status: 200, headers }));
  } catch (err) {
    if (err instanceof GuardError) return withApiHeaders(err.response);
    authLog.error('login failed unexpectedly', { error: describeError(err) });
    return withApiHeaders(apiError(500, 'internal'));
  }
}

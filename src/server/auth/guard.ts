import 'server-only';
import type { NextRequest } from 'next/server';
import type { Ms } from '@/shared/types/domain';
import { describeError, log } from '../log';
import { agentSession } from './agent';
import { apiError, authConfig, assertMutating, clearSessionCookie, GuardError, withApiHeaders } from './gate';
import { sessionTokensFromCookieHeader, type Session } from './session';
import { resolveSession, sessionPolicy, type SessionPolicy } from './sessions';

// Everything a route handler needs to enforce authentication and CSRF rules: the database-free helpers from gate.ts plus
// the session lookup. A cookie only counts while its session row exists, has not expired and its user is enabled.

export * from './gate';

const authLog = log.child('auth');

// ---- session ---------------------------------------------------------------------------------------------------

/** Idle and absolute session lifetimes from the configuration. */
export function currentSessionPolicy(): SessionPolicy {
  return sessionPolicy(authConfig().sessionMaxAgeDays);
}

/** The first live session among the `fd_session` cookies of a Cookie header, or null. Slides its expiry. */
export function sessionFromCookieHeader(cookieHeader: string | null | undefined, now: Ms = Date.now()): Session | null {
  const policy = currentSessionPolicy();
  for (const token of sessionTokensFromCookieHeader(cookieHeader)) {
    const session = resolveSession(token, now, policy);
    if (session !== null) return session;
  }
  return null;
}

/** The request's session (a live session cookie, else the automation token), or null. Never throws for a bad cookie. */
export function getSession(req: Request, now: Ms = Date.now()): Session | null {
  return (
    sessionFromCookieHeader(req.headers.get('cookie'), now) ??
    agentSession(req, new URL(req.url).pathname, authConfig().agentToken, now)
  );
}

/** The request's session; throws GuardError(401 `{error:'unauthorized'}`) when there is none. */
export function requireSession(req: Request, now: Ms = Date.now()): Session {
  const session = getSession(req, now);
  if (session !== null) return session;
  const res = apiError(401, 'unauthorized');
  // A cookie that no longer counts (expired, signed out elsewhere, user removed) is cleared in the same response.
  if (sessionTokensFromCookieHeader(req.headers.get('cookie')).length > 0) {
    res.headers.append('Set-Cookie', clearSessionCookie(req));
  }
  throw new GuardError(res);
}

// ---- route wrapper ---------------------------------------------------------------------------------------------

/** redirect(), notFound() and the dynamic-rendering bailouts signal through thrown errors that must reach Next.js. */
function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && (digest.startsWith('NEXT_') || digest.startsWith('DYNAMIC_SERVER_USAGE'));
}

export interface AuthedContext<P> {
  session: Session;
  /** Route parameters, a Promise exactly as Next.js passes them. */
  params: Promise<P>;
}

export interface WithAuthOptions {
  /** State-changing route (POST/PUT/PATCH/DELETE): also requires JSON content type and a same-origin request. */
  mutating?: boolean;
  /** Usable while the password is temporary (session, logout, change password). Everything else answers 403. */
  allowTemporaryPassword?: boolean;
}

/**
 * Wraps a route handler: requires a valid session (401) whose password is not temporary (403
 * `password_change_required`, unless `allowTemporaryPassword`), for `mutating` routes also `Content-Type: application/json`
 * (415) and a same-origin request (403), converts thrown GuardErrors into their responses, turns any other exception
 * into a generic 500 (nothing from the error reaches the client), and stamps the security headers and
 * `Cache-Control: no-store` on the result. For dynamic routes give the params type: `withAuth<{ id: string }>(...)`.
 */
export function withAuth<P = Record<never, never>>(
  handler: (req: NextRequest, ctx: AuthedContext<P>) => Response | Promise<Response>,
  options: WithAuthOptions = {},
): (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const session = requireSession(req);
      if (session.pc && !options.allowTemporaryPassword) {
        throw new GuardError(
          apiError(403, 'password_change_required', 'Change your temporary password before continuing.'),
        );
      }
      if (options.mutating) assertMutating(req);
      const res = await handler(req, { session, params: ctx?.params ?? Promise.resolve({} as P) });
      return withApiHeaders(res);
    } catch (err) {
      if (err instanceof GuardError) return withApiHeaders(err.response);
      if (isNextControlFlow(err)) throw err;
      authLog.error('unhandled error in route handler', { method: req.method, error: describeError(err) });
      return withApiHeaders(apiError(500, 'internal'));
    }
  };
}

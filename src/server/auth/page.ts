import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { PATH_HEADER, sessionFromCookieHeader } from './guard';
import { sanitizeNext } from './origin';
import { CHANGE_PASSWORD_PATH } from './paths';
import type { Session } from './session';

// Session checks for server-rendered pages (the proxy only sees whether a cookie is present).

/** The live session of the page request, or null. Never throws for a bad cookie or an unusable configuration. */
export async function pageSession(): Promise<Session | null> {
  try {
    return sessionFromCookieHeader((await headers()).get('cookie'));
  } catch {
    return null;
  }
}

/** The path the browser asked for (set by the proxy), sanitized for use as `next`. */
export async function requestedPath(): Promise<string> {
  return sanitizeNext((await headers()).get(PATH_HEADER));
}

const withNext = (page: string, next: string): string =>
  next === '/' ? page : `${page}?next=${encodeURIComponent(next)}`;

/**
 * For every page behind the login: the session, or a redirect to the login page (no live session) or to the
 * change-password page (temporary password), each carrying the requested path as `next`.
 */
export async function requirePageSession(): Promise<Session> {
  const session = await pageSession();
  if (session === null) redirect(withNext('/login', await requestedPath()));
  if (session.pc) redirect(withNext(CHANGE_PASSWORD_PATH, await requestedPath()));
  return session;
}

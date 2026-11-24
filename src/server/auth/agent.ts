import { createHash, timingSafeEqual } from 'node:crypto';
import type { Ms } from '@/shared/types/domain';
import type { Session } from './session';

// Read-only access for automation (an assistant, a cloud session). A separate secret from the user accounts: it is
// accepted ONLY as `Authorization: Bearer <token>`, ONLY on GET/HEAD, and ONLY under /api/v1/, so it can never reach a
// mutating route, the login endpoints or a page. Revoke it by clearing AGENT_API_TOKEN and restarting.

export const AGENT_NAME = 'agent';
const AGENT_SESSION_MS = 60_000;

const digest = (v: string): Buffer => createHash('sha256').update(v, 'utf8').digest();

function bearer(header: string | null): string | null {
  const m = /^Bearer\s+(\S{1,512})$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

/** A short-lived session for a valid agent token on an allowed request, else null. */
export function agentSession(
  req: { method: string; headers: Headers },
  pathname: string,
  agentToken: string | null,
  now: Ms,
): Session | null {
  if (agentToken === null) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (!pathname.startsWith('/api/v1/')) return null;
  const given = bearer(req.headers.get('authorization'));
  if (given === null) return null;
  if (!timingSafeEqual(digest(given), digest(agentToken))) return null;
  return { sid: null, uid: null, n: AGENT_NAME, pc: false, exp: now + AGENT_SESSION_MS };
}

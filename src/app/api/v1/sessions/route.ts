import type { SessionsResponse } from '@/shared/types/api';
import { withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { endUserSessions } from '@/server/auth/sessions';
import { listUserSessions } from '@/server/db';
import { ok } from '@/server/views/http';

export const dynamic = 'force-dynamic';

/** The signed-in user's live sessions, most recently used first. */
export const GET = withAuth((_req, { session }) => {
  const denied = forbidAgentToken(session);
  if (denied !== null || session.uid === null) return denied as Response;
  const body: SessionsResponse = {
    sessions: listUserSessions(session.uid, Date.now()).map((s) => ({
      id: s.id,
      label: s.label,
      ip: s.ip,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: Math.min(s.expiresAt, s.absoluteExpiresAt),
      current: s.id === session.sid,
    })),
  };
  return ok(body);
});

/** Ends every other session of the signed-in user ("sign out everywhere else"). */
export const DELETE = withAuth(
  (_req, { session }) => {
    const denied = forbidAgentToken(session);
    if (denied !== null || session.uid === null) return denied as Response;
    return ok({ ended: endUserSessions(session.uid, session.sid) });
  },
  { mutating: true },
);

import type { SessionResponse } from '@/shared/types/api';
import { withAuth } from '@/server/auth/guard';

export const dynamic = 'force-dynamic';

export const GET = withAuth(
  (_req, { session }) => {
    const body: SessionResponse = { name: session.n, expiresAt: session.exp, mustChangePassword: session.pc };
    return Response.json(body);
  },
  { allowTemporaryPassword: true },
);

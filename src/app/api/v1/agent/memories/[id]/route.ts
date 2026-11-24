import { apiError, withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { deleteMemory } from '@/server/db';

export const dynamic = 'force-dynamic';

export const DELETE = withAuth<{ id: string }>(
  async (_req, { params, session }) => {
    const denied = forbidAgentToken(session);
    if (denied) return denied;
    const { id } = await params;
    if (!/^\d{1,9}$/.test(id) || !deleteMemory(Number(id))) return apiError(404, 'not_found', 'unknown memory');
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  },
  { mutating: true },
);

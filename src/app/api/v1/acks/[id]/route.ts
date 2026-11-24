import { apiError, withAuth } from '@/server/auth/guard';
import { getStore } from '@/server/state/store';
import { revokeAckById } from '@/server/views/acks';
import { currentViewContext } from '@/server/views/common';

export const dynamic = 'force-dynamic';

export const DELETE = withAuth<{ id: string }>(
  async (_req, { params, session }) => {
    const { id } = await params;
    if (!/^\d{1,9}$/.test(id) || !revokeAckById(currentViewContext(), Number(id), session.n)) {
      return apiError(404, 'not_found', 'unknown acknowledgement');
    }
    getStore().requestRecheck();
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  },
  { mutating: true },
);

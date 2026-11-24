import { apiError, withAuth } from '@/server/auth/guard';
import { unsilence } from '@/server/db';
import { getStore } from '@/server/state/store';
import { ok } from '@/server/views/http';

export const dynamic = 'force-dynamic';

export const POST = withAuth<{ id: string }>(
  async (_req, { params }) => {
    const { id } = await params;
    if (!/^\d{1,9}$/.test(id)) return apiError(404, 'not_found', 'unknown finding');
    const finding = unsilence(Number(id));
    if (finding === null || finding.status === 'pending') return apiError(404, 'not_found', 'unknown finding');
    getStore().requestRecheck();
    return ok({ finding });
  },
  { mutating: true },
);

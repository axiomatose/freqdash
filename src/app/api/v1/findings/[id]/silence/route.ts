import { z } from 'zod';
import { apiError, withAuth } from '@/server/auth/guard';
import { silence } from '@/server/db';
import { getStore } from '@/server/state/store';
import { isResponse, ok, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';

const body = z.object({ note: z.string().max(500).optional() });

export const POST = withAuth<{ id: string }>(
  async (req, { params, session }) => {
    const { id } = await params;
    if (!/^\d{1,9}$/.test(id)) return apiError(404, 'not_found', 'unknown finding');
    const parsed = await parseBody(req, body);
    if (isResponse(parsed)) return parsed;
    const finding = silence(Number(id), { by: session.n, note: parsed.note ?? null }, Date.now());
    if (finding === null || finding.status === 'pending') return apiError(404, 'not_found', 'unknown finding');
    getStore().requestRecheck();
    return ok({ finding });
  },
  { mutating: true },
);

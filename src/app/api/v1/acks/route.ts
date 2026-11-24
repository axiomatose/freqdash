import { z } from 'zod';
import { withAuth } from '@/server/auth/guard';
import { getStore } from '@/server/state/store';
import { buildAcks, createAcksFromBody } from '@/server/views/acks';
import { currentViewContext } from '@/server/views/common';
import { isResponse, ok, parseBody } from '@/server/views/http';

export const dynamic = 'force-dynamic';

const body = z.object({
  kind: z.enum(['asset', 'kraken_order']),
  subjects: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
  label: z.enum(['manual', 'ignored']),
  note: z.string().max(500).optional(),
  qtyBaseline: z.number().finite().nonnegative().nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
});

export const GET = withAuth(() => ok(buildAcks(currentViewContext())));

export const POST = withAuth(
  async (req, { session }) => {
    const parsed = await parseBody(req, body);
    if (isResponse(parsed)) return parsed;
    const result = createAcksFromBody(
      currentViewContext(),
      {
        kind: parsed.kind,
        subjects: parsed.subjects,
        label: parsed.label,
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
        ...(parsed.qtyBaseline === undefined ? {} : { qtyBaseline: parsed.qtyBaseline }),
        ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
      },
      session.n,
    );
    getStore().requestRecheck();
    return ok(result);
  },
  { mutating: true },
);

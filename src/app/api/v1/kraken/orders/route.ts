import { z } from 'zod';
import { withAuth } from '@/server/auth/guard';
import { isResponse, limitParam, ok, parseQuery } from '@/server/views/http';
import { currentViewContext } from '@/server/views/common';
import { buildKrakenOrders } from '@/server/views/krakenOrders';

export const dynamic = 'force-dynamic';

const query = z.object({
  since: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
  pair: z.string().max(32).optional(),
  match: z.enum(['all', 'unmatched', 'matched', 'acked']).optional(),
  limit: limitParam(1000),
});

export const GET = withAuth((req) => {
  const q = parseQuery(req, query);
  return isResponse(q) ? q : ok(buildKrakenOrders(currentViewContext(), q));
});

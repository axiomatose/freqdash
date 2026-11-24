import { z } from 'zod';
import { withAuth } from '@/server/auth/guard';
import { isResponse, limitParam, offsetParam, ok, parseQuery } from '@/server/views/http';
import { currentViewContext } from '@/server/views/common';
import { buildTrades } from '@/server/views/trades';

export const dynamic = 'force-dynamic';

const query = z.object({
  bot: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .optional(),
  pair: z.string().max(32).optional(),
  status: z.enum(['open', 'closed', 'all']).optional(),
  since: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
  limit: limitParam(1000),
  offset: offsetParam,
});

export const GET = withAuth((req) => {
  const q = parseQuery(req, query);
  return isResponse(q) ? q : ok(buildTrades(currentViewContext(), q));
});

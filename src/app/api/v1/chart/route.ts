import { z } from 'zod';
import { apiError, withAuth } from '@/server/auth/guard';
import { getChart, ChartError } from '@/server/chart/service';
import { isResponse, limitParam, ok, parseQuery } from '@/server/views/http';

export const dynamic = 'force-dynamic';

const query = z.object({
  bot: z.string().regex(/^[a-z0-9-]{1,32}$/),
  pair: z.string().regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/),
  tf: z.string().regex(/^\d{1,2}[mhd]$/),
  limit: limitParam(1000),
});

const STATUS = { not_found: 404, bad_request: 400, unavailable: 503 } as const;

export const GET = withAuth(async (req) => {
  const q = parseQuery(req, query);
  if (isResponse(q)) return q;
  try {
    return ok(await getChart({ bot: q.bot, pair: q.pair, tf: q.tf, limit: q.limit ?? 500 }));
  } catch (err) {
    if (err instanceof ChartError) return apiError(STATUS[err.code], err.code, err.message);
    throw err;
  }
});

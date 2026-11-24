import { z } from 'zod';
import { apiError, withAuth } from '@/server/auth/guard';
import { getStrategies, StrategyError } from '@/server/strategy/service';
import { isResponse, ok, parseQuery } from '@/server/views/http';

export const dynamic = 'force-dynamic';

const query = z.object({
  code: z.enum(['0', '1']).optional(),
  assumedFee: z.coerce.number().min(0).max(0.05).optional(),
});

export const GET = withAuth(async (req) => {
  const q = parseQuery(req, query);
  if (isResponse(q)) return q;
  try {
    return ok(
      await getStrategies({
        includeCode: q.code === '1',
        assumedCloseFee: q.assumedFee ?? null,
      }),
    );
  } catch (err) {
    if (err instanceof StrategyError) return apiError(503, 'unavailable', err.message);
    throw err;
  }
});

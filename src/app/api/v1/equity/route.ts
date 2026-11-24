import { z } from 'zod';
import { withAuth } from '@/server/auth/guard';
import { currentViewContext } from '@/server/views/common';
import { buildEquity } from '@/server/views/equity';
import { isResponse, ok, parseQuery } from '@/server/views/http';

export const dynamic = 'force-dynamic';

const query = z.object({ range: z.enum(['24h', '7d', '30d', '90d', 'all']).default('7d') });

export const GET = withAuth((req) => {
  const q = parseQuery(req, query);
  return isResponse(q) ? q : ok(buildEquity(currentViewContext(), q.range));
});

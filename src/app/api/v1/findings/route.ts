import { z } from 'zod';
import { withAuth } from '@/server/auth/guard';
import { isResponse, limitParam, ok, parseQuery } from '@/server/views/http';
import { currentViewContext } from '@/server/views/common';
import { buildFindings } from '@/server/views/findings';

export const dynamic = 'force-dynamic';

const query = z.object({
  status: z.enum(['active', 'silenced', 'resolved', 'all']).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  limit: limitParam(500),
});

export const GET = withAuth((req) => {
  const q = parseQuery(req, query);
  return isResponse(q) ? q : ok(buildFindings(currentViewContext(), q));
});

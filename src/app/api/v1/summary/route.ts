import { withAuth } from '@/server/auth/guard';
import { ok } from '@/server/views/http';
import { currentViewContext } from '@/server/views/common';
import { buildSummary } from '@/server/views/summary';

export const dynamic = 'force-dynamic';

export const GET = withAuth(() => ok(buildSummary(currentViewContext())));

import { withAuth } from '@/server/auth/guard';
import { ok } from '@/server/views/http';
import { currentViewContext } from '@/server/views/common';
import { buildOverview } from '@/server/views/overview';

export const dynamic = 'force-dynamic';

export const GET = withAuth(() => ok(buildOverview(currentViewContext())));

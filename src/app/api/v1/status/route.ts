import { withAuth } from '@/server/auth/guard';
import { ok } from '@/server/views/http';
import { currentViewContext } from '@/server/views/common';
import { buildStatus } from '@/server/views/status';

export const dynamic = 'force-dynamic';

export const GET = withAuth(() => ok(buildStatus(currentViewContext())));

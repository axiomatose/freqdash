import { withAuth } from '@/server/auth/guard';
import { ok } from '@/server/views/http';
import { currentViewContext } from '@/server/views/common';
import { buildPositions } from '@/server/views/positions';

export const dynamic = 'force-dynamic';

export const GET = withAuth(() => ok(buildPositions(currentViewContext())));

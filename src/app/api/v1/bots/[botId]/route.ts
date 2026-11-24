import { apiError, withAuth } from '@/server/auth/guard';
import { ok } from '@/server/views/http';
import { currentViewContext } from '@/server/views/common';
import { buildBotDetail } from '@/server/views/bots';

export const dynamic = 'force-dynamic';

export const GET = withAuth<{ botId: string }>(async (_req, { params }) => {
  const { botId } = await params;
  const body = /^[a-z0-9-]{1,32}$/.test(botId) ? buildBotDetail(currentViewContext(), botId) : null;
  return body === null ? apiError(404, 'not_found', 'unknown bot') : ok(body);
});

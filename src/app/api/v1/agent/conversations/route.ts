import { withAuth } from '@/server/auth/guard';
import { forbidAgentToken } from '@/server/auth/forbidAgent';
import { listConversations } from '@/server/db';
import { ok } from '@/server/views/http';

export const dynamic = 'force-dynamic';

export const GET = withAuth(
  (_req, { session }) => forbidAgentToken(session) ?? ok({ conversations: listConversations(50) }),
);

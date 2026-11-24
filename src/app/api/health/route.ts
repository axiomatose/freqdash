import { APP_VERSION } from '@/shared/constants';
import type { HealthResponse } from '@/shared/types/api';

export const dynamic = 'force-dynamic';

// Public liveness probe (container HEALTHCHECK). Deliberately independent of configuration, the database and the poller.
export function GET(): Response {
  const body: HealthResponse = { ok: true, version: APP_VERSION };
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

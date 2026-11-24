import { withAuth } from '@/server/auth/guard';
import { log } from '@/server/log';
import { resetKillswitch } from '@/server/killswitch/service';
import { getStore } from '@/server/state/store';
import { ok } from '@/server/views/http';

export const dynamic = 'force-dynamic';

// Clears the latch after a trip. Bots stay stopped: freqdash never starts a container.
export const POST = withAuth(
  (_req, { session }) => {
    resetKillswitch(Date.now());
    log.warn('killswitch reset', { by: session.n ?? 'unknown' });
    getStore().requestRecheck();
    return ok({ ok: true });
  },
  { mutating: true },
);

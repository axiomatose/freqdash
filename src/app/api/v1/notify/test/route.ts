import { withAuth } from '@/server/auth/guard';
import { getConfig } from '@/server/config';
import { getPollerHandle } from '@/server/boot';
import { Dispatcher } from '@/server/notify/dispatcher';
import { getPushService } from '@/server/push/service';
import { getStore } from '@/server/state/store';
import { ok } from '@/server/views/http';

export const dynamic = 'force-dynamic';

export const POST = withAuth(
  async () => {
    const cfg = getConfig().notify;
    // Works with the poller off too: the test only needs the configured channels.
    const dispatcher =
      getPollerHandle()?.ctx.dispatcher ??
      new Dispatcher({
        discordWebhookUrl: cfg.discordWebhookUrl,
        store: getStore(),
        push: getPushService(),
      });
    return ok(await dispatcher.sendTest());
  },
  { mutating: true },
);

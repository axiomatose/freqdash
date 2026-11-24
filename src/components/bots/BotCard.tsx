'use client';

import Link from 'next/link';
import { BotDot, Metric, Money, Pct, Stat, StatusPill, TimeAgo } from '@/components/data';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDuration } from '@/lib/client/format';
import type { BotCard as BotCardData } from '@/shared/types/api';
import { useNow } from '@/components/data';

export function BotCard({ bot }: { bot: BotCardData }) {
  const now = useNow();
  const stats = bot.stats;
  const sources = [`bot:${bot.botId}:trades`, `bot:${bot.botId}:status`];
  const max = bot.config?.maxOpenTrades ?? null;
  return (
    <Card data-testid={`bot-card-${bot.botId}`}>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="flex min-w-0 items-center gap-2">
          <BotDot color={bot.color} />
          <Link href={`/bots/${bot.botId}`} className="truncate hover:underline">
            {bot.name}
          </Link>
        </CardTitle>
        <StatusPill status={bot.status} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-4">
          <div>
            <dt className="sr-only">Uptime</dt>
            <dd>
              {bot.uptimeSince && now !== null
                ? `up ${formatDuration(Math.max(0, now - bot.uptimeSince))}`
                : 'uptime unknown'}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Last process</dt>
            <dd>
              last loop <TimeAgo at={bot.health?.lastProcessAt} />
            </dd>
          </div>
          <div>
            <dt className="sr-only">Open trades</dt>
            <dd>
              open {stats?.openTrades ?? 0}
              {max === null ? '' : `/${max}`}
            </dd>
          </div>
          <div>
            <dt className="sr-only">Restarts</dt>
            <dd>{bot.restarts24h} restarts 24h</dd>
          </div>
        </dl>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Stat
            label="Realized"
            size="sm"
            value={<Metric value={<Money value={stats?.realizedUsd} signed />} sources={sources} asOf={false} />}
          />
          <Stat
            label="Unrealized"
            size="sm"
            value={<Metric value={<Money value={stats?.unrealizedUsd} signed />} sources={sources} asOf={false} />}
          />
          <Stat
            label="Total"
            size="sm"
            value={<Metric value={<Money value={stats?.totalUsd} signed />} sources={sources} asOf={false} />}
          />
          <Stat
            label="ROI on stake"
            size="sm"
            value={<Metric value={<Pct value={stats?.roiOnStake} signed />} sources={sources} asOf={false} />}
          />
          <Stat
            label="Return on peak"
            size="sm"
            value={<Metric value={<Pct value={stats?.returnOnPeakStake} signed />} sources={sources} asOf={false} />}
          />
          <Stat
            label="Fees"
            size="sm"
            value={<Metric value={<Money value={stats?.feesUsd} />} sources={sources} asOf={false} />}
          />
        </div>
      </CardContent>
    </Card>
  );
}

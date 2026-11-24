'use client';

import { Info } from 'lucide-react';
import { Metric, Money, Pct, Stat, TimeAgo } from '@/components/data';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/components/ui/utils';
import { formatUsd } from '@/lib/client/format';
import type { OverviewResponse } from '@/shared/types/api';

export function accountSources(o: Pick<OverviewResponse, 'mode' | 'bots'>): string[] {
  return o.mode === 'kraken' ? ['kraken:balance'] : o.bots.map((b) => `bot:${b.botId}:balance`);
}

function sourceLabel(o: OverviewResponse): string {
  const a = o.account;
  if (a === null) return 'No account data';
  if (a.source === 'kraken') return 'Kraken account';
  const bot = o.bots.find((b) => b.botId === a.estimatedFromBot);
  return `Estimated from ${bot?.name ?? a.estimatedFromBot ?? 'bot'} wallet`;
}

export function AccountCard({ overview, className }: { overview: OverviewResponse; className?: string }) {
  const { account, change24h } = overview;
  const sources = accountSources(overview);
  return (
    <Card className={className} data-testid="account-card">
      <CardContent className="flex flex-col gap-3">
        <Stat
          size="hero"
          label="Account total"
          value={<Metric value={<Money value={account?.totalUsd} />} sources={sources} />}
          sub={
            <span className="flex flex-wrap items-center gap-x-2">
              <span>{sourceLabel(overview)}</span>
              {account?.source === 'bot-wallet' ? (
                <span>
                  · synced <TimeAgo at={account.asOf} />
                </span>
              ) : null}
            </span>
          }
        />
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm" data-testid="change-24h">
          <span className="eyebrow">24h</span>
          {change24h === null ? (
            <span className="text-muted">not enough history yet</span>
          ) : (
            <>
              <Money value={change24h.usd} signed />
              <Pct value={null} points={change24h.pct} signed />
              {change24h.netFlowsUsd === null && overview.mode === 'kraken' ? (
                <span className="text-xs text-muted">deposits and withdrawals not excluded</span>
              ) : null}
            </>
          )}
        </div>
        {account !== null && account.unpricedAssets.length > 0 ? (
          <p className="text-xs text-warning">Not priced, excluded: {account.unpricedAssets.join(', ')}</p>
        ) : null}
        <WalletViews overview={overview} />
      </CardContent>
    </Card>
  );
}

function WalletViews({ overview }: { overview: OverviewResponse }) {
  const rows = [
    ...(overview.mode === 'kraken' && overview.account
      ? [
          {
            key: 'kraken',
            name: 'Kraken',
            usd: overview.account.usdCash,
            total: overview.account.totalUsd,
            at: overview.account.asOf,
          },
        ]
      : []),
    ...overview.walletViews.map((w) => ({
      key: w.botId,
      name: overview.bots.find((b) => b.botId === w.botId)?.name ?? w.botId,
      usd: w.usd,
      total: w.totalUsd,
      at: w.syncedAt,
    })),
  ];
  if (rows.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn('-ml-2 w-fit text-muted')}>
          <Info aria-hidden /> Wallet views
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <table className="w-full text-sm">
          <thead>
            <tr className="eyebrow text-left">
              <th className="pb-1 font-medium">Source</th>
              <th className="pb-1 text-right font-medium">USD</th>
              <th className="pb-1 text-right font-medium">Synced</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-0.5">{r.name}</td>
                <td className="py-0.5 text-right tabular-nums">{r.usd === null ? '—' : formatUsd(r.usd)}</td>
                <td className="py-0.5 text-right text-muted">
                  <TimeAgo at={r.at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">Bot wallets are caches and can be up to an hour old.</p>
      </PopoverContent>
    </Popover>
  );
}

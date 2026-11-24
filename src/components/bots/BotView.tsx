'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BadgeCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import {
  BotDot,
  EmptyState,
  FreshnessProvider,
  Metric,
  Money,
  Pct,
  Pnl,
  Price,
  Qty,
  ResponsiveTable,
  SkeletonCard,
  Stat,
  StatusPill,
  Time,
  TimeAgo,
  useNow,
  type Column,
} from '@/components/data';
import { QueryBoundary } from '@/components/overview/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDuration } from '@/lib/client/format';
import { useBot, useTrades } from '@/lib/client/queries';
import type { BotDetailResponse, OrderMatch } from '@/shared/types/api';
import type { BotEvent, BotOrder, BotTrade } from '@/shared/types/domain';

const MATCH: Record<OrderMatch, { label: string; icon: typeof BadgeCheck; className: string }> = {
  matched: { label: 'Matches Kraken', icon: BadgeCheck, className: 'text-positive' },
  missing: { label: 'Not found on Kraken', icon: TriangleAlert, className: 'text-warning' },
  mismatch: { label: 'Differs from Kraken', icon: TriangleAlert, className: 'text-warning' },
  unknown: { label: 'Kraken match unknown', icon: CircleHelp, className: 'text-muted' },
};

export function MatchIcon({ match }: { match: OrderMatch }) {
  const m = MATCH[match];
  const Icon = m.icon;
  return <Icon role="img" aria-label={m.label} className={`size-4 shrink-0 ${m.className}`} />;
}

const EVENT_LABEL: Record<BotEvent['type'], string> = {
  startup: 'Started',
  fatal: 'Fatal error',
  process_died: 'Process died',
  order_created: 'Order created',
  order_failed: 'Order failed',
  order_canceled: 'Order canceled',
  error: 'Error',
  identity_changed: 'Identity changed',
  unreachable: 'Unreachable',
  recovered: 'Recovered',
};
const BAD_EVENTS = new Set<BotEvent['type']>([
  'fatal',
  'process_died',
  'error',
  'order_failed',
  'identity_changed',
  'unreachable',
]);

function Orders({ orders, matches }: { orders: readonly BotOrder[]; matches: Record<string, OrderMatch> }) {
  return (
    <ul className="flex flex-col gap-1 py-1 text-xs" aria-label="Orders">
      {orders.map((o) => (
        <li key={o.orderId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <MatchIcon match={matches[o.orderId] ?? 'unknown'} />
          <span className="w-10 text-muted">{o.isEntry ? 'entry' : 'exit'}</span>
          <Qty value={o.filled} />
          <span className="text-muted">@</span>
          <Price value={o.price} />
          <span className="text-muted">{o.status}</span>
          <code className="text-muted">{o.orderId}</code>
        </li>
      ))}
    </ul>
  );
}

function TradeTable({
  trades,
  matches,
  caption,
  showOpen,
}: {
  trades: readonly BotTrade[];
  matches: Map<number, Record<string, OrderMatch>>;
  caption: string;
  showOpen: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (id: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const columns: Column<BotTrade>[] = [
    {
      key: 'pair',
      header: 'Pair',
      card: 'title',
      cell: (t) => (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open.has(t.tradeId)}
          onClick={() => toggle(t.tradeId)}
          className="-ml-2"
        >
          {t.pair} <span className="text-muted">#{t.tradeId}</span>
        </Button>
      ),
    },
    { key: 'opened', header: 'Opened', cell: (t) => <Time at={t.openedAt} />, className: 'text-muted' },
    ...(showOpen
      ? ([
          { key: 'qty', header: 'Qty', align: 'right', cell: (t) => <Qty value={t.pnl.openQty} asset={t.base} /> },
          {
            key: 'upnl',
            header: 'uPnL',
            align: 'right',
            card: 'full',
            cell: (t) => (
              <Pnl
                usd={t.pnl.unrealizedUsd}
                pct={
                  t.pnl.unrealizedUsd !== null && t.pnl.costBasisUsd > 0
                    ? t.pnl.unrealizedUsd / t.pnl.costBasisUsd
                    : null
                }
              />
            ),
          },
        ] satisfies Column<BotTrade>[])
      : ([
          { key: 'closed', header: 'Closed', cell: (t) => <Time at={t.closedAt} />, className: 'text-muted' },
          { key: 'reason', header: 'Reason', cell: (t) => t.exitReason ?? '—', className: 'text-muted' },
          {
            key: 'rpnl',
            header: 'Realized',
            align: 'right',
            card: 'full',
            cell: (t) => (
              <Pnl
                usd={t.pnl.realizedUsd}
                pct={t.pnl.costBasisUsd > 0 ? t.pnl.realizedUsd / t.pnl.costBasisUsd : null}
              />
            ),
          },
        ] satisfies Column<BotTrade>[])),
    { key: 'entries', header: 'Entries', align: 'right', cell: (t) => t.entries, card: 'hidden' },
  ];
  return (
    <ResponsiveTable
      caption={caption}
      columns={columns}
      rows={trades}
      rowKey={(t) => t.key}
      isExpanded={(t) => open.has(t.tradeId)}
      renderExpanded={(t) => <Orders orders={t.orders} matches={matches.get(t.tradeId) ?? {}} />}
      empty={<EmptyState title={showOpen ? 'No open trades' : 'No closed trades yet'} />}
    />
  );
}

function StatsGrid({ d }: { d: BotDetailResponse }) {
  const s = d.bot.stats;
  const src = d.bot.sources.filter((k) => /:(status|trades)$/.test(k));
  const cell = (label: string, node: React.ReactNode) => (
    <Stat label={label} size="sm" value={<Metric value={node} sources={src} asOf={false} />} />
  );
  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-6">
        {cell('Realized', <Money value={s?.realizedUsd} signed />)}
        {cell('Unrealized', <Money value={s?.unrealizedUsd} signed />)}
        {cell('Total', <Money value={s?.totalUsd} signed />)}
        {cell('ROI on stake', <Pct value={s?.roiOnStake} signed />)}
        {cell('Return on peak', <Pct value={s?.returnOnPeakStake} signed />)}
        {cell('Win rate', <Pct value={s?.winRate} />)}
        {cell('Closed trades', <>{s?.closedTrades ?? '—'}</>)}
        {cell('Open cost basis', <Money value={s?.openCostBasisUsd} />)}
        {cell('Open value', <Money value={s?.openMarketValueUsd} />)}
        {cell('Peak stake', <Money value={s?.peakConcurrentStakeUsd} />)}
        {cell('Fees', <Money value={s?.feesUsd} />)}
      </CardContent>
    </Card>
  );
}

function PerPair({ d }: { d: BotDetailResponse }) {
  const columns: Column<BotDetailResponse['perPair'][number]>[] = [
    { key: 'pair', header: 'Pair', cell: (p) => <span className="font-medium">{p.pair}</span>, card: 'title' },
    { key: 'n', header: 'Closed', align: 'right', cell: (p) => p.closedTrades },
    { key: 'r', header: 'Realized', align: 'right', cell: (p) => <Money value={p.realizedUsd} signed /> },
    { key: 'roi', header: 'ROI on stake', align: 'right', cell: (p) => <Pct value={p.roiOnStake} signed /> },
    { key: 'open', header: 'Open qty', align: 'right', cell: (p) => <Qty value={p.openQty} /> },
  ];
  return (
    <ResponsiveTable
      caption="Per pair"
      columns={columns}
      rows={d.perPair}
      rowKey={(p) => p.pair}
      empty={<EmptyState title="No trades yet" />}
    />
  );
}

function Events({ events }: { events: readonly BotEvent[] }) {
  if (events.length === 0) return <EmptyState title="No events in the last 7 days" />;
  return (
    <ol className="flex flex-col divide-y rounded-xl border bg-surface" aria-label="Events">
      {events.map((e) => (
        <li key={e.fingerprint} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3.5 py-2 text-sm">
          <span className="w-36 shrink-0 text-xs text-muted">
            <Time at={e.at} />
          </span>
          <Badge variant={BAD_EVENTS.has(e.type) ? 'warning' : 'default'}>{EVENT_LABEL[e.type]}</Badge>
          {e.pair ? <span>{e.pair}</span> : null}
          {e.orderId ? <code className="text-xs text-muted">{e.orderId}</code> : null}
          {e.message ? <span className="min-w-0 break-words text-muted">{e.message}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function Header({ d }: { d: BotDetailResponse }) {
  const now = useNow();
  const { bot } = d;
  const cfg = bot.config;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-xl">
          <BotDot color={bot.color} />
          {bot.name}
          <StatusPill status={bot.status} />
        </CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link href={`/chart?bot=${bot.botId}${cfg ? `&tf=${cfg.timeframe}` : ''}`}>Open chart</Link>
        </Button>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Strategy', cfg?.strategy || '—'],
            ['Timeframe', cfg?.timeframe || '—'],
            ['State', cfg?.state || '—'],
            ['Version', cfg?.version || '—'],
            ['Uptime', bot.uptimeSince && now !== null ? formatDuration(Math.max(0, now - bot.uptimeSince)) : '—'],
            ['Restarts 24h', String(bot.restarts24h)],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="eyebrow">{k}</dt>
              <dd className="truncate">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">
          Last loop <TimeAgo at={bot.health?.lastProcessAt} />
          {cfg ? ` · max ${cfg.maxOpenTrades} open trades` : ''}
          {cfg?.dryRun ? ' · dry run' : ''}
        </p>
      </CardContent>
    </Card>
  );
}

function Content({ d, matches }: { d: BotDetailResponse; matches: Map<number, Record<string, OrderMatch>> }) {
  const summary = (
    <div className="flex flex-col gap-4">
      <StatsGrid d={d} />
      <PerPair d={d} />
    </div>
  );
  const trades = (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-medium text-muted">Open trades</h2>
      <TradeTable trades={d.openTrades} matches={matches} caption="Open trades" showOpen />
      <h2 className="text-sm font-medium text-muted">Recent closed</h2>
      <TradeTable trades={d.recentClosed} matches={matches} caption="Recent closed trades" showOpen={false} />
    </div>
  );
  return (
    <FreshnessProvider sources={d.sources}>
      <div className="flex flex-col gap-4" data-testid="bot-page">
        <Header d={d} />
        <div className="hidden flex-col gap-4 lg:flex">
          {summary}
          {trades}
          <h2 className="text-sm font-medium text-muted">Events</h2>
          <Events events={d.events} />
          <Sources d={d} />
        </div>
        <Tabs defaultValue="summary" className="lg:hidden">
          <TabsList className="w-full">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="trades">Trades</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
          </TabsList>
          <TabsContent value="summary" className="mt-4">
            {summary}
          </TabsContent>
          <TabsContent value="trades" className="mt-4">
            {trades}
          </TabsContent>
          <TabsContent value="events" className="mt-4 flex flex-col gap-4">
            <Events events={d.events} />
            <Sources d={d} />
          </TabsContent>
        </Tabs>
      </div>
    </FreshnessProvider>
  );
}

function Sources({ d }: { d: BotDetailResponse }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data sources</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {d.sources.map((s) => (
            <li key={s.source} className="flex items-center justify-between gap-3">
              <span className="truncate text-muted">{s.label}</span>
              <span className="flex items-center gap-2">
                <Badge variant={s.state === 'fresh' ? 'positive' : s.state === 'error' ? 'critical' : 'warning'}>
                  {s.state}
                </Badge>
                <TimeAgo at={s.lastOkAt} />
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function BotView({ botId }: { botId: string }) {
  const q = useBot(botId);
  const t = useTrades({ bot: botId, limit: 500 });
  const matches = new Map<number, Record<string, OrderMatch>>();
  for (const trade of t.data?.trades ?? []) matches.set(trade.tradeId, trade.krakenMatch);
  return (
    <QueryBoundary query={q} skeleton={<SkeletonCard rows={8} />}>
      {(d) => <Content d={d} matches={matches} />}
    </QueryBoundary>
  );
}

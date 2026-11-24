'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { MatchIcon } from '@/components/bots/BotView';
import {
  BotBadge,
  EmptyState,
  Money,
  Pnl,
  Price,
  Qty,
  ResponsiveTable,
  SkeletonCard,
  Time,
  type Column,
} from '@/components/data';
import { QueryBoundary } from '@/components/overview/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useKrakenOrders, useSummary, useTrades } from '@/lib/client/queries';
import type {
  KrakenOrdersMatchFilter,
  KrakenOrdersResponse,
  OrderMatch,
  TradesResponse,
  TradesStatusFilter,
} from '@/shared/types/api';

type Row = TradesResponse['trades'][number];
type OrderRow = KrakenOrdersResponse['orders'][number];

function useUrlState() {
  const router = useRouter();
  const params = useSearchParams();
  const get = (k: string) => params.get(k) ?? undefined;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    router.replace(`/trades${next.size ? `?${next}` : ''}`, { scroll: false });
  };
  return { get, set };
}

function BotTrades({ status, bot }: { status: TradesStatusFilter; bot: string | undefined }) {
  const q = useTrades({ ...(bot ? { bot } : {}), status, limit: 200 });
  const { data: summary } = useSummary();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (!n.delete(k)) n.add(k);
      return n;
    });
  const botOf = (id: string) => summary?.bots.find((b) => b.botId === id);
  const columns: Column<Row>[] = [
    {
      key: 'bot',
      header: 'Bot',
      card: 'aside',
      cell: (t) => <BotBadge name={botOf(t.botId)?.name ?? t.botId} color={botOf(t.botId)?.color ?? '#8A93A6'} />,
    },
    {
      key: 'pair',
      header: 'Pair',
      card: 'title',
      cell: (t) => (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          aria-expanded={open.has(t.key)}
          onClick={() => toggle(t.key)}
        >
          {t.pair} <span className="text-muted">#{t.tradeId}</span>
        </Button>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => <Badge variant={t.isOpen ? 'accent' : 'muted'}>{t.isOpen ? 'Open' : 'Closed'}</Badge>,
    },
    { key: 'opened', header: 'Opened', cell: (t) => <Time at={t.openedAt} />, className: 'text-muted' },
    {
      key: 'qty',
      header: 'Qty',
      align: 'right',
      cell: (t) => <Qty value={t.isOpen ? t.pnl.openQty : t.pnl.entryQty} asset={t.base} />,
    },
    {
      key: 'pnl',
      header: 'P&L',
      align: 'right',
      card: 'full',
      cell: (t) => <Pnl usd={t.pnl.totalUsd} pct={t.pnl.roiOnStake} />,
    },
    { key: 'tag', header: 'Tag', cell: (t) => t.enterTag ?? '—', className: 'text-muted', card: 'hidden' },
    {
      key: 'chart',
      header: <span className="sr-only">Chart</span>,
      align: 'right',
      cell: (t) => (
        <Link
          className="text-accent hover:underline"
          href={`/chart?bot=${t.botId}&pair=${encodeURIComponent(t.pair)}&focus=${t.tradeId}`}
        >
          Show on chart
        </Link>
      ),
    },
  ];
  return (
    <QueryBoundary query={q} skeleton={<SkeletonCard rows={6} />}>
      {(d) => (
        <>
          <p className="text-sm text-muted">
            {d.total} trades · realized <Money value={d.totals.realizedUsd} signed /> · unrealized{' '}
            <Money value={d.totals.unrealizedUsd} signed /> · fees <Money value={d.totals.feesUsd} />
          </p>
          <ResponsiveTable
            caption="Bot trades"
            columns={columns}
            rows={d.trades}
            rowKey={(t) => t.key}
            isExpanded={(t) => open.has(t.key)}
            renderExpanded={(t) => (
              <ul className="flex flex-col gap-1 py-1 text-xs" aria-label="Orders">
                {t.orders.map((o) => (
                  <li key={o.orderId} className="flex flex-wrap items-center gap-x-3">
                    <MatchIcon match={(t.krakenMatch[o.orderId] ?? 'unknown') as OrderMatch} />
                    <span className="w-10 text-muted">{o.isEntry ? 'entry' : 'exit'}</span>
                    <Qty value={o.filled} /> <span className="text-muted">@</span> <Price value={o.price} />
                    <code className="text-muted">{o.orderId}</code>
                  </li>
                ))}
              </ul>
            )}
            empty={<EmptyState title="No trades match" />}
          />
        </>
      )}
    </QueryBoundary>
  );
}

function KrakenOrders({ match }: { match: KrakenOrdersMatchFilter }) {
  const q = useKrakenOrders({ match, limit: 200 });
  const columns: Column<OrderRow>[] = [
    {
      key: 'pair',
      header: 'Pair',
      card: 'title',
      cell: (o) => <span className="font-medium">{o.pair ?? o.krakenPair}</span>,
    },
    { key: 'side', header: 'Side', cell: (o) => o.side },
    { key: 'status', header: 'Status', cell: (o) => <Badge variant="muted">{o.status}</Badge>, card: 'aside' },
    { key: 'at', header: 'Opened', cell: (o) => <Time at={o.openedAt} />, className: 'text-muted' },
    { key: 'vol', header: 'Filled', align: 'right', cell: (o) => <Qty value={o.volExec} /> },
    { key: 'cost', header: 'Cost', align: 'right', cell: (o) => <Money value={o.costUsd} /> },
    {
      key: 'match',
      header: 'Bot match',
      card: 'full',
      cell: (o) =>
        o.match ? (
          <span>
            {o.match.botId} #{o.match.tradeId}
          </span>
        ) : o.ack ? (
          <Badge variant="muted">{o.ack.label}</Badge>
        ) : o.createdByBotLog ? (
          <Badge variant="warning">in {o.createdByBotLog} log only</Badge>
        ) : (
          <Badge variant="critical">unmatched</Badge>
        ),
    },
    { key: 'txid', header: 'Order', cell: (o) => <code className="text-xs text-muted">{o.txid}</code>, card: 'hidden' },
  ];
  return (
    <QueryBoundary query={q} skeleton={<SkeletonCard rows={6} />}>
      {(d) =>
        !d.enabled ? (
          <EmptyState
            title="Kraken key not configured"
            description="Order reconciliation needs a read-only Kraken key."
            action={
              <Link className="text-accent hover:underline" href="/status">
                Kraken setup
              </Link>
            }
          />
        ) : (
          <ResponsiveTable
            caption="Kraken orders"
            columns={columns}
            rows={d.orders}
            rowKey={(o) => o.txid}
            empty={<EmptyState title="No Kraken orders" />}
          />
        )
      }
    </QueryBoundary>
  );
}

export function TradesView() {
  const { get, set } = useUrlState();
  const tab = get('tab') === 'kraken' ? 'kraken' : 'bots';
  const status = (
    ['open', 'closed', 'all'].includes(get('status') ?? '') ? get('status') : 'all'
  ) as TradesStatusFilter;
  const match = (
    ['all', 'unmatched', 'matched', 'acked'].includes(get('match') ?? '') ? get('match') : 'all'
  ) as KrakenOrdersMatchFilter;
  const { data: summary } = useSummary();
  const bot = get('bot');
  return (
    <div className="flex flex-col gap-4" data-testid="trades-page">
      <h1 className="sr-only">Trades</h1>
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === 'bots' ? null : v })}>
        <TabsList>
          <TabsTrigger value="bots">Bot trades</TabsTrigger>
          <TabsTrigger value="kraken">Kraken orders</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'bots' ? (
        <>
          <div className="flex flex-wrap gap-3">
            <ToggleGroup
              type="single"
              value={status}
              aria-label="Status"
              onValueChange={(v) => v && set({ status: v === 'all' ? null : v })}
            >
              {(['all', 'open', 'closed'] as const).map((s) => (
                <ToggleGroupItem key={s} value={s}>
                  {s}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              type="single"
              value={bot ?? 'all'}
              aria-label="Bot"
              onValueChange={(v) => v && set({ bot: v === 'all' ? null : v })}
            >
              <ToggleGroupItem value="all">all bots</ToggleGroupItem>
              {(summary?.bots ?? []).map((b) => (
                <ToggleGroupItem key={b.botId} value={b.botId}>
                  {b.name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <BotTrades status={status} bot={bot} />
        </>
      ) : (
        <>
          <ToggleGroup
            type="single"
            value={match}
            aria-label="Match"
            onValueChange={(v) => v && set({ match: v === 'all' ? null : v })}
          >
            {(['all', 'unmatched', 'matched', 'acked'] as const).map((s) => (
              <ToggleGroupItem key={s} value={s}>
                {s}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <KrakenOrders match={match} />
        </>
      )}
    </div>
  );
}

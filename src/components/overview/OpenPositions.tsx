'use client';

import Link from 'next/link';
import { BotBadge, Metric, Money, Pnl, Price, Qty, ResponsiveTable, TimeAgo, type Column } from '@/components/data';
import { EmptyState } from '@/components/data';
import type { BotTrade } from '@/shared/types/domain';

export function OpenPositions({
  trades,
  bots,
}: {
  trades: readonly BotTrade[];
  bots: readonly { botId: string; name: string; color: string }[];
}) {
  const botOf = (id: string) => bots.find((b) => b.botId === id);
  const columns: Column<BotTrade>[] = [
    {
      key: 'bot',
      header: 'Bot',
      cell: (t) => <BotBadge name={botOf(t.botId)?.name ?? t.botId} color={botOf(t.botId)?.color ?? '#8A93A6'} />,
      card: 'aside',
    },
    {
      key: 'pair',
      header: 'Pair',
      cell: (t) => (
        <Link
          href={`/chart?bot=${t.botId}&pair=${encodeURIComponent(t.pair)}&focus=${t.tradeId}`}
          className="font-medium hover:underline"
        >
          {t.pair}
        </Link>
      ),
      card: 'title',
    },
    { key: 'qty', header: 'Qty', align: 'right', cell: (t) => <Qty value={t.pnl.openQty} asset={t.base} /> },
    {
      key: 'entry',
      header: 'Avg entry',
      align: 'right',
      cell: (t) => <Price value={t.pnl.openQty > 0 ? t.pnl.costBasisUsd / Math.max(t.pnl.entryQty, 1e-12) : null} />,
    },
    {
      key: 'mark',
      header: 'Mark',
      align: 'right',
      cell: (t) => (
        <Metric
          value={<Price value={t.pnl.markPrice} />}
          sources={[`bot:${t.botId}:status`, 'market:ticker']}
          asOf={false}
        />
      ),
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      cell: (t) => (
        <Metric
          value={<Money value={t.pnl.markPrice === null ? null : t.pnl.markPrice * t.pnl.openQty} />}
          sources={[`bot:${t.botId}:status`, 'market:ticker']}
          asOf={false}
        />
      ),
    },
    {
      key: 'pnl',
      header: 'uPnL',
      align: 'right',
      cell: (t) => (
        <Metric
          value={
            <Pnl
              usd={t.pnl.unrealizedUsd}
              pct={
                t.pnl.unrealizedUsd !== null && t.pnl.costBasisUsd > 0 ? t.pnl.unrealizedUsd / t.pnl.costBasisUsd : null
              }
            />
          }
          sources={[`bot:${t.botId}:status`, 'market:ticker']}
          asOf={false}
        />
      ),
      card: 'full',
    },
    { key: 'age', header: 'Age', align: 'right', cell: (t) => <TimeAgo at={t.openedAt} /> },
    { key: 'entries', header: 'Entries', align: 'right', cell: (t) => t.entries, card: 'hidden' },
  ];
  return (
    <ResponsiveTable
      caption="Open positions"
      columns={columns}
      rows={trades}
      rowKey={(t) => t.key}
      empty={<EmptyState title="No open positions" />}
    />
  );
}

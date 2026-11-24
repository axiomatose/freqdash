'use client';

import { EmptyState, Metric, Money, Pnl, Price, Qty, ResponsiveTable, TimeAgo, type Column } from '@/components/data';
import { formatQty } from '@/lib/client/format';
import { usePositions } from '@/lib/client/queries';
import type { PositionsResponse } from '@/shared/types/api';
import type { ManualPosition } from '@/shared/types/domain';
import { QueryBoundary } from './QueryBoundary';

const SOURCES = ['kraken:balance', 'kraken:closedOrders'];

const INFLOW_LABEL = {
  deposit: 'deposited',
  transfer: 'transferred in',
  reward: 'rewards',
  convert: 'converted',
  other: 'other',
} as const;

function BasisNote({ p }: { p: ManualPosition }) {
  if (p.basisQty <= 0) return <span className="text-muted">No Kraken buy found</span>;
  if (p.unknownQty <= 1e-9) return <TimeAgo at={p.firstBuyAt} prefix="since " className="text-muted" />;
  const sources = p.inflows.map((i) => `${formatQty(i.qty)} ${INFLOW_LABEL[i.kind]}`).join(', ');
  return (
    <span className="text-muted">
      <Qty value={p.unknownQty} /> unpriced{sources === '' ? '' : ` (${sources})`}
    </span>
  );
}

function columns(): Column<ManualPosition>[] {
  return [
    { key: 'asset', header: 'Asset', cell: (p) => <span className="font-medium">{p.asset}</span>, card: 'title' },
    { key: 'qty', header: 'Qty', align: 'right', cell: (p) => <Qty value={p.qty} /> },
    { key: 'entry', header: 'Avg entry', align: 'right', cell: (p) => <Price value={p.avgEntryUsd} /> },
    { key: 'breakeven', header: 'Break-even', align: 'right', cell: (p) => <Price value={p.breakEvenUsd} /> },
    { key: 'price', header: 'Price', align: 'right', cell: (p) => <Price value={p.priceUsd} /> },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      cell: (p) => <Metric value={<Money value={p.valueUsd} />} sources={SOURCES} asOf={false} />,
    },
    {
      key: 'pnl',
      header: 'Since opening',
      align: 'right',
      cell: (p) => <Pnl usd={p.unrealizedUsd} pct={p.unrealizedPct} />,
      card: 'aside',
    },
    {
      key: 'basis',
      header: 'Basis',
      cell: (p) => <BasisNote p={p} />,
    },
  ];
}

function Content({ data }: { data: PositionsResponse }) {
  if (!data.enabled)
    return <EmptyState title="Positions need Kraken" description="Cost basis is derived from Kraken order history." />;
  return (
    <div className="flex flex-col gap-2">
      <ResponsiveTable
        caption="Manual positions"
        columns={columns()}
        rows={data.positions}
        rowKey={(p) => p.asset}
        empty={
          <EmptyState
            title="No manual positions"
            description="Label a holding as manual in Holdings to track it here."
          />
        }
      />
      <p className="text-xs text-muted">
        Avg entry is the average fill price of the Kraken orders no bot owns. Break-even adds the buy fees, and
        since-opening P&amp;L is measured from it. Quantity without a Kraken buy (transfers, rewards, or bought before
        history starts{data.historyStartAt === null ? '' : ' '}
        {data.historyStartAt === null ? null : <TimeAgo at={data.historyStartAt} />}) is not priced.
      </p>
    </div>
  );
}

export function ManualPositions() {
  const query = usePositions();
  return <QueryBoundary query={query}>{(data) => <Content data={data} />}</QueryBoundary>;
}

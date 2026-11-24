import { Time } from '@/components/data';

export const FEE_REASON: Record<string, string> = {
  bot_fee_rate_missing: 'The bot recorded no fee rate',
  kraken_fee_above_schedule: "Kraken charged more than your tier's taker fee",
  bot_fee_differs_from_kraken: "The bot's fee rate differs from what Kraken charged",
  bot_fee_out_of_range: "The bot's fee rate is above what your fee tier explains (no Kraken order to compare with)",
};

export const formatRate = (v: unknown): string => (typeof v === 'number' ? `${(v * 100).toFixed(3)}%` : '—');

/** Fee findings carry `reasons` and rates per order instead of stake and Kraken status. */
export function isFeeOrders(orders: readonly Record<string, unknown>[]): boolean {
  return orders.some((o) => Array.isArray(o.reasons));
}

export function FeeEvidence({ orders }: { orders: readonly Record<string, unknown>[] }) {
  return (
    <div className="flex flex-col gap-3">
      {orders.map((o) => (
        <div key={String(o.orderId)} className="rounded-lg border p-3 text-xs" data-testid="fee-order">
          <div className="flex flex-wrap items-center gap-2">
            <code>{String(o.orderId)}</code>
            {typeof o.at === 'number' ? <Time at={o.at} /> : null}
          </div>
          <ul className="mt-1 list-disc pl-4 text-sm">
            {(Array.isArray(o.reasons) ? (o.reasons as string[]) : []).map((r) => (
              <li key={r}>{FEE_REASON[r] ?? r}</li>
            ))}
          </ul>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
            <dt className="text-muted">Bot recorded</dt>
            <dd>{formatRate(o.botRate)}</dd>
            <dt className="text-muted">Kraken charged</dt>
            <dd>{formatRate(o.krakenRate)}</dd>
            <dt className="text-muted">Expected taker</dt>
            <dd>
              {formatRate(o.expectedTaker)}{' '}
              <span className="text-muted">
                {o.expectedSource === 'kraken-tier'
                  ? '(your Kraken fee tier)'
                  : '(built-in fallback: Kraken fee tier not available)'}
              </span>
            </dd>
          </dl>
        </div>
      ))}
    </div>
  );
}

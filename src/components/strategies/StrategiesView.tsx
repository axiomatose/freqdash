'use client';

import { useState } from 'react';
import { EmptyState, ResponsiveTable, SkeletonCard, type Column } from '@/components/data';
import { QueryBoundary } from '@/components/overview/QueryBoundary';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUsd } from '@/lib/client/format';
import { useStrategies } from '@/lib/client/queries';
import type { FeeImpactTrade, StrategyView } from '@/shared/types/strategy';

const FEE_CHOICES: { label: string; value: number | undefined }[] = [
  { label: 'Entry fee (freqtrade default)', value: undefined },
  { label: '0.16% (current fallback)', value: 0.0016 },
  { label: '0.25% (old Kraken maker)', value: 0.0025 },
  { label: '0.40% (actual maker)', value: 0.004 },
];

const pct = (v: number | null, dp = 2): string => (v === null ? '—' : `${(v * 100).toFixed(dp)}%`);
const yesNo = (v: boolean | null): string => (v === null ? '—' : v ? 'yes' : 'no');

function Param({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums text-right">{value}</dd>
    </div>
  );
}

function Params({ s }: { s: StrategyView }) {
  const p = s.params;
  if (p === null) return <p className="text-sm text-muted">No parameters available.</p>;
  return (
    <dl className="grid gap-x-6 sm:grid-cols-2">
      <Param label="Timeframe" value={p.timeframe ?? '—'} />
      <Param label="Max open trades" value={p.maxOpenTrades ?? '—'} />
      <Param label="ROI target" value={p.minimalRoi.map(([m, r]) => `${pct(r, 1)} @ ${m}m`).join(', ') || '—'} />
      <Param label="Stoploss" value={pct(p.stoploss, 1)} />
      <Param label="Trailing stop" value={yesNo(p.trailingStop)} />
      <Param label="Trailing arms at" value={pct(p.trailingStopPositiveOffset, 1)} />
      <Param label="Trails behind peak" value={pct(p.trailingStopPositive, 1)} />
      <Param label="Exit signals" value={yesNo(p.useExitSignal)} />
      <Param label="Exit only when profitable" value={yesNo(p.exitProfitOnly)} />
      <Param label="DCA adds (position adjustment)" value={yesNo(p.positionAdjustmentEnable)} />
      <Param label="Config `fee` (dry-run only)" value={pct(p.configFee)} />
    </dl>
  );
}

function FeeTable({ trades }: { trades: FeeImpactTrade[] }) {
  const columns: Column<FeeImpactTrade>[] = [
    { key: 'trade', header: 'Trade', card: 'title', cell: (t) => `#${t.tradeId} ${t.pair}` },
    { key: 'exit', header: 'Exit', card: 'aside', cell: (t) => t.exitReason ?? '—' },
    { key: 'gross', header: 'Gross move', align: 'right', cell: (t) => pct(t.grossRatio) },
    { key: 'fees', header: 'Fees paid', align: 'right', cell: (t) => `${pct(t.feeOpenRate)} + ${pct(t.feeCloseRate)}` },
    { key: 'actual', header: 'Actual profit', align: 'right', cell: (t) => pct(t.actualProfitRatio) },
    { key: 'assumed', header: 'Bot thought', align: 'right', cell: (t) => pct(t.assumedProfitRatio) },
    { key: 'gap', header: 'Close-fee gap', align: 'right', cell: (t) => formatUsd(-t.closeFeeGapUsd) },
    {
      key: 'flip',
      header: 'Gate',
      card: 'aside',
      cell: (t) =>
        t.gateFlipped ? <Badge variant="warning">would not pass</Badge> : <span className="text-muted">ok</span>,
    },
  ];
  return (
    <ResponsiveTable
      caption="Closed trades replayed with actual fees"
      columns={columns}
      rows={trades}
      rowKey={(t) => String(t.tradeId)}
      empty={<EmptyState title="No closed trades with fee data yet" />}
    />
  );
}

function StrategyCard({ s, fee }: { s: StrategyView; fee: number | undefined }) {
  const [code, setCode] = useState(false);
  const impact = s.feeImpact;
  return (
    <Card aria-label={`${s.botName} strategy`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {s.botName}
          <Badge variant="muted">{s.strategy ?? 'unknown strategy'}</Badge>
          {s.sourceLines !== null ? (
            <span className="text-xs font-normal text-muted">{s.sourceLines} lines</span>
          ) : null}
          {s.sourceSha256 !== null ? (
            <span className="font-mono text-xs font-normal text-muted" title="SHA-256 of the source file">
              {s.sourceSha256.slice(0, 10)}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {s.error !== null ? <p className="text-sm text-critical-fg">Could not load: {s.error}</p> : null}
        <Params s={s} />
        {s.docstring !== null ? (
          <pre className="whitespace-pre-wrap rounded-lg border bg-surface-2 p-3 text-xs text-muted">{s.docstring}</pre>
        ) : null}
        {s.hooks.length > 0 ? (
          <p className="text-sm">
            <span className="text-muted">Overrides: </span>
            {s.hooks.map((h) => (
              <code key={h} className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                {h}
              </code>
            ))}
          </p>
        ) : null}
        {s.constants.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">Tuning constants ({s.constants.length})</summary>
            <dl className="mt-2 grid gap-x-6 sm:grid-cols-2">
              {s.constants.map((c) => (
                <Param key={c.name} label={c.name} value={<code>{c.value}</code>} />
              ))}
            </dl>
          </details>
        ) : null}

        {impact !== null ? (
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Does the fee gap change what this bot does?</h3>
            <ul className="flex flex-col gap-2 text-sm">
              {impact.sensitivities.map((x) => (
                <li key={x.key} className="rounded-lg border p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{x.label}</span>
                    <Badge variant={x.active ? 'warning' : 'muted'}>{x.active ? 'in use' : 'not used'}</Badge>
                    {x.active && x.shiftPoints !== null ? (
                      <span className="text-xs text-muted">shifts ≈ {x.shiftPoints.toFixed(2)} pts</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-muted">{x.effect}</p>
                </li>
              ))}
            </ul>
            <p className="text-sm">
              {impact.summary.trades} closed trades: average close fee{' '}
              <strong>{pct(impact.summary.actualCloseFeeAvg)}</strong> vs assumed{' '}
              <strong>{pct(impact.summary.assumedCloseFee)}</strong>; profit-gated exits{' '}
              <strong>{impact.summary.profitGatedExits}</strong>, of which <strong>{impact.summary.gateFlips}</strong>{' '}
              would not have passed with the real fee. Total close-fee gap{' '}
              <strong>{formatUsd(-impact.summary.totalCloseFeeGapUsd)}</strong>.
            </p>
            <FeeTable trades={impact.trades} />
            <p className="text-xs text-muted">{impact.note}</p>
          </section>
        ) : null}

        <button
          type="button"
          className="w-fit text-sm text-accent underline-offset-2 hover:underline"
          onClick={() => setCode((v) => !v)}
        >
          {code ? 'Hide source' : 'Show source'}
        </button>
        {code ? <SourceBlock botId={s.botId} fee={fee} /> : null}
      </CardContent>
    </Card>
  );
}

function SourceBlock({ botId, fee }: { botId: string; fee: number | undefined }) {
  const q = useStrategies({ code: true, assumedFee: fee }, { refetchInterval: false });
  const code = q.data?.bots.find((b) => b.botId === botId)?.code;
  if (q.isError) return <p className="text-sm text-critical-fg">Could not load the source.</p>;
  if (code === undefined || code === null) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <pre className="max-h-[32rem] overflow-auto rounded-lg border bg-surface-2 p-3 text-xs leading-relaxed">{code}</pre>
  );
}

export function StrategiesView() {
  const [fee, setFee] = useState<number | undefined>(undefined);
  const query = useStrategies({ assumedFee: fee });
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-4 text-sm">
          <span className="text-muted">Close fee the bots believed while a trade was open:</span>
          {FEE_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              aria-pressed={fee === c.value}
              onClick={() => setFee(c.value)}
              className={`min-h-11 rounded-lg border px-3 ${fee === c.value ? 'border-accent text-accent' : 'text-muted'}`}
            >
              {c.label}
            </button>
          ))}
        </CardContent>
      </Card>
      <QueryBoundary query={query} skeleton={<SkeletonCard />}>
        {(d) => (
          <div className="flex flex-col gap-4">
            {d.bots.map((s) => (
              <StrategyCard key={s.botId} s={s} fee={fee} />
            ))}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Layers } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, FreshnessProvider, Qty, SkeletonCard, Time } from '@/components/data';
import { Button } from '@/components/ui/button';
import { ResponsiveSheet } from '@/components/ui/responsive-sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useIsDesktop } from '@/lib/client/useMediaQuery';
import { usePrefs } from '@/lib/client/prefs';
import { useAcks, useBot, useChart, useSummary } from '@/lib/client/queries';
import type { ChartData } from '@/shared/types/domain';
import {
  FIXED_LAYERS,
  MAX_MOBILE_PANES,
  activePanes,
  indicatorPanes,
  isOn,
  parseLayerState,
  seriesIn,
  serialize,
  toggle,
} from './layers';

const PriceChart = dynamic(() => import('./PriceChart'), { ssr: false, loading: () => <SkeletonCard rows={8} /> });

const RANGES = [
  { value: '1w', label: '1W', sec: 7 * 86_400 },
  { value: '1m', label: '1M', sec: 30 * 86_400 },
  { value: '3m', label: '3M', sec: 90 * 86_400 },
  { value: 'all', label: 'All', sec: Infinity },
] as const;
const TF_SEC: Record<string, number> = { '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 };
const PRICE_ONLY_TFS = ['15m', '1h', '1d'];
/** The third chart source: assets labelled manual, drawn from Kraken orders no bot owns. */
export const MANUAL_ID = 'manual';
const MANUAL_BOT = { botId: MANUAL_ID, name: 'Manual', color: '#F5A524' };
const FIXED_LABEL: Record<(typeof FIXED_LAYERS)[number], string> = {
  signals: 'Signals',
  fills: 'Fills',
  others: "Other bots' fills",
  orphans: 'Kraken orphans',
  volume: 'Volume',
};

export function limitFor(range: string, tf: string): number {
  const r = RANGES.find((x) => x.value === range) ?? RANGES[1];
  return Number.isFinite(r.sec) ? Math.min(1000, Math.max(50, Math.ceil(r.sec / (TF_SEC[tf] ?? 14_400)))) : 1000;
}

export function ChartView() {
  const router = useRouter();
  const params = useSearchParams();
  const desktop = useIsDesktop();
  const { utc } = usePrefs();
  const summary = useSummary();
  const summaryBots = summary.data?.bots;
  const bots = useMemo(() => [...(summaryBots ?? []), ...(summaryBots ? [MANUAL_BOT] : [])], [summaryBots]);
  const botId = params.get('bot') ?? bots[0]?.botId ?? '';
  const isManual = botId === MANUAL_ID;
  const botQ = useBot(botId, { enabled: botId !== '' && !isManual });
  const acks = useAcks({ enabled: isManual });
  const strategyTf = isManual ? '4h' : (botQ.data?.bot.config?.timeframe ?? '4h');
  const manualPairs = useMemo(
    () =>
      (acks.data?.acks ?? []).filter((a) => a.kind === 'asset' && a.label === 'manual').map((a) => `${a.subject}/USD`),
    [acks.data],
  );
  const whitelist = isManual ? manualPairs : (botQ.data?.whitelist ?? []);
  const pair = params.get('pair') ?? whitelist[0] ?? '';
  const tf = params.get('tf') ?? strategyTf;
  const range = params.get('r') ?? '1m';
  const focus = Number(params.get('focus')) || null;
  const layers = parseLayerState(params.get('show'), params.get('hide'));

  const chart = useChart(
    { bot: botId, pair, tf, limit: limitFor(range, tf) },
    { enabled: botId !== '' && pair !== '' },
  );
  const data = chart.data ?? null;
  const [layersOpen, setLayersOpen] = useState(false);
  const [candle, setCandle] = useState<number | null>(null);

  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      router.replace(`/chart?${next}`, { scroll: false });
    },
    [params, router],
  );

  const mobile = !desktop;
  const on = useCallback((key: string) => isOn(key, layers, data, mobile), [layers, data, mobile]);
  const botColors = useMemo(() => Object.fromEntries(bots.map((b) => [b.botId, b.color])), [bots]);

  const flip = (key: string, value: boolean) => {
    const next = toggle(key, value, layers, data, mobile);
    if (value && mobile && data) {
      const wouldOn = (k: string) => (k === key ? true : isOn(k, next, data, mobile));
      if (activePanes(data, wouldOn).length > MAX_MOBILE_PANES) {
        toast.message(`Phones show at most ${MAX_MOBILE_PANES} sub-panes; turn another one off first.`);
        return;
      }
    }
    set({ show: serialize(next.show), hide: serialize(next.hide) });
  };

  const tfOptions = [strategyTf, ...PRICE_ONLY_TFS.filter((x) => x !== strategyTf)];
  const tfLabel = (x: string) => (x === strategyTf && !isManual ? `${x} · signals` : x);
  return (
    <div className="flex flex-col gap-3" data-testid="chart-page">
      <h1 className="sr-only">Chart</h1>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={botId} onValueChange={(v) => set({ bot: v, pair: null, tf: null })}>
          <SelectTrigger aria-label="Bot" className="w-32">
            <SelectValue placeholder="Bot" />
          </SelectTrigger>
          <SelectContent>
            {bots.map((b) => (
              <SelectItem key={b.botId} value={b.botId}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={pair} onValueChange={(v) => set({ pair: v })}>
          <SelectTrigger aria-label="Pair" className="w-32">
            <SelectValue placeholder="Pair" />
          </SelectTrigger>
          <SelectContent>
            {whitelist.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup type="single" value={tf} aria-label="Timeframe" onValueChange={(v) => v && set({ tf: v })}>
          {tfOptions.map((x) => (
            <ToggleGroupItem key={x} value={x}>
              {tfLabel(x)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup type="single" value={range} aria-label="Range" onValueChange={(v) => v && set({ r: v })}>
          {RANGES.map((r) => (
            <ToggleGroupItem key={r.value} value={r.value}>
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button variant="outline" size="sm" onClick={() => setLayersOpen(true)}>
          <Layers aria-hidden /> Layers
        </Button>
      </div>

      {chart.isError && data === null ? (
        <ErrorState error={chart.error} onRetry={() => void chart.refetch()} retrying={chart.isFetching} />
      ) : data === null ? (
        pair === '' ? (
          <EmptyState
            title={isManual ? 'No manual holdings' : 'Pick a bot and pair'}
            {...(isManual ? { description: 'Label a holding as manual on the Overview to chart it here.' } : {})}
          />
        ) : (
          <SkeletonCard rows={8} />
        )
      ) : (
        <FreshnessProvider sources={data.freshness}>
          {chart.isError ? <ErrorState inline error={chart.error} offlineSince={chart.dataUpdatedAt || null} /> : null}
          {data.meta.signalsNote ? <p className="text-xs text-muted">{data.meta.signalsNote}</p> : null}
          <div className="h-[52vh] min-h-[260px] rounded-xl border bg-surface p-1 lg:h-[calc(100vh-15rem)]">
            <PriceChart
              data={data}
              on={on}
              botColors={botColors}
              mobile={mobile}
              utc={utc}
              focusTime={focus}
              onCandle={setCandle}
            />
          </div>
        </FreshnessProvider>
      )}

      <ResponsiveSheet
        open={layersOpen}
        onOpenChange={setLayersOpen}
        title="Layers"
        description="Choose what to draw on the chart."
      >
        <div className="flex flex-col gap-3">
          {FIXED_LAYERS.map((k) => (
            <LayerRow key={k} id={k} label={FIXED_LABEL[k]} checked={on(k)} onChange={(v) => flip(k, v)} />
          ))}
          {data ? (
            <>
              <h3 className="eyebrow mt-2">Overlays</h3>
              {data.indicators
                .filter((i) => i.placement === 'main')
                .map((i) => (
                  <LayerRow
                    key={i.key}
                    id={i.key}
                    label={i.label}
                    checked={on(i.key)}
                    onChange={(v) => flip(i.key, v)}
                  />
                ))}
              {indicatorPanes(data).map((pane) => (
                <div key={pane} className="flex flex-col gap-3">
                  <h3 className="eyebrow mt-2">{pane}</h3>
                  {seriesIn(data, pane).map((i) => (
                    <LayerRow
                      key={i.key}
                      id={i.key}
                      label={i.label}
                      checked={on(i.key)}
                      onChange={(v) => flip(i.key, v)}
                    />
                  ))}
                </div>
              ))}
            </>
          ) : null}
        </div>
      </ResponsiveSheet>

      <CandleSheet data={data} time={candle} onClose={() => setCandle(null)} />
    </div>
  );
}

function LayerRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} data-layer={id} />
    </label>
  );
}

function CandleSheet({ data, time, onClose }: { data: ChartData | null; time: number | null; onClose: () => void }) {
  const c = data?.candles.find((x) => x.time === time);
  const fills = data?.fills.filter((f) => f.time === time) ?? [];
  const signals = data?.signals.filter((s) => s.time === time) ?? [];
  return (
    <ResponsiveSheet
      open={time !== null && c !== undefined}
      onOpenChange={(o) => !o && onClose()}
      title={c ? `Candle ${new Date(c.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Candle'}
    >
      {c ? (
        <div className="flex flex-col gap-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
            {(['open', 'high', 'low', 'close', 'volume'] as const).map((k) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd>{c[k]}</dd>
              </div>
            ))}
          </dl>
          <section aria-label="Signals">
            <h3 className="eyebrow mb-1">Signals</h3>
            {signals.length === 0 ? (
              <p className="text-muted">None</p>
            ) : (
              signals.map((s) => (
                <p key={s.kind}>
                  {s.kind}
                  {s.tag ? ` · ${s.tag}` : ''} <span className="text-muted">({s.source})</span>
                </p>
              ))
            )}
          </section>
          <section aria-label="Fills">
            <h3 className="eyebrow mb-1">Fills</h3>
            {fills.length === 0 ? (
              <p className="text-muted">None</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {fills.map((f) => (
                  <li key={f.orderId} className="flex flex-col">
                    <span>
                      {f.isEntry ? 'Buy' : 'Sell'} <Qty value={f.qty} /> @ ${f.price}{' '}
                      <span className="text-muted">
                        · <Time at={f.at} />
                      </span>
                    </span>
                    <code className="text-xs text-muted">{f.orderId}</code>
                    {f.origin === 'kraken-manual' ? (
                      <span className="text-muted">Manual order</span>
                    ) : f.botId ? (
                      <Link className="text-accent hover:underline" href={`/bots/${f.botId}`}>
                        {f.botId} #{f.tradeId}
                      </Link>
                    ) : (
                      <span className="text-critical-fg">Not created by any bot</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </ResponsiveSheet>
  );
}

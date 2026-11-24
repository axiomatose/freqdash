'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartData } from '@/shared/types/domain';
import { PANE_HEIGHT, activePanes } from './layers';

const UP = '#2EBD85';
const DOWN = '#F6465D';
const UP_MUTED = 'rgba(46,189,133,0.45)';
const DOWN_MUTED = 'rgba(246,70,93,0.45)';

export interface PriceChartProps {
  data: ChartData;
  on: (key: string) => boolean;
  botColors: Record<string, string>;
  mobile: boolean;
  utc: boolean;
  focusTime: number | null;
  onCandle: (time: number) => void;
}

const t = (n: number) => n as UTCTimestamp;
const FIXED = ['signals', 'fills', 'others', 'orphans', 'volume'];

export function buildMarkers(
  data: ChartData,
  on: (key: string) => boolean,
  botColors: Record<string, string>,
  desktop: boolean,
): SeriesMarker<UTCTimestamp>[] {
  const out: SeriesMarker<UTCTimestamp>[] = [];
  if (on('signals')) {
    for (const s of data.signals) {
      out.push({
        time: t(s.time),
        position: s.kind === 'enter' ? 'belowBar' : 'aboveBar',
        shape: 'circle',
        color: s.kind === 'enter' ? UP : DOWN,
        size: 0.6,
      });
    }
  }
  for (const f of data.fills) {
    if (f.origin === 'kraken-orphan') {
      if (!on('orphans')) continue;
      out.push({
        time: t(f.time),
        position: 'atPriceMiddle',
        price: f.price,
        shape: 'square',
        color: '#E5484D',
        text: '?',
      });
      continue;
    }
    if (!on('fills')) continue;
    const manual = f.origin === 'kraken-manual';
    if (!manual && f.botId !== data.botId && !on('others')) continue;
    const color = (manual ? botColors[data.botId] : f.botId && botColors[f.botId]) || '#4F8CFF';
    out.push(
      f.isEntry
        ? { time: t(f.time), position: 'atPriceBottom', price: f.price, shape: 'arrowUp', color }
        : {
            time: t(f.time),
            position: 'atPriceTop',
            price: f.price,
            shape: 'arrowDown',
            color,
            ...(desktop ? { text: 'exit' } : {}),
          },
    );
  }
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}

export default function PriceChart({ data, on, botColors, mobile, utc, focusTime, onCandle }: PriceChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const [legend, setLegend] = useState<string>('');
  const onCandleRef = useRef(onCandle);
  const onRef = useRef(on);
  useEffect(() => {
    onCandleRef.current = onCandle;
    onRef.current = on;
  });
  // Layer toggles rebuild the chart; the closure itself is new on every render, its outcome is what matters.
  const layerKey = [...FIXED, ...data.indicators.map((i) => i.key)].map((k) => (on(k) ? '1' : '0')).join('');

  useEffect(() => {
    const node = el.current;
    if (node === null) return;
    const on = onRef.current;
    const chart: IChartApi = createChart(node, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8A93A6',
        attributionLogo: false,
        panes: { separatorColor: '#232838' },
      },
      grid: { vertLines: { color: '#181C25' }, horzLines: { color: '#181C25' } },
      rightPriceScale: { borderColor: '#232838' },
      timeScale: { borderColor: '#232838', timeVisible: true, rightOffset: 3 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        timeFormatter: (ts: number) => {
          const d = new Date(ts * 1000);
          return utc
            ? d.toISOString().slice(0, 16).replace('T', ' ')
            : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: true },
      kineticScroll: { touch: true, mouse: false },
      trackingMode: { exitMode: 1 },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: false,
    });
    candles.setData(
      data.candles.map((c) => ({
        time: t(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        ...(c.live
          ? { color: c.close >= c.open ? UP_MUTED : DOWN_MUTED, wickColor: c.close >= c.open ? UP_MUTED : DOWN_MUTED }
          : {}),
      })),
    );

    const panes = activePanes(data, on);
    const paneIndex = (name: string): number => panes.indexOf(name) + 1;

    for (const ind of data.indicators) {
      if (!on(ind.key)) continue;
      const pane = ind.placement === 'main' ? 0 : paneIndex(ind.pane ?? '');
      if (pane < 0 || (ind.placement === 'pane' && pane === 0)) continue;
      const points = ind.points.map((p) => ({ time: t(p.time), value: p.value }));
      if (ind.kind === 'threshold') {
        // Constant lines: a dashed price line on the pane's first series is enough.
        const host = chart.addSeries(
          LineSeries,
          { color: 'transparent', lastValueVisible: false, priceLineVisible: false },
          pane,
        );
        host.setData(points);
        const last = ind.points[ind.points.length - 1];
        if (last !== undefined)
          host.createPriceLine({
            price: last.value,
            color: ind.color,
            lineStyle: LineStyle.Dashed,
            lineWidth: 1,
            axisLabelVisible: false,
            title: ind.label,
          });
        continue;
      }
      if (ind.kind === 'histogram') {
        chart.addSeries(HistogramSeries, { color: ind.color, priceLineVisible: false }, pane).setData(points);
        continue;
      }
      const line = chart.addSeries(
        LineSeries,
        {
          color: ind.color,
          lineWidth: ind.lineWidth as 1 | 2 | 3 | 4,
          priceLineVisible: false,
          lastValueVisible: false,
          ...(ind.kind === 'step' ? { lineType: LineType.WithSteps, lineStyle: LineStyle.Dashed } : {}),
        },
        pane,
      );
      line.setData(points);
    }

    if (on('volume')) {
      chart
        .addSeries(
          HistogramSeries,
          { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
          paneIndex('Volume'),
        )
        .setData(
          data.candles.map((c) => ({
            time: t(c.time),
            value: c.volume,
            color: c.close >= c.open ? UP_MUTED : DOWN_MUTED,
          })),
        );
    }

    if (data.positions.length > 0) {
      for (const p of data.positions) {
        candles.createPriceLine({
          price: p.avgPrice,
          color: botColors[p.botId] ?? '#4F8CFF',
          lineStyle: LineStyle.Dotted,
          lineWidth: 1,
          title: p.botId === 'manual' ? 'avg entry' : `#${p.tradeId} avg`,
        });
      }
    }

    const markers = buildMarkers(data, on, botColors, !mobile);
    if (markers.length > 0) createSeriesMarkers(candles, markers);

    const height = mobile ? PANE_HEIGHT.mobile : PANE_HEIGHT.desktop;
    const all = chart.panes();
    for (let i = 1; i < all.length; i++) all[i]?.setHeight(height);

    chart.subscribeClick((param) => {
      if (typeof param.time === 'number') onCandleRef.current(param.time);
    });
    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData.get(candles) as
        { open?: number; high?: number; low?: number; close?: number } | undefined;
      if (bar?.close === undefined) return setLegend('');
      setLegend(`O ${bar.open} H ${bar.high} L ${bar.low} C ${bar.close}`);
    });

    if (focusTime !== null) {
      const span = (data.candles[1]?.time ?? 0) - (data.candles[0]?.time ?? 0) || 14_400;
      chart.timeScale().setVisibleRange({ from: t(focusTime - span * 30), to: t(focusTime + span * 10) });
    } else {
      const from = data.candles[Math.max(0, data.candles.length - 120)]?.time;
      if (from !== undefined)
        chart.timeScale().setVisibleRange({
          from: t(from),
          to: t(
            (data.candles[data.candles.length - 1]?.time ?? from) +
              3 * ((data.candles[1]?.time ?? 0) - (data.candles[0]?.time ?? 0) || 14_400),
          ),
        });
    }
    return () => chart.remove();
  }, [data, mobile, utc, focusTime, botColors, layerKey]);

  const markerCount = buildMarkers(data, on, botColors, true).length;
  return (
    <div className="relative h-full w-full">
      <div className="pointer-events-none absolute top-1 left-2 z-10 text-xs text-muted tabular-nums" aria-live="off">
        {legend}
      </div>
      <div
        ref={el}
        className="h-full w-full"
        data-testid="price-chart"
        data-candles={data.candles.length}
        data-fills={data.fills.length}
        data-signals={data.signals.length}
        data-markers={markerCount}
      />
    </div>
  );
}

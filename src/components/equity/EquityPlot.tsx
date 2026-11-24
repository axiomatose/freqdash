'use client';

import { useEffect, useRef } from 'react';
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { EquitySeriesData } from './equitySeries';

const COLORS = { text: '#8A93A6', grid: '#232838', accent: '#4F8CFF', positive: '#2EBD85', negative: '#F6465D' };

export default function EquityPlot({ data }: { data: EquitySeriesData }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = el.current;
    if (node === null) return;
    const chart = createChart(node, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: COLORS.text,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: false,
      handleScale: false,
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: COLORS.accent,
      topColor: 'rgba(79,140,255,0.28)',
      bottomColor: 'rgba(79,140,255,0)',
      lineWidth: 2,
      priceLineVisible: false,
    });
    area.setData(data.kraken.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    if (data.botWallet.length > 0) {
      const dashed = chart.addSeries(LineSeries, {
        color: COLORS.accent,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
      });
      dashed.setData(data.botWallet.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    const host = data.kraken.length > 0 ? area : null;
    if (host !== null && data.markers.length > 0) {
      createSeriesMarkers(
        host,
        data.markers.map((m) => ({
          time: m.time as UTCTimestamp,
          position: m.kind === 'deposit' ? ('belowBar' as const) : ('aboveBar' as const),
          shape: m.kind === 'deposit' ? ('arrowUp' as const) : ('arrowDown' as const),
          color: m.kind === 'deposit' ? COLORS.positive : COLORS.negative,
          text: m.text,
        })),
      );
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);

  return (
    <div
      ref={el}
      data-testid="equity-chart"
      data-points={data.kraken.length + data.botWallet.length}
      className="h-full w-full"
    />
  );
}

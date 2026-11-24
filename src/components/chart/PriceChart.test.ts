import { describe, expect, it } from 'vitest';
import type { ChartData, FillMarker } from '@/shared/types/domain';
import { buildMarkers } from './PriceChart';

const fill = (over: Partial<FillMarker>): FillMarker => ({
  time: 100,
  at: 100_000,
  botId: null,
  tradeId: null,
  orderId: 'o',
  side: 'buy',
  isEntry: true,
  price: 10,
  qty: 1,
  costUsd: 10,
  tag: null,
  origin: 'kraken-manual',
  ...over,
});
const chart = (fills: FillMarker[]): ChartData => ({
  botId: 'manual',
  pair: 'ETH/USD',
  timeframe: '4h',
  source: 'kraken',
  strategy: null,
  candles: [],
  indicators: [],
  signals: [],
  fills,
  positions: [],
  meta: { lastAnalyzedAt: null, dataStopAt: null, liveCandle: false, signalsNote: null },
  freshness: [],
});

describe('buildMarkers for manual fills', () => {
  const colors = { manual: '#F5A524' };
  it('draws entries and exits in the manual colour, not as orphans, without the others layer', () => {
    const data = chart([fill({ orderId: 'b' }), fill({ orderId: 's', time: 200, isEntry: false, side: 'sell' })]);
    const markers = buildMarkers(data, (k) => k === 'fills', colors, true);
    expect(markers.map((m) => [m.shape, m.color])).toEqual([
      ['arrowUp', '#F5A524'],
      ['arrowDown', '#F5A524'],
    ]);
  });

  it('hides them with the fills layer, and orphans stay separate', () => {
    const data = chart([fill({}), fill({ origin: 'kraken-orphan', orderId: 'x' })]);
    expect(buildMarkers(data, () => false, colors, true)).toEqual([]);
    expect(buildMarkers(data, (k) => k === 'orphans', colors, true).map((m) => m.text)).toEqual(['?']);
  });
});

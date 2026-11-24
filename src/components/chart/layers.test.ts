import { describe, expect, it } from 'vitest';
import type { ChartData } from '@/shared/types/domain';
import { activePanes, isOn, parseLayerState, serialize, toggle } from './layers';

const ind = (key: string, pane: string | null, visible: boolean) => ({
  key,
  label: key,
  placement: pane ? 'pane' : 'main',
  pane,
  kind: 'line',
  color: '#fff',
  lineWidth: 1,
  defaultVisible: visible,
  points: [],
});
const data = {
  indicators: [
    ind('ema20', null, true),
    ind('rsi', 'RSI', true),
    ind('entry_score', 'Score', true),
    ind('touch_sup', 'Touches', true),
  ],
} as unknown as ChartData;

describe('layer state', () => {
  it('stores only deviations from the defaults and round-trips through the URL', () => {
    let s = parseLayerState(null, null);
    s = toggle('fills', false, s, data, false);
    s = toggle('others', true, s, data, false);
    s = toggle('fills', true, s, data, false);
    expect(serialize(s.hide)).toBeNull();
    expect(serialize(s.show)).toBe('others');
    const back = parseLayerState('others', 'volume');
    expect(isOn('others', back, data, false)).toBe(true);
    expect(isOn('volume', back, data, false)).toBe(false);
  });

  it('defaults volume off on mobile, on for desktop', () => {
    const s = parseLayerState(null, null);
    expect(isOn('volume', s, data, false)).toBe(true);
    expect(isOn('volume', s, data, true)).toBe(false);
  });

  it('counts sub-panes with a visible series (plus volume)', () => {
    const s = parseLayerState(null, null);
    expect(activePanes(data, (k) => isOn(k, s, data, false))).toEqual(['RSI', 'Score', 'Touches', 'Volume']);
    expect(activePanes(data, (k) => isOn(k, s, data, true))).toEqual(['RSI', 'Score', 'Touches']);
  });

  it('ignores junk in the URL', () => {
    expect(parseLayerState('a,b c,../x', null).show.size).toBe(1);
  });
});

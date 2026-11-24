import type { ChartData, IndicatorSeries } from '@/shared/types/domain';

// Layer toggles live in the URL (`show` / `hide` lists of layer keys that differ from the defaults), so a chart view
// can be shared and survives a reload.

export const FIXED_LAYERS = ['signals', 'fills', 'others', 'orphans', 'volume'] as const;
export type FixedLayer = (typeof FIXED_LAYERS)[number];

export const MAX_MOBILE_PANES = 2;

export function defaultOn(key: string, data: ChartData | null, mobile: boolean): boolean {
  if ((FIXED_LAYERS as readonly string[]).includes(key)) {
    if (key === 'others') return false;
    if (key === 'volume') return !mobile;
    return true;
  }
  return data?.indicators.find((i) => i.key === key)?.defaultVisible ?? false;
}

export interface LayerState {
  show: ReadonlySet<string>;
  hide: ReadonlySet<string>;
}

export function parseLayerState(show: string | null, hide: string | null): LayerState {
  const set = (v: string | null) => new Set((v ?? '').split(',').filter((s) => /^[\w]{1,40}$/.test(s)));
  return { show: set(show), hide: set(hide) };
}

export function isOn(key: string, state: LayerState, data: ChartData | null, mobile: boolean): boolean {
  if (state.hide.has(key)) return false;
  if (state.show.has(key)) return true;
  return defaultOn(key, data, mobile);
}

/** New show/hide sets after toggling `key` to `on` (an entry is stored only when it differs from the default). */
export function toggle(
  key: string,
  on: boolean,
  state: LayerState,
  data: ChartData | null,
  mobile: boolean,
): LayerState {
  const show = new Set(state.show);
  const hide = new Set(state.hide);
  show.delete(key);
  hide.delete(key);
  const def = defaultOn(key, data, mobile);
  if (on && !def) show.add(key);
  if (!on && def) hide.add(key);
  return { show, hide };
}

export function serialize(set: ReadonlySet<string>): string | null {
  return set.size === 0 ? null : [...set].sort().join(',');
}

export const PANE_HEIGHT = { desktop: 120, mobile: 96 } as const;

/** Names of the panes that will be drawn (indicator panes with a visible series, then Volume). */
export function activePanes(data: ChartData, on: (key: string) => boolean): string[] {
  const panes: string[] = [];
  for (const i of data.indicators) {
    if (i.placement === 'pane' && i.pane !== null && on(i.key) && !panes.includes(i.pane)) panes.push(i.pane);
  }
  if (on('volume')) panes.push('Volume');
  return panes;
}

export function indicatorPanes(data: ChartData): string[] {
  const out: string[] = [];
  for (const i of data.indicators)
    if (i.placement === 'pane' && i.pane !== null && !out.includes(i.pane)) out.push(i.pane);
  return out;
}

export function seriesIn(data: ChartData, pane: string): IndicatorSeries[] {
  return data.indicators.filter((i) => i.pane === pane);
}

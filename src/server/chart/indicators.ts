import type { IndicatorSeries, SeriesPoint } from '@/shared/types/domain';

// Indicator placement (docs/PLAN.md section 9): plot_config decides; columns it does not mention fall back to a
// small registry and end up hidden in an "Other" pane. Helper columns are dropped.

const PALETTE = ['#F5A524', '#B38CFF', '#2EBD85', '#F6465D', '#4F8CFF', '#12A594', '#D6409F', '#FFC53D'];
const OHLCV = new Set(['date', 'open', 'high', 'low', 'close', 'volume']);
const DROPPED = [/^rsi_prev$/, /^__date_ts$/, /^_.*_signal_close$/, /^(enter|exit)_(long|short|tag)$/];
const THRESHOLD = /(threshold|^rsi_ob$|^rsi_os$)/;
const STEP = /^(support|resistance)/;

export interface PlotEntry {
  color?: unknown;
  type?: unknown;
}
export interface PlotConfig {
  main_plot?: Record<string, PlotEntry>;
  subplots?: Record<string, Record<string, PlotEntry>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parsePlotConfig(raw: unknown): PlotConfig {
  if (!isRecord(raw)) return {};
  const cfg: PlotConfig = {};
  if (isRecord(raw.main_plot)) cfg.main_plot = raw.main_plot as Record<string, PlotEntry>;
  if (isRecord(raw.subplots)) cfg.subplots = raw.subplots as Record<string, Record<string, PlotEntry>>;
  return cfg;
}

const isDropped = (name: string): boolean => OHLCV.has(name) || DROPPED.some((re) => re.test(name));

function numeric(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pointsOf(rows: readonly Record<string, unknown>[], name: string): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const row of rows) {
    const ts = numeric(row.__date_ts);
    const value = numeric(row[name]);
    if (ts !== null && value !== null) out.push({ time: Math.floor(ts / 1000), value });
  }
  return out;
}

function kindOf(name: string, entry: PlotEntry | undefined): IndicatorSeries['kind'] {
  if (THRESHOLD.test(name)) return 'threshold';
  if (STEP.test(name)) return 'step';
  return entry?.type === 'bar' ? 'histogram' : 'line';
}

function label(name: string): string {
  return name.replace(/_/g, ' ');
}

export function buildIndicators(rows: readonly Record<string, unknown>[], plotConfigRaw: unknown): IndicatorSeries[] {
  if (rows.length === 0) return [];
  const columns = new Set(Object.keys(rows[0] ?? {}));
  const cfg = parsePlotConfig(plotConfigRaw);
  const out: IndicatorSeries[] = [];
  const used = new Set<string>();
  let colorIx = 0;
  const nextColor = (entry: PlotEntry | undefined): string =>
    typeof entry?.color === 'string' && entry.color !== ''
      ? entry.color
      : (PALETTE[colorIx++ % PALETTE.length] as string);

  const add = (
    name: string,
    entry: PlotEntry | undefined,
    placement: 'main' | 'pane',
    pane: string | null,
    visible: boolean,
  ): void => {
    if (used.has(name) || !columns.has(name) || isDropped(name)) return;
    const points = pointsOf(rows, name);
    if (points.length === 0) return;
    used.add(name);
    out.push({
      key: name,
      label: label(name),
      placement,
      pane,
      kind: kindOf(name, entry),
      color: nextColor(entry),
      lineWidth: 1,
      defaultVisible: visible,
      points,
    });
  };

  for (const [name, entry] of Object.entries(cfg.main_plot ?? {})) {
    // Only the strategy-timeframe support/resistance lines are shown at first; the multi-timeframe ones clutter.
    const visible = STEP.test(name) ? /_4h$/.test(name) : true;
    add(name, entry, 'main', null, visible);
  }
  for (const [pane, entries] of Object.entries(cfg.subplots ?? {})) {
    for (const [name, entry] of Object.entries(entries)) add(name, entry, 'pane', pane, true);
  }

  // Fallback registry for everything plot_config does not place.
  for (const name of columns) {
    if (used.has(name) || isDropped(name)) continue;
    if (/^ema/.test(name)) add(name, undefined, 'main', null, true);
    else if (STEP.test(name)) add(name, undefined, 'main', null, /_4h$/.test(name));
    else if (name === 'rsi') add(name, undefined, 'pane', 'RSI', true);
    else if (/score$/.test(name)) add(name, undefined, 'pane', 'Score', true);
    else if (THRESHOLD.test(name)) add(name, undefined, 'pane', 'Other', false);
    else add(name, undefined, 'pane', 'Other', false);
  }
  return out;
}

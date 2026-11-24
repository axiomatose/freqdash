import { createHash } from 'node:crypto';
import type { StrategyParams } from '@/shared/types/strategy';

// Pure helpers that read a strategy's source text (from freqtrade's `/strategy/<name>`) and its `/show_config` values.
// The source is only scanned as text; it is never executed or imported.

export interface SourceFacts {
  docstring: string | null;
  constants: { name: string; value: string }[];
  hooks: string[];
  sha256: string;
  lines: number;
}

const HOOKS = [
  'custom_exit',
  'custom_stoploss',
  'custom_stake_amount',
  'custom_entry_price',
  'custom_exit_price',
  'adjust_trade_position',
  'confirm_trade_entry',
  'confirm_trade_exit',
  'bot_loop_start',
  'leverage',
  'informative_pairs',
  'populate_indicators',
  'populate_entry_trend',
  'populate_exit_trend',
];

/** Text of the first class docstring, dedented. */
function classDocstring(code: string): string | null {
  const m = /^class\s+\w+[^\n]*:\s*\n\s*("""|''')([\s\S]*?)\1/m.exec(code);
  if (m?.[2] === undefined) return null;
  const lines = m[2].replace(/\r/g, '').split('\n');
  const indents = lines
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.length - l.trimStart().length);
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  return lines
    .map((l, i) => (i === 0 ? l.trim() : l.slice(Math.min(cut, l.length - l.trimStart().length))))
    .join('\n')
    .trim();
}

export function readSource(code: string): SourceFacts {
  const constants: SourceFacts['constants'] = [];
  const seen = new Set<string>();
  for (const line of code.split('\n')) {
    const m = /^ {4}([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line.replace(/\r$/, ''));
    if (m?.[1] === undefined || m[2] === undefined || seen.has(m[1])) continue;
    seen.add(m[1]);
    constants.push({ name: m[1], value: m[2].replace(/\s+#.*$/, '') });
  }
  const hooks = HOOKS.filter((h) => new RegExp(`^ {4}def ${h}\\(`, 'm').test(code));
  return {
    docstring: classDocstring(code),
    constants,
    hooks,
    sha256: createHash('sha256').update(code, 'utf8').digest('hex'),
    lines: code.split('\n').length,
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** `/show_config` (loose object) to the strategy parameters. */
export function readParams(cfg: Record<string, unknown>): StrategyParams {
  const roiRaw = cfg.minimal_roi;
  const roi: [number, number][] =
    roiRaw !== null && typeof roiRaw === 'object'
      ? Object.entries(roiRaw as Record<string, unknown>)
          .map(([k, v]): [number, number] => [Number(k), Number(v)])
          .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v))
          .sort((a, b) => a[0] - b[0])
      : [];
  const ot = cfg.order_types;
  return {
    timeframe: typeof cfg.timeframe === 'string' ? cfg.timeframe : null,
    minimalRoi: roi,
    stoploss: num(cfg.stoploss),
    trailingStop: bool(cfg.trailing_stop),
    trailingStopPositive: num(cfg.trailing_stop_positive),
    trailingStopPositiveOffset: num(cfg.trailing_stop_positive_offset),
    trailingOnlyOffsetIsReached: bool(cfg.trailing_only_offset_is_reached),
    useExitSignal: bool(cfg.use_exit_signal),
    exitProfitOnly: bool(cfg.exit_profit_only),
    exitProfitOffset: num(cfg.exit_profit_offset),
    ignoreRoiIfEntrySignal: bool(cfg.ignore_roi_if_entry_signal),
    positionAdjustmentEnable: bool(cfg.position_adjustment_enable),
    maxEntryPositionAdjustment: num(cfg.max_entry_position_adjustment),
    maxOpenTrades: num(cfg.max_open_trades),
    orderTypes: ot !== null && typeof ot === 'object' ? (ot as Record<string, unknown>) : null,
    configFee: num(cfg.fee),
  };
}

const ATTR_KEYS = [
  'exit_profit_only',
  'exit_profit_offset',
  'use_exit_signal',
  'ignore_roi_if_entry_signal',
  'trailing_stop',
  'trailing_stop_positive',
  'trailing_stop_positive_offset',
  'trailing_only_offset_is_reached',
  'position_adjustment_enable',
  'max_entry_position_adjustment',
  'max_open_trades',
  'stoploss',
  'timeframe',
];

/**
 * Simple literal class attributes (`exit_profit_only = True`, `stoploss = -0.99`) read from the source text.
 * `/show_config` omits several of them (exit_profit_only among them), so these fill the gaps. Anything that is not a plain
 * literal is skipped.
 */
export function readAttributes(code: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ATTR_KEYS) {
    const m = new RegExp(String.raw`^ {4}${key}\s*=\s*([^#\n]+?)\s*(?:#.*)?$`, 'm').exec(code);
    const raw = m?.[1];
    if (raw === undefined) continue;
    if (raw === 'True') out[key] = true;
    else if (raw === 'False') out[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) out[key] = Number(raw);
    else if (/^(['"])[\w.]+\1$/.test(raw)) out[key] = raw.slice(1, -1);
  }
  return out;
}

/** show_config values win; the source only fills what freqtrade did not report. */
export function withSourceFallback(params: StrategyParams, code: string): StrategyParams {
  const a = readAttributes(code);
  const pick = <T>(cur: T | null, key: string, ok: (v: unknown) => v is T): T | null =>
    cur !== null ? cur : ok(a[key]) ? a[key] : null;
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  const isNum = (v: unknown): v is number => typeof v === 'number';
  return {
    ...params,
    exitProfitOnly: pick(params.exitProfitOnly, 'exit_profit_only', isBool),
    exitProfitOffset: pick(params.exitProfitOffset, 'exit_profit_offset', isNum),
    useExitSignal: pick(params.useExitSignal, 'use_exit_signal', isBool),
    ignoreRoiIfEntrySignal: pick(params.ignoreRoiIfEntrySignal, 'ignore_roi_if_entry_signal', isBool),
    trailingStop: pick(params.trailingStop, 'trailing_stop', isBool),
    trailingStopPositive: pick(params.trailingStopPositive, 'trailing_stop_positive', isNum),
    trailingStopPositiveOffset: pick(params.trailingStopPositiveOffset, 'trailing_stop_positive_offset', isNum),
    trailingOnlyOffsetIsReached: pick(params.trailingOnlyOffsetIsReached, 'trailing_only_offset_is_reached', isBool),
    positionAdjustmentEnable: pick(params.positionAdjustmentEnable, 'position_adjustment_enable', isBool),
    maxEntryPositionAdjustment: pick(params.maxEntryPositionAdjustment, 'max_entry_position_adjustment', isNum),
    maxOpenTrades: pick(params.maxOpenTrades, 'max_open_trades', isNum),
    stoploss: pick(params.stoploss, 'stoploss', isNum),
  };
}

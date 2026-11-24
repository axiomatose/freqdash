import { describe, expect, it } from 'vitest';
import { readAttributes, readParams, readSource, withSourceFallback } from './source';

const CODE = `from freqtrade.strategy import IStrategy


class Demo(IStrategy):
    """
    Demo strategy.

    Exits:
      - profit only
    """

    timeframe = '4h'
    ZONE_PCT = 0.015
    EXIT_THRESHOLD = 5.0  # comment
    STAKE_PCT = 0.50

    def custom_stake_amount(self, current_time):
        return 1

    def populate_entry_trend(self, dataframe, metadata):
        return dataframe
`;

describe('readSource', () => {
  const f = readSource(CODE);
  it('extracts the class docstring, dedented', () => {
    expect(f.docstring).toBe('Demo strategy.\n\nExits:\n  - profit only');
  });
  it('extracts ALL_CAPS class constants without trailing comments', () => {
    expect(f.constants).toEqual([
      { name: 'ZONE_PCT', value: '0.015' },
      { name: 'EXIT_THRESHOLD', value: '5.0' },
      { name: 'STAKE_PCT', value: '0.50' },
    ]);
  });
  it('lists overridden hooks only', () => {
    expect(f.hooks).toEqual(['custom_stake_amount', 'populate_entry_trend']);
  });
  it('hashes the exact text', () => {
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readSource(CODE + ' ').sha256).not.toBe(f.sha256);
  });
});

describe('readParams', () => {
  it('normalizes show_config values and tolerates missing ones', () => {
    const p = readParams({
      timeframe: '4h',
      minimal_roi: { '60': 0.1, '0': 0.25 },
      stoploss: -0.99,
      trailing_stop: true,
      trailing_stop_positive: 0.03,
      exit_profit_only: true,
      fee: 0.0016,
    });
    expect(p.minimalRoi).toEqual([
      [0, 0.25],
      [60, 0.1],
    ]);
    expect(p.exitProfitOnly).toBe(true);
    expect(p.trailingStopPositiveOffset).toBeNull();
    expect(p.configFee).toBe(0.0016);
    expect(readParams({}).minimalRoi).toEqual([]);
  });
});

describe('source fallback for attributes show_config omits', () => {
  const code = `class D:
    exit_profit_only = True
    stoploss = -0.99  # floor
    max_open_trades = 2
    minimal_roi = {"0": 0.25}
`;
  it('reads plain literals only', () => {
    expect(readAttributes(code)).toEqual({ exit_profit_only: true, stoploss: -0.99, max_open_trades: 2 });
  });
  it('fills nulls from the source but never overrides show_config', () => {
    const p = withSourceFallback({ ...readParams({ stoploss: -0.5 }) }, code);
    expect(p.exitProfitOnly).toBe(true);
    expect(p.maxOpenTrades).toBe(2);
    expect(p.stoploss).toBe(-0.5);
  });
});

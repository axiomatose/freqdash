import { describe, expect, it } from 'vitest';
import type { FtWalletView, KrakenBalanceEntry } from '@/shared/types/domain';
import type { CheckInput } from '../types';
import {
  HOUR,
  T0,
  ack,
  balance,
  healthyBot,
  input,
  krakenView,
  openTrade,
} from '../../../../test/fixtures/incident/builders';
import { DEFAULT_CHECK_CONFIG } from '../config';
import { untrackedHolding } from './untrackedHolding';

const PRICES = { USD: 1, ETH: 2500, BTC: 80_000, SHIB: 0.000005645, BABY: 0.0133 };

function run(balances: KrakenBalanceEntry[], over: Partial<CheckInput> = {}) {
  return untrackedHolding(
    input({ bots: [healthyBot('votemax', T0)], kraken: krakenView({ balances }), prices: PRICES, ...over }),
  );
}
const eth = (qty: number) => balance('ETH', qty, 2500);

describe('UNTRACKED_HOLDING (Kraken)', () => {
  it('flags coins that no open trade explains: critical for a traded asset worth >= $25', () => {
    const [f, ...rest] = run([balance('USD', 500, 1), eth(0.1)]);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      rule: 'UNTRACKED_HOLDING',
      fingerprint: 'UNTRACKED_HOLDING:ETH',
      severity: 'critical',
      subject: { asset: 'ETH' },
      minDurationMs: 90_000,
      clearAfterMs: 90_000,
    });
    expect(f!.evidence).toMatchObject({
      source: 'kraken',
      total: 0.1,
      claimedQty: 0,
      untrackedQty: 0.1,
      valueUsd: 250,
      tradedByBot: true,
    });
    expect(f!.title).toContain('$250.00');
  });

  it('subtracts what open bot trades hold, from any bot', () => {
    const bots = [
      healthyBot('votemax', T0, { openTrades: [openTrade('votemax', 'ETH', 0.04, 2500)] }),
      healthyBot('dca', T0, { openTrades: [openTrade('dca', 'ETH', 0.06, 2500)] }),
    ];
    expect(run([eth(0.1)], { bots })).toEqual([]);
    const [f] = run([eth(0.11)], { bots });
    expect(f!.evidence).toMatchObject({ claimedQty: 0.1 });
    expect((f!.evidence as { untrackedQty: number }).untrackedQty).toBeCloseTo(0.01, 12);
  });

  it('severity thresholds: $25 critical (traded), $5 warning, $1 info, below $1 ignored (boundaries)', () => {
    const at = (usd: number) => run([balance('ETH', usd / 2500, 2500)]);
    expect(at(25)[0]!.severity).toBe('critical');
    expect(at(24.99)[0]!.severity).toBe('warning');
    expect(at(5)[0]!.severity).toBe('warning');
    expect(at(4.99)[0]!.severity).toBe('info');
    expect(at(1)[0]!.severity).toBe('info');
    expect(at(0.99)).toEqual([]);
  });

  it('an asset that no bot trades is at most a warning, however large', () => {
    const [f] = run([balance('SHIB', 1_901_628.18, 0.000005645)]);
    expect(f).toMatchObject({ fingerprint: 'UNTRACKED_HOLDING:SHIB', severity: 'warning' });
    expect(run([balance('SHIB', 1_000_000_000, 0.000005645)])[0]!.severity).toBe('warning');
    expect(f!.evidence).toMatchObject({ tradedByBot: false });
  });

  it('the warning threshold grows to 0.5 % of a large account', () => {
    const rich = [balance('USD', 10_000, 1), balance('SHIB', 6_000_000, 0.000005645)];
    // SHIB worth $33.87: >= $5 but below 0.5 % of ~$10 034 (about $50)
    expect(run(rich)[0]!.severity).toBe('info');
    const richer = [balance('USD', 10_000, 1), balance('SHIB', 8_000_000, 0.000005645)];
    expect(run(richer)[0]!.severity).toBe('info');
    const much = [balance('USD', 10_000, 1), balance('SHIB', 10_000_000_000, 0.000005645)];
    expect(run(much)[0]!.severity).toBe('warning');
  });

  it('a traded asset of >= $25 keeps its own warning even on a big account', () => {
    expect(run([balance('USD', 100_000, 1), eth(0.0101)], { bots: [healthyBot('votemax', T0)] })[0]!.severity).toBe(
      'critical',
    );
  });

  it('never reports USD', () => {
    expect(run([balance('USD', 5000, 1)])).toEqual([]);
  });

  it('sums the wallets of one asset (spot + earn)', () => {
    const [f] = run([eth(0.005), balance('ETH', 0.005, 2500, { wallet: 'earn', krakenAsset: 'ETH.F' })]);
    expect(f!.evidence).toMatchObject({ total: 0.01, valueUsd: 25 });
    expect(f!.severity).toBe('critical');
  });

  describe('acknowledgements', () => {
    it('an asset ack without baseline covers any amount', () => {
      expect(run([eth(0.1)], { acks: [ack({ subject: 'ETH', qtyBaseline: null })] })).toEqual([]);
    });

    it('a baseline covers up to that quantity; the excess is untracked again', () => {
      const acks = [ack({ subject: 'ETH', qtyBaseline: 0.1 })];
      expect(run([eth(0.1)], { acks })).toEqual([]);
      const [f] = run([eth(0.12)], { acks });
      expect((f!.evidence as { untrackedQty: number }).untrackedQty).toBeCloseTo(0.02, 12);
      expect(f!.evidence).toMatchObject({ acknowledgedQty: 0.1 });
    });

    it('a baseline equal to the current quantity leaves no float residue behind', () => {
      const acks = [ack({ subject: 'ETH', qtyBaseline: 0.1130240889 })];
      expect(run([eth(8.9e-9 + 0.11302408)], { acks })).toEqual([]);
    });

    it('expired, revoked and other-asset acks do not count', () => {
      expect(run([eth(0.1)], { acks: [ack({ subject: 'ETH', expiresAt: T0 })] })).toHaveLength(1);
      expect(run([eth(0.1)], { acks: [ack({ subject: 'ETH', revokedAt: T0 - 1 })] })).toHaveLength(1);
      expect(run([eth(0.1)], { acks: [ack({ subject: 'SHIB' })] })).toHaveLength(1);
    });
  });

  it('is informational for an unpriced asset', () => {
    const [f] = run([balance('MYSTERY', 3, null)], { prices: { USD: 1 } });
    expect(f).toMatchObject({ fingerprint: 'UNTRACKED_HOLDING:MYSTERY', severity: 'info' });
    expect(f!.evidence).toMatchObject({ valueUsd: null, priceUsd: null });
    expect(f!.title).toContain('unpriced');
  });

  it('ignores zero balances and float dust', () => {
    expect(run([balance('ETH', 0, 2500), balance('BTC', 1e-12, 80_000)])).toEqual([]);
  });

  it('matches the live expectation: SHIB warns, BABY dust and ETH dust are ignored', () => {
    const found = run([
      balance('USD', 275.26, 1),
      balance('SHIB', 1_901_628.18, 0.000005645),
      balance('BABY', 0.21895, 0.0133),
      balance('ETH', 8.9e-9, 2500),
    ]);
    expect(found.map((f) => f.fingerprint)).toEqual(['UNTRACKED_HOLDING:SHIB']);
  });

  it('honours the configured thresholds', () => {
    const cfg = { ...DEFAULT_CHECK_CONFIG, untrackedCriticalUsd: 500 };
    expect(run([eth(0.1)], { cfg })[0]!.severity).toBe('warning');
  });
});

describe('UNTRACKED_HOLDING (bot-wallet estimate, no Kraken)', () => {
  function wallet(botId: string, syncAt: number, ethQty: number): FtWalletView {
    const c = (currency: string, qty: number, price: number) => ({
      currency,
      balance: qty,
      free: qty,
      used: 0,
      botOwned: null,
      estStakeUsd: qty * price,
      isBotManaged: false,
    });
    return {
      botId,
      fetchedAt: syncAt,
      lastWalletSyncAt: syncAt,
      currencies: [c('USD', 300, 1), c('ETH', ethQty, 2500)],
      totalUsd: 300 + ethQty * 2500,
    };
  }
  const bots = (w: FtWalletView) => [healthyBot('votemax', T0), healthyBot('dca', T0, { wallet: w })];
  const runFt = (w: FtWalletView, over: Partial<CheckInput> = {}) =>
    untrackedHolding(input({ kraken: null, prices: PRICES, bots: bots(w), ...over }));

  it('is capped at warning even for a traded asset of $300', () => {
    const [f] = runFt(wallet('dca', T0 - HOUR, 0.12));
    expect(f).toMatchObject({ fingerprint: 'UNTRACKED_HOLDING:ETH', severity: 'warning' });
    expect(f!.evidence).toMatchObject({ source: 'bot-wallet', estimatedFromBot: 'dca', asOf: T0 - HOUR });
    expect(f!.detail).toContain("dca's cached wallet");
  });

  it('explains the quantity with the open trades of all bots', () => {
    const withTrade = [
      healthyBot('votemax', T0, { openTrades: [openTrade('votemax', 'ETH', 0.12, 2500)] }),
      healthyBot('dca', T0, { wallet: wallet('dca', T0, 0.12) }),
    ];
    expect(untrackedHolding(input({ kraken: null, prices: PRICES, bots: withTrade }))).toEqual([]);
  });

  it('is silent without any wallet or Kraken data', () => {
    expect(untrackedHolding(input({ kraken: null, prices: PRICES, bots: [healthyBot('votemax', T0)] }))).toEqual([]);
  });

  it('uses Kraken balances when there are some, and the wallet when the Kraken balance list is empty', () => {
    const w = wallet('dca', T0, 0.12);
    const kraken = krakenView({ balances: [] });
    expect(untrackedHolding(input({ kraken, prices: PRICES, bots: bots(w) }))[0]!.evidence).toMatchObject({
      source: 'bot-wallet',
    });
  });
});

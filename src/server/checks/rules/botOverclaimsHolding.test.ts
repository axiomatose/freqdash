import { describe, expect, it } from 'vitest';
import type { KrakenBalanceEntry } from '@/shared/types/domain';
import type { CheckInput } from '../types';
import { T0, balance, healthyBot, input, krakenView, openTrade } from '../../../../test/fixtures/incident/builders';
import { botOverclaimsHolding } from './botOverclaimsHolding';

function run(claimed: number, balances: KrakenBalanceEntry[], over: Partial<CheckInput> = {}) {
  const bots = [healthyBot('votemax', T0, { openTrades: [openTrade('votemax', 'ETH', claimed, 2500)] })];
  return botOverclaimsHolding(input({ bots, kraken: krakenView({ balances }), ...over }));
}

describe('BOT_OVERCLAIMS_HOLDING', () => {
  it('is critical when open trades hold more of an asset than the account', () => {
    const [f] = run(1, [balance('ETH', 0.5, 2500)]);
    expect(f).toMatchObject({
      rule: 'BOT_OVERCLAIMS_HOLDING',
      fingerprint: 'BOT_OVERCLAIMS_HOLDING:ETH',
      severity: 'critical',
      minDurationMs: 90_000,
      clearAfterMs: 90_000,
    });
    expect(f!.evidence).toMatchObject({
      total: 0.5,
      claimedQty: 1,
      shortfall: 0.5,
      byBot: [{ botId: 'votemax', qty: 1 }],
    });
  });

  it('tolerates a shortfall of up to 0.2 % of the claim (boundary)', () => {
    expect(run(1, [balance('ETH', 0.9981, 2500)])).toEqual([]);
    expect(run(1, [balance('ETH', 0.9979, 2500)])).toHaveLength(1);
  });

  it('tolerates a shortfall of 1e-7 for tiny positions', () => {
    expect(run(1e-5, [balance('ETH', 1e-5 - 0.9e-7, 2500)])).toEqual([]);
    expect(run(1e-5, [balance('ETH', 1e-5 - 1.1e-7, 2500)])).toHaveLength(1);
  });

  it('is silent when the account holds enough, or more', () => {
    expect(run(1, [balance('ETH', 1, 2500)])).toEqual([]);
    expect(run(1, [balance('ETH', 2, 2500)])).toEqual([]);
  });

  it('flags an asset the account holds none of, and sums wallets and bots', () => {
    expect(run(1, [balance('USD', 5, 1)])).toHaveLength(1);
    const bots = [
      healthyBot('votemax', T0, { openTrades: [openTrade('votemax', 'ETH', 0.6, 2500)] }),
      healthyBot('dca', T0, { openTrades: [openTrade('dca', 'ETH', 0.6, 2500)] }),
    ];
    const split = [balance('ETH', 0.5, 2500), balance('ETH', 0.5, 2500, { wallet: 'earn' })];
    expect(botOverclaimsHolding(input({ bots, kraken: krakenView({ balances: split }) }))).toHaveLength(1);
    expect(
      botOverclaimsHolding(input({ bots, kraken: krakenView({ balances: [balance('ETH', 1.2, 2500)] }) })),
    ).toEqual([]);
  });

  it('needs Kraken balances: silent without Kraken or with an empty balance list', () => {
    const bots = [healthyBot('votemax', T0, { openTrades: [openTrade('votemax', 'ETH', 1, 2500)] })];
    expect(botOverclaimsHolding(input({ bots, kraken: null }))).toEqual([]);
    expect(botOverclaimsHolding(input({ bots, kraken: krakenView({ balances: [] }) }))).toEqual([]);
  });

  it('ignores closed trades', () => {
    const closed = { ...openTrade('votemax', 'ETH', 1, 2500), isOpen: false };
    const bots = [healthyBot('votemax', T0, { closedTrades: [closed] })];
    expect(botOverclaimsHolding(input({ bots, kraken: krakenView({ balances: [balance('USD', 1, 1)] }) }))).toEqual([]);
  });
});

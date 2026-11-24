import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@/shared/types/domain';
import { krakenOrder } from '../../../test/fixtures/incident/builders';
import { readLedger } from './ledger';

let n = 0;
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  ledgerId: `L${(n += 1)}`,
  refid: `R${n}`,
  at: 1_000_000,
  type: 'trade',
  subtype: null,
  asset: 'ETH',
  amount: 1,
  fee: 0,
  ...over,
});

/** Buy Crypto: USD out, asset in, one refid. */
const buyPair = (refid: string, at: number, usd: number, usdFee: number, qty: number, qtyFee = 0): LedgerEntry[] => [
  entry({ refid, at, type: 'spend', asset: 'USD', amount: -usd, fee: usdFee }),
  entry({ refid, at, type: 'receive', asset: 'ETH', amount: qty, fee: qtyFee }),
];

describe('readLedger', () => {
  it('reads a Buy Crypto spend/receive pair as an exact buy', () => {
    const r = readLedger('ETH', buyPair('P1', 5, 300, 3, 0.1), []);
    expect(r.trades).toEqual([{ refid: 'P1', at: 5, side: 'buy', qty: 0.1, costUsd: 300, feeUsd: 3 }]);
    expect(r.inflows).toEqual([]);
  });

  it('takes a fee charged in the asset off the received quantity', () => {
    expect(readLedger('ETH', buyPair('P1', 5, 300, 0, 0.1, 0.0004), []).trades[0]).toMatchObject({
      qty: expect.closeTo(0.0996, 12),
    });
  });

  it('reads the reverse pair as a sell, gross of its asset fee', () => {
    const legs = [
      entry({ refid: 'S1', at: 9, type: 'spend', asset: 'ETH', amount: -0.05, fee: 0.0001 }),
      entry({ refid: 'S1', at: 9, type: 'receive', asset: 'USD', amount: 160, fee: 1.5 }),
    ];
    expect(readLedger('ETH', legs, []).trades).toEqual([
      { refid: 'S1', at: 9, side: 'sell', qty: expect.closeTo(0.0501, 12), costUsd: 160, feeUsd: 1.5 },
    ]);
  });

  it('leaves ledger `trade` entries to the orders', () => {
    expect(readLedger('ETH', [entry({ type: 'trade', amount: 1 })], [])).toEqual({ trades: [], inflows: [] });
  });

  it('does not count a pair that an order already records (same side, size, within two minutes)', () => {
    const order = krakenOrder({ side: 'buy', volExec: 0.1, closedAt: 5 + 60_000, openedAt: 5 });
    expect(readLedger('ETH', buyPair('P1', 5, 300, 3, 0.1), [order]).trades).toEqual([]);
    const far = krakenOrder({ side: 'buy', volExec: 0.1, closedAt: 5 + 600_000, openedAt: 5 });
    expect(readLedger('ETH', buyPair('P1', 5, 300, 3, 0.1), [far]).trades).toHaveLength(1);
  });

  it('keeps a crypto-to-crypto convert as an unpriced inflow, not a priced buy', () => {
    const legs = [
      entry({ refid: 'C1', type: 'spend', asset: 'BTC', amount: -0.01 }),
      entry({ refid: 'C1', type: 'receive', asset: 'ETH', amount: 0.2, fee: 0.001 }),
    ];
    const r = readLedger('ETH', legs, []);
    expect(r.trades).toEqual([]);
    expect(r.inflows).toMatchObject([{ kind: 'convert', qty: 0.199 }]);
  });

  it('classifies unpriced arrivals and ignores moves between the account’s own wallets', () => {
    const r = readLedger(
      'ETH',
      [
        entry({ type: 'deposit', amount: 2 }),
        entry({ type: 'staking', amount: 0.01 }),
        entry({ type: 'earn', subtype: 'reward', amount: 0.02 }),
        entry({ type: 'earn', subtype: 'allocation', amount: -1 }),
        entry({ type: 'earn', subtype: 'autoallocation', amount: 1 }),
        entry({ type: 'transfer', subtype: 'spottostaking', amount: -1 }),
        entry({ type: 'transfer', subtype: 'stakingfromspot', amount: 1 }),
        entry({ type: 'transfer', subtype: '', amount: 3 }),
        entry({ type: 'credit', amount: 0.5 }),
        entry({ type: 'withdrawal', amount: -1 }),
        entry({ type: 'deposit', asset: 'BTC', amount: 9 }),
      ],
      [],
    );
    expect(r.inflows.map((i) => [i.kind, i.qty])).toEqual([
      ['deposit', 2],
      ['reward', 0.01],
      ['reward', 0.02],
      ['transfer', 3],
      ['other', 0.5],
    ]);
  });

  it('has nothing for USD', () => {
    expect(readLedger('USD', [entry({ type: 'deposit', asset: 'USD', amount: 100 })], [])).toEqual({
      trades: [],
      inflows: [],
    });
  });
});

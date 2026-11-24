import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@/shared/types/domain';
import { closeDb } from '../client';
import { installTempDb, type TempDb } from '../testing';
import { listLedgerEntries, upsertLedgerEntries } from './krakenLedger';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => {
  temp.cleanup();
  closeDb();
});

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  ledgerId: 'L1',
  refid: 'R1',
  at: 100,
  type: 'receive',
  subtype: null,
  asset: 'ETH',
  amount: 0.1,
  fee: 0,
  ...over,
});

describe('kraken ledger repo', () => {
  it('stores entries of any type, chronologically, and filters by asset and time', () => {
    upsertLedgerEntries([
      entry({ ledgerId: 'L2', at: 200, type: 'spend', asset: 'USD', amount: -300 }),
      entry({ ledgerId: 'L1' }),
      entry({ ledgerId: 'L3', at: 300, asset: 'BTC' }),
    ]);
    expect(listLedgerEntries().map((e) => e.ledgerId)).toEqual(['L1', 'L2', 'L3']);
    expect(listLedgerEntries({ assets: ['ETH', 'USD'] }).map((e) => e.ledgerId)).toEqual(['L1', 'L2']);
    expect(listLedgerEntries({ since: 250 }).map((e) => e.ledgerId)).toEqual(['L3']);
    expect(listLedgerEntries({ assets: [] })).toEqual([]);
    expect(listLedgerEntries()[0]).toEqual(entry({ ledgerId: 'L1' }));
  });

  it('is idempotent: re-syncing an entry updates it in place', () => {
    upsertLedgerEntries([entry({})]);
    upsertLedgerEntries([entry({ amount: 0.2 })]);
    expect(listLedgerEntries()).toHaveLength(1);
    expect(listLedgerEntries()[0]!.amount).toBe(0.2);
  });
});

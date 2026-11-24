import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KrakenFlow } from '@/shared/types/domain';
import { installTempDb, type TempDb } from '../testing';
import { listFlows, upsertFlows, type KrakenFlowInput } from './krakenFlows';

let temp: TempDb;
beforeEach(() => {
  temp = installTempDb();
});
afterEach(() => temp.cleanup());

const flow = (ledgerId: string, over: Partial<KrakenFlowInput> = {}): KrakenFlowInput => ({
  ledgerId,
  at: 1000,
  type: 'deposit',
  asset: 'USD',
  amount: 100,
  fee: 0,
  ...over,
});

describe('kraken flows', () => {
  it('starts empty and ignores an empty batch', () => {
    upsertFlows([]);
    expect(listFlows()).toEqual([]);
  });

  it('round-trips flows in chronological order without refid/raw', () => {
    upsertFlows([
      flow('L3', { at: 3000, type: 'withdrawal', amount: -50, fee: 0.1, refid: 'R3', raw: { any: 'thing' } }),
      flow('L1', { at: 1000 }),
      flow('L2', { at: 2000, type: 'transfer', asset: 'ETH', amount: 0.5 }),
    ]);

    const expected: KrakenFlow[] = [
      { ledgerId: 'L1', at: 1000, type: 'deposit', asset: 'USD', amount: 100, fee: 0 },
      { ledgerId: 'L2', at: 2000, type: 'transfer', asset: 'ETH', amount: 0.5, fee: 0 },
      { ledgerId: 'L3', at: 3000, type: 'withdrawal', asset: 'USD', amount: -50, fee: 0.1 },
    ];
    expect(listFlows()).toEqual(expected);
    const raw = temp.db.prepare("SELECT refid, raw_json FROM kraken_flows WHERE ledger_id = 'L3'").get();
    expect(raw).toEqual({ refid: 'R3', raw_json: '{"any":"thing"}' });
  });

  it('is idempotent by ledger id and keeps a known refid', () => {
    upsertFlows([flow('L1', { refid: 'R1' })]);
    upsertFlows([flow('L1', { type: 'other' })]);

    expect(listFlows()).toHaveLength(1);
    expect(listFlows()[0]?.type).toBe('other');
    expect(temp.db.prepare('SELECT refid FROM kraken_flows').get()).toEqual({ refid: 'R1' });
  });

  it('filters by inclusive time range and by type', () => {
    upsertFlows([
      flow('L1', { at: 1000 }),
      flow('L2', { at: 2000, type: 'withdrawal' }),
      flow('L3', { at: 3000, type: 'transfer' }),
      flow('L4', { at: 4000 }),
    ]);
    const ids = (flows: KrakenFlow[]): string[] => flows.map((f) => f.ledgerId);

    expect(ids(listFlows({ since: 2000 }))).toEqual(['L2', 'L3', 'L4']);
    expect(ids(listFlows({ until: 2000 }))).toEqual(['L1', 'L2']);
    expect(ids(listFlows({ since: 2000, until: 3000 }))).toEqual(['L2', 'L3']);
    expect(ids(listFlows({ types: ['deposit', 'withdrawal'] }))).toEqual(['L1', 'L2', 'L4']);
    expect(listFlows({ types: [] })).toEqual([]);
  });
});

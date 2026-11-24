import { describe, expect, it } from 'vitest';
import type { Finding } from '@/shared/types/findings';
import { ackPlan } from './FindingDetail';

const base = { evidence: {}, evidenceKeys: [], subject: {} } as unknown as Finding;

describe('ackPlan', () => {
  it('offers one bulk order ack with every evidence txid', () => {
    const f = { ...base, rule: 'ORPHAN_KRAKEN_ORDER', evidenceKeys: ['A', 'B'] } as Finding;
    expect(ackPlan(f)).toEqual({ kind: 'kraken_order', subjects: ['A', 'B'] });
  });

  it('pre-fills the asset baseline with the untracked quantity', () => {
    const f = {
      ...base,
      rule: 'UNTRACKED_HOLDING',
      subject: { asset: 'ETH' },
      evidence: { untrackedQty: 0.11 },
    } as Finding;
    expect(ackPlan(f)).toEqual({ kind: 'asset', subjects: ['ETH'], baseline: 0.11 });
  });

  it('offers nothing for other rules', () => {
    expect(ackPlan({ ...base, rule: 'BOT_RESTARTED' } as Finding)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { Allocation } from '@/shared/types/domain';
import { allocationSegments } from './allocation';

const alloc: Allocation = {
  totalUsd: 100,
  usdCash: 60,
  botPositions: [{ botId: 'votemax', valueUsd: 30 }],
  acknowledgedUsd: 0,
  untrackedUsd: 9,
  dustUsd: 1,
  holdings: [],
};

describe('allocationSegments', () => {
  const segs = allocationSegments(alloc, [{ botId: 'votemax', name: 'VoteMax', color: '#123456' }]);

  it('drops empty segments, keeps order and sums to 100 %', () => {
    expect(segs.map((s) => s.key)).toEqual(['cash', 'bot:votemax', 'untracked', 'dust']);
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 6);
  });

  it('uses the bot colour and stripes the untracked segment', () => {
    expect(segs.find((s) => s.key === 'bot:votemax')?.color).toBe('#123456');
    expect(segs.find((s) => s.key === 'untracked')).toMatchObject({ striped: true, color: null });
  });
});

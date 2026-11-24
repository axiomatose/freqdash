import { describe, expect, it } from 'vitest';
import { equitySeries } from './equitySeries';

describe('equitySeries', () => {
  it('splits by source, dedupes times and snaps flow markers to a point', () => {
    const d = equitySeries({
      points: [
        { t: 1_000_000, totalUsd: 10, usdCash: 1, source: 'bot-wallet' },
        { t: 1_300_000, totalUsd: 11, usdCash: 1, source: 'kraken' },
        { t: 1_300_400, totalUsd: 12, usdCash: 1, source: 'kraken' },
      ],
      flows: [{ ledgerId: 'L', at: 1_100_000, type: 'deposit', asset: 'USD', amount: 5, fee: 0 }],
    });
    expect(d.botWallet).toEqual([{ time: 1000, value: 10 }]);
    expect(d.kraken).toEqual([{ time: 1300, value: 12 }]);
    expect(d.markers).toEqual([{ time: 1300, kind: 'deposit', text: 'Deposit' }]);
  });

  it('handles no data', () => {
    expect(equitySeries({ points: [], flows: null })).toEqual({ kraken: [], botWallet: [], markers: [] });
  });
});

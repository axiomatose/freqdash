import { describe, expect, it } from 'vitest';
import type { FtWalletView } from '@/shared/types/domain';
import type { CheckInput } from '../types';
import { HOUR, MIN, T0, balance, healthyBot, input, krakenView } from '../../../../test/fixtures/incident/builders';
import { usdViewDrift } from './usdViewDrift';

function wallet(botId: string, usdQty: number, syncAt: number | null = T0 - MIN, fetchedAt = T0 - MIN): FtWalletView {
  return {
    botId,
    fetchedAt,
    lastWalletSyncAt: syncAt,
    totalUsd: usdQty,
    currencies: [
      {
        currency: 'USD',
        balance: usdQty,
        free: usdQty,
        used: 0,
        botOwned: null,
        estStakeUsd: usdQty,
        isBotManaged: true,
      },
    ],
  };
}
const bot = (id: string, usdQty: number, syncAt: number | null = T0 - MIN, fetchedAt = T0 - MIN) =>
  healthyBot(id, T0, { wallet: wallet(id, usdQty, syncAt, fetchedAt) });

function runKraken(refUsd: number, bots = [bot('votemax', refUsd)], over: Partial<CheckInput> = {}) {
  return usdViewDrift(input({ bots, kraken: krakenView({ balances: [balance('USD', refUsd, 1)] }), ...over }));
}

describe('USD_VIEW_DRIFT against Kraken', () => {
  it('is silent when the bot wallet matches Kraken spot USD', () => {
    expect(runKraken(500)).toEqual([]);
  });

  it('is an info finding that escalates to warning after 75 minutes, with a 5 minute clear timer', () => {
    const [f] = runKraken(500, [bot('votemax', 300)]);
    expect(f).toMatchObject({
      rule: 'USD_VIEW_DRIFT',
      fingerprint: 'USD_VIEW_DRIFT:votemax',
      severity: 'info',
      escalateAfterMs: 75 * MIN,
      escalateTo: 'warning',
      clearAfterMs: 5 * MIN,
    });
    expect(f!.evidence).toMatchObject({ botUsd: 300, refUsd: 500, diffUsd: -200, refSource: 'kraken' });
  });

  it('allows max($2, 1 % of the reference) (boundaries)', () => {
    expect(runKraken(100, [bot('votemax', 102)])).toEqual([]);
    expect(runKraken(100, [bot('votemax', 102.01)])).toHaveLength(1);
    expect(runKraken(1000, [bot('votemax', 1010)])).toEqual([]);
    expect(runKraken(1000, [bot('votemax', 1010.01)])).toHaveLength(1);
    expect(runKraken(1000, [bot('votemax', 990)])).toEqual([]);
    expect(runKraken(1000, [bot('votemax', 989.99)])).toHaveLength(1);
  });

  it('compares with spot USD only and treats no spot USD as zero', () => {
    const balances = [balance('USD', 50, 1), balance('USD', 900, 1, { wallet: 'earn' })];
    expect(usdViewDrift(input({ bots: [bot('votemax', 50)], kraken: krakenView({ balances }) }))).toEqual([]);
    const noUsd = krakenView({ balances: [balance('ETH', 1, 2500)] });
    expect(usdViewDrift(input({ bots: [bot('votemax', 0)], kraken: noUsd }))).toEqual([]);
    expect(usdViewDrift(input({ bots: [bot('votemax', 40)], kraken: noUsd }))).toHaveLength(1);
  });

  it('treats a wallet without a USD line as 0 and skips bots without a wallet', () => {
    const empty: FtWalletView = { botId: 'votemax', fetchedAt: T0, lastWalletSyncAt: T0, totalUsd: 0, currencies: [] };
    const found = usdViewDrift(
      input({
        bots: [healthyBot('votemax', T0, { wallet: empty }), healthyBot('dca', T0)],
        kraken: krakenView({ balances: [balance('USD', 500, 1)] }),
      }),
    );
    expect(found.map((f) => f.subject.botId)).toEqual(['votemax']);
  });

  it('reports every drifting bot and is silent without Kraken balances to compare with', () => {
    expect(runKraken(500, [bot('votemax', 300), bot('dca', 100)])).toHaveLength(2);
    expect(usdViewDrift(input({ bots: [bot('votemax', 300)], kraken: krakenView({ balances: [] }) }))).toEqual([]);
  });
});

describe('USD_VIEW_DRIFT between bots (freqtrade-only)', () => {
  const runFt = (bots: ReturnType<typeof bot>[]) => usdViewDrift(input({ bots, kraken: null }));

  it('is silent when the bots agree or only one bot has a wallet', () => {
    expect(runFt([bot('dca', 500), bot('votemax', 500)])).toEqual([]);
    expect(runFt([bot('dca', 500), healthyBot('votemax', T0)])).toEqual([]);
    expect(runFt([bot('dca', 500)])).toEqual([]);
  });

  it('blames the bot with the older wallet sync', () => {
    const found = runFt([bot('dca', 500, T0 - MIN), bot('votemax', 300, T0 - HOUR)]);
    expect(found.map((f) => f.subject.botId)).toEqual(['votemax']);
    expect(found[0]!.evidence).toMatchObject({ refSource: 'bot:dca', botUsd: 300, refUsd: 500 });
    const flipped = runFt([bot('dca', 500, T0 - HOUR), bot('votemax', 300, T0 - MIN)]);
    expect(flipped.map((f) => f.subject.botId)).toEqual(['dca']);
  });

  it('falls back to the fetch time without a sync time, and blames both on a tie', () => {
    const noSync = runFt([bot('dca', 500, null, T0 - HOUR), bot('votemax', 300, null, T0 - MIN)]);
    expect(noSync.map((f) => f.subject.botId)).toEqual(['dca']);
    const tie = runFt([bot('dca', 500), bot('votemax', 300)]);
    expect(tie.map((f) => f.subject.botId).sort()).toEqual(['dca', 'votemax']);
  });

  it('allows max($2, 1 %) between the bots too', () => {
    expect(runFt([bot('dca', 500), bot('votemax', 505)])).toEqual([]);
    expect(runFt([bot('dca', 500, T0 - HOUR), bot('votemax', 505.1)])).toHaveLength(1);
  });

  it('does not report a bot twice when it is stale against two others', () => {
    const found = runFt([bot('a', 100, T0 - HOUR), bot('b', 500), bot('c', 500)]);
    expect(found.filter((f) => f.subject.botId === 'a')).toHaveLength(1);
  });
});

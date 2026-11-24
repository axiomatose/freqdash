import { describe, expect, it } from 'vitest';
import type { BotOrder, KrakenOrder } from '@/shared/types/domain';
import type { CheckInput } from '../types';
import {
  T0,
  baseTrade,
  botOrder,
  healthyBot,
  input,
  krakenOrder,
  krakenView,
} from '../../../../test/fixtures/incident/builders';
import { withPnl } from '@/server/accounting';
import { orderMismatch } from './orderMismatch';

const ID = 'OOCL5O-QBIJF-SVBMA7';

function run(bot: Partial<BotOrder>, kraken: Partial<KrakenOrder>, over: Partial<CheckInput> = {}, live = false) {
  const trade = withPnl(baseTrade({ orders: [botOrder({ orderId: ID, filled: 1, amount: 1, ...bot })] }), null);
  const ko = krakenOrder({ txid: ID, vol: 1, volExec: 1, status: 'closed', ...kraken });
  return orderMismatch(
    input({
      bots: [healthyBot('votemax', T0, { closedTrades: [trade] })],
      kraken: krakenView(live ? { openOrders: [ko] } : { orders: [ko] }),
      ...over,
    }),
  );
}

describe('ORDER_MISMATCH', () => {
  it('is silent when bot and Kraken agree', () => {
    expect(run({}, {})).toEqual([]);
  });

  it('warns about a fill difference above max(1e-7, 0.2 % of the order volume)', () => {
    expect(run({ filled: 0.9981 }, {})).toEqual([]);
    const [f] = run({ filled: 0.9979 }, {});
    expect(f).toMatchObject({
      rule: 'ORDER_MISMATCH',
      fingerprint: `ORDER_MISMATCH:${ID}`,
      severity: 'warning',
      minDurationMs: 120_000,
      subject: { botId: 'votemax', orderId: ID, tradeId: 1, pair: 'ETH/USD' },
    });
    expect(f!.evidence).toMatchObject({
      botFilled: 0.9979,
      krakenVolExec: 1,
      fillMismatch: true,
      stateMismatch: false,
    });
  });

  it('uses the 1e-7 floor for tiny orders', () => {
    expect(run({ filled: 1e-5 - 0.9e-7 }, { vol: 1e-5, volExec: 1e-5 })).toEqual([]);
    expect(run({ filled: 1e-5 - 1.1e-7 }, { vol: 1e-5, volExec: 1e-5 })).toHaveLength(1);
  });

  it('warns when the bot still shows the order open but Kraken closed, canceled or expired it', () => {
    for (const status of ['closed', 'canceled', 'expired'] as const) {
      const [f] = run({ isOpen: true, status: 'open' }, { status });
      expect(f!.evidence).toMatchObject({ stateMismatch: true, fillMismatch: false, krakenStatus: status });
    }
  });

  it('is silent when both agree that the order is open', () => {
    expect(run({ isOpen: true, status: 'open' }, { status: 'open' }, {}, true)).toEqual([]);
    expect(run({ isOpen: true, status: 'open' }, { status: 'pending' }, {}, true)).toEqual([]);
  });

  it('prefers the live open-order data over the persisted row for the same txid', () => {
    const trade = withPnl(baseTrade({ orders: [botOrder({ orderId: ID, filled: 1 })] }), null);
    const kraken = krakenView({
      orders: [krakenOrder({ txid: ID, volExec: 0, status: 'open' })],
      openOrders: [krakenOrder({ txid: ID, volExec: 1, status: 'open' })],
    });
    expect(orderMismatch(input({ bots: [healthyBot('votemax', T0, { closedTrades: [trade] })], kraken }))).toEqual([]);
  });

  it('ignores orders Kraken does not list, dry-run bots, and runs nothing without Kraken data', () => {
    expect(run({}, { txid: 'O7UOUF-3QLFL-7E7GYF', volExec: 0 })).toEqual([]);
    const trade = withPnl(baseTrade({ orders: [botOrder({ orderId: ID, filled: 0.5 })] }), null);
    const bot = healthyBot('votemax', T0, { closedTrades: [trade] });
    const kraken = krakenView({ orders: [krakenOrder({ txid: ID, volExec: 1 })] });
    expect(orderMismatch(input({ bots: [{ ...bot, config: { ...bot.config!, dryRun: true } }], kraken }))).toEqual([]);
    expect(orderMismatch(input({ bots: [bot], kraken: null }))).toEqual([]);
  });
});

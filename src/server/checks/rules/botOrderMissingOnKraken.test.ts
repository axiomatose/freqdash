import { describe, expect, it } from 'vitest';
import type { BotCheckView, CheckInput } from '../types';
import {
  HOUR,
  MIN,
  T0,
  ack,
  baseTrade,
  botOrder,
  healthyBot,
  input,
  krakenOrder,
  krakenView,
} from '../../../../test/fixtures/incident/builders';
import { withPnl } from '@/server/accounting';
import { botOrderMissingOnKraken } from './botOrderMissingOnKraken';

const RECON = T0 - 10 * HOUR;
const ORDER_ID = 'OHXXYB-T4QX2-WWTTEC';

function botWith(placedAt: number | null, over: Partial<BotCheckView> = {}, orderOver = {}): BotCheckView {
  const trade = withPnl(baseTrade({ orders: [botOrder({ orderId: ORDER_ID, placedAt, ...orderOver })] }), null);
  return healthyBot('votemax', T0, { closedTrades: [trade], ...over });
}

const run = (over: Partial<CheckInput> = {}, bot = botWith(T0 - HOUR)) =>
  botOrderMissingOnKraken(input({ reconStartAt: RECON, bots: [bot], kraken: krakenView({}), ...over }));

describe('BOT_ORDER_MISSING_ON_KRAKEN', () => {
  it('warns for a filled bot order that Kraken does not have', () => {
    const [f, ...rest] = run();
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      rule: 'BOT_ORDER_MISSING_ON_KRAKEN',
      fingerprint: `BOT_ORDER_MISSING_ON_KRAKEN:votemax:${ORDER_ID}`,
      severity: 'warning',
      subject: { botId: 'votemax', orderId: ORDER_ID, tradeId: 1, pair: 'ETH/USD' },
    });
  });

  it('is silent when Kraken has the order, as a closed order or as an open one', () => {
    expect(run({ kraken: krakenView({ orders: [krakenOrder({ txid: ORDER_ID })] }) })).toEqual([]);
    expect(run({ kraken: krakenView({ openOrders: [krakenOrder({ txid: ORDER_ID, status: 'open' })] }) })).toEqual([]);
  });

  it('is silent without Kraken data or before the backfill is complete', () => {
    expect(run({ kraken: null })).toEqual([]);
    expect(run({ kraken: krakenView({ backfillComplete: false }) })).toEqual([]);
  });

  it('only looks at orders placed between recon start + 1 h and now - 10 min (boundaries)', () => {
    expect(run({}, botWith(RECON + HOUR))).toHaveLength(1);
    expect(run({}, botWith(RECON + HOUR - 1))).toEqual([]);
    expect(run({}, botWith(T0 - 10 * MIN))).toHaveLength(1);
    expect(run({}, botWith(T0 - 10 * MIN + 1))).toEqual([]);
  });

  it('needs a fill and a placement time', () => {
    expect(run({}, botWith(T0 - HOUR, {}, { filled: 0 }))).toEqual([]);
    expect(run({}, botWith(null))).toEqual([]);
  });

  it('skips dry-run bots (their orders never reach Kraken) and acknowledged orders', () => {
    const dry = botWith(T0 - HOUR);
    expect(run({}, { ...dry, config: { ...dry.config!, dryRun: true } })).toEqual([]);
    expect(run({ acks: [ack({ kind: 'kraken_order', subject: ORDER_ID })] })).toEqual([]);
  });

  it('checks open trades too', () => {
    const open = withPnl(baseTrade({ orders: [botOrder({ orderId: ORDER_ID, placedAt: T0 - HOUR })] }), null);
    const bot = healthyBot('votemax', T0, { openTrades: [open] });
    expect(run({}, bot)).toHaveLength(1);
  });
});

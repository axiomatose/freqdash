// The real sample state of the system (test/fixtures/raw/freqtrade + Kraken ticker capture, 2026-09-28 21:29 UTC) must
// produce exactly the findings that PLAN section 10 (WP14, "Expected live state") lists, and nothing else: no noise on
// SHIB/BABY (non-bot holdings), sub-dollar dust, the open BTC trade, or the wallets of the two bots.
import { describe, expect, it } from 'vitest';
import { withPnl } from '@/server/accounting';
import type { BotEvent, FtWalletView } from '@/shared/types/domain';
import type { Finding } from '@/shared/types/findings';
import dcaBalanceRaw from '../../../test/fixtures/raw/freqtrade/dca_balance.json';
import dcaHealthRaw from '../../../test/fixtures/raw/freqtrade/dca_health.json';
import votemaxBalanceRaw from '../../../test/fixtures/raw/freqtrade/votemax_balance.json';
import votemaxHealthRaw from '../../../test/fixtures/raw/freqtrade/votemax_health.json';
import tickerRaw from '../../../test/fixtures/raw/kraken/public/Ticker.json';
import timelineRaw from '../../../test/fixtures/raw/incident/timeline.json';
import { DAY, SEC, healthyBot, input } from '../../../test/fixtures/incident/builders';
import { dcaClosedTrades, votemaxClosedTrades, votemaxOpenTrades } from '../../../test/fixtures/incident/ftFixtures';
import { evaluate } from './engine';
import { applyLifecycle } from './lifecycle';
import type { BotCheckView, CheckInput } from './types';

interface RawBalance {
  currencies: {
    currency: string;
    balance: number;
    free: number;
    used: number;
    bot_owned: number;
    est_stake: number;
    is_bot_managed: boolean;
  }[];
}
interface RawHealth {
  last_process_ts: number;
  bot_start_ts: number;
  bot_startup_ts: number;
}

const NOW = 1_790_630_988_000 + 5 * SEC; // 5 s after both bots' last loop in the samples
const ticker = (tickerRaw as { result: Record<string, { c: string[] }> }).result;
const PRICES = {
  USD: 1,
  BTC: Number(ticker['XXBTZUSD']!.c[0]),
  ETH: Number(ticker['XETHZUSD']!.c[0]),
  SHIB: Number(ticker['SHIBUSD']!.c[0]),
  BABY: Number(ticker['BABYUSD']!.c[0]),
};

function wallet(botId: string, raw: RawBalance, syncAt: number, ethOverride?: number): FtWalletView {
  const currencies = raw.currencies.map((c) => ({
    currency: c.currency,
    balance: c.currency === 'ETH' && ethOverride !== undefined ? ethOverride : c.balance,
    free: c.free,
    used: c.used,
    botOwned: c.bot_owned,
    estStakeUsd: c.est_stake,
    isBotManaged: c.is_bot_managed,
  }));
  return {
    botId,
    fetchedAt: syncAt,
    lastWalletSyncAt: syncAt,
    currencies,
    totalUsd: currencies.reduce((s, c) => s + (c.estStakeUsd ?? 0), 0),
  };
}

function bot(botId: 'votemax' | 'dca', now: number, ethOverride?: number): BotCheckView {
  const health = (botId === 'votemax' ? votemaxHealthRaw : dcaHealthRaw) as RawHealth;
  const raw = (botId === 'votemax' ? votemaxBalanceRaw : dcaBalanceRaw) as unknown as RawBalance;
  const closed = (botId === 'votemax' ? votemaxClosedTrades() : dcaClosedTrades()).map((t) => withPnl(t, null));
  const open =
    botId === 'votemax' ? votemaxOpenTrades().map((t) => withPnl(t, { price: PRICES.BTC, source: 'kraken' })) : [];
  const base = healthyBot(botId, now);
  return {
    ...base,
    health: {
      reachable: true,
      authFailed: false,
      lastProcessAt: now - 3 * SEC,
      botStartAt: health.bot_start_ts * 1000,
      botStartupAt: health.bot_startup_ts * 1000,
      unreachableSince: null,
    },
    lastStatusOkAt: now - 5 * SEC,
    lastTradesOkAt: now - 20 * SEC,
    openTrades: open,
    closedTrades: closed,
    wallet: wallet(botId, raw, now - 30 * SEC, ethOverride),
    whitelist: ['BTC/USD', 'ETH/USD'],
    logTail: { ...base.logTail, lastWalletSyncAt: now - 30 * SEC },
  };
}

/** Log backfill: the 25 order_created lines of the incident (the last 30 days of them are kept in the event table). */
const backfilledOrders: BotEvent[] = (
  timelineRaw as {
    events: { type: string; at: number; orderId?: string; pair?: string; price?: number; stakeUsd?: number }[];
  }
).events
  .filter((e) => e.type === 'order_created')
  .map((e) => ({
    botId: 'votemax',
    at: e.at,
    type: 'order_created',
    source: 'logfile',
    orderId: e.orderId,
    pair: e.pair,
    price: e.price,
    stakeUsd: e.stakeUsd,
    fingerprint: `votemax:order_created:${e.at}`,
  }));

function liveInput(now = NOW, over: Partial<CheckInput> = {}, eth?: number): CheckInput {
  const bots = [bot('votemax', now, eth), bot('dca', now, eth)];
  const known: CheckInput['knownOrders'] = {};
  for (const b of bots)
    for (const t of [...b.openTrades, ...b.closedTrades])
      for (const o of t.orders) known[o.orderId] = { botId: b.botId, tradeId: t.tradeId };
  return input({
    now,
    bots,
    kraken: null,
    prices: PRICES,
    knownOrders: known,
    events: backfilledOrders,
    reconStartAt: now - 100 * DAY,
    ...over,
  });
}

function summarize(findings: ReturnType<typeof evaluate>, now: number): [string, string][] {
  const { next } = applyLifecycle([], findings, now, input().cfg);
  return next
    .filter((f) => f.status === 'active')
    .map((f): [string, string] => [f.fingerprint, f.severity])
    .sort();
}

describe('the real sample state (freqtrade-only mode)', () => {
  it('flags only the incident leftovers, the un-acknowledged SHIB holding and the historical 0.8 % exit fee', () => {
    const findings = evaluate(liveInput());
    expect(summarize(findings, NOW)).toEqual([
      ['FEE_ANOMALY:votemax:3:sell', 'info'],
      ['UNPERSISTED_ORDER:votemax:ETH/USD', 'critical'],
    ]);
    // SHIB is worth ~$10.7 (>= $5) but only becomes a finding once it has stood for 90 s
    const shib = findings.find((f) => f.fingerprint === 'UNTRACKED_HOLDING:SHIB')!;
    expect(shib).toMatchObject({ severity: 'warning', minDurationMs: 90_000 });
    expect(shib.evidence).toMatchObject({ source: 'bot-wallet', tradedByBot: false });
  });

  it('after 90 s the SHIB holding is an active warning', () => {
    const first = applyLifecycle([], evaluate(liveInput()), NOW, input().cfg);
    const stored = first.next.map((d, i) => ({ ...d, id: i + 1 }) as Finding);
    const later = applyLifecycle(stored, evaluate(liveInput(NOW + 90 * SEC)), NOW + 90 * SEC, input().cfg);
    expect(later.next.find((f) => f.fingerprint === 'UNTRACKED_HOLDING:SHIB')).toMatchObject({
      status: 'active',
      severity: 'warning',
    });
  });

  it('BABY, ETH dust and the BTC held by the open trade produce nothing', () => {
    const fps = evaluate(liveInput()).map((f) => f.fingerprint);
    for (const asset of ['BABY', 'ETH', 'BTC', 'USD']) expect(fps).not.toContain(`UNTRACKED_HOLDING:${asset}`);
    expect(fps.some((f) => f.startsWith('USD_VIEW_DRIFT'))).toBe(false);
    expect(fps.some((f) => f.startsWith('BOT_'))).toBe(false);
  });

  it('the 25 unpersisted orders are a warning once they are more than 24 hours old', () => {
    const tomorrow = NOW + DAY;
    const findings = evaluate(liveInput(tomorrow));
    const f = findings.find((x) => x.rule === 'UNPERSISTED_ORDER')!;
    expect(f).toMatchObject({ fingerprint: 'UNPERSISTED_ORDER:votemax:ETH/USD', severity: 'warning' });
    expect(f.evidenceKeys).toHaveLength(25);
    expect(f.evidence).toMatchObject({ count: 25, totalStakeUsd: expect.closeTo(288.05, 1) });
  });

  it('with the incident ETH in the dca wallet, ETH is an untracked bot-wallet holding capped at warning', () => {
    const findings = evaluate(liveInput(NOW, {}, 0.1130240889));
    const eth = findings.find((f) => f.fingerprint === 'UNTRACKED_HOLDING:ETH')!;
    expect(eth).toMatchObject({ severity: 'warning' });
    expect(eth.evidence).toMatchObject({ source: 'bot-wallet', tradedByBot: true, untrackedQty: 0.1130240889 });
  });

  it('acknowledging the SHIB holding and the incident orders leaves only the fee history', () => {
    const acks = [
      {
        id: 1,
        kind: 'asset' as const,
        subject: 'SHIB',
        label: 'manual' as const,
        note: null,
        qtyBaseline: null,
        createdAt: NOW,
        createdBy: null,
        expiresAt: null,
        revokedAt: null,
      },
      ...backfilledOrders.map((e, i) => ({
        id: 10 + i,
        kind: 'kraken_order' as const,
        subject: e.orderId as string,
        label: 'manual' as const,
        note: null,
        qtyBaseline: null,
        createdAt: NOW,
        createdBy: null,
        expiresAt: null,
        revokedAt: null,
      })),
    ];
    expect(evaluate(liveInput(NOW, { acks })).map((f) => f.fingerprint)).toEqual(['FEE_ANOMALY:votemax:3:sell']);
  });
});

import { readFileSync } from 'node:fs';
import type { BotId, Ms } from '@/shared/types/domain';
import { pickMark, withPnl } from '../accounting';
import {
  normalizeConfig,
  normalizeHealth,
  normalizeTrades,
  normalizeWallet,
  normalizeWhitelist,
} from '../freqtrade/normalize';
import { emptyBotRuntime } from '../poller/context';
import { createStore, type createInitialState } from '../state/store';
import type { ViewContext } from './common';

// Test-only: a ViewContext over state built from the recorded freqtrade samples (never imported by production code).

export const NOW = 1_790_630_990_000; // a few seconds after the sample bot health timestamp

const read = (name: string): unknown =>
  JSON.parse(readFileSync(`${process.cwd()}/test/fixtures/raw/freqtrade/${name}.json`, 'utf8')) as unknown;

export function seededBot(botId: BotId, name: string, now: Ms = NOW) {
  const bot = emptyBotRuntime(botId, name, botId === 'votemax' ? '#4F8CFF' : '#B38CFF', null);
  bot.config = normalizeConfig(botId, read(`${botId}_show_config`));
  bot.health = normalizeHealth(read(`${botId}_health`));
  const prices = { BTC: 83_414.5, ETH: 4_000 };
  bot.openTrades = normalizeTrades(botId, read(`${botId}_status`), { isOpen: true }).map((t) =>
    withPnl(t, pickMark(t, prices)),
  );
  bot.closedTrades = normalizeTrades(botId, read(`${botId}_trades`), { isOpen: false }).map((t) => withPnl(t, null));
  bot.wallet = normalizeWallet(botId, read(`${botId}_balance`), { fetchedAt: now });
  bot.whitelist = normalizeWhitelist(read(`${botId}_whitelist`));
  bot.lastStatusOkAt = now;
  bot.lastTradesOkAt = now;
  return bot;
}

export function seededContext(
  mutate?: (state: ReturnType<typeof createInitialState>) => void,
  now: Ms = NOW,
): ViewContext {
  const store = createStore();
  store.update((s) => {
    s.bots.votemax = seededBot('votemax', 'VoteMax', now);
    s.bots.dca = seededBot('dca', 'DCA', now);
    s.monitor = {
      startedAt: now - 3_600_000,
      lastCycleAt: now - 2_000,
      lastEvalAt: now - 3_000,
      rulesEvaluated: 22,
      lastEvalError: null,
    };
    s.sources['bot:votemax:status'] = {
      key: 'bot:votemax:status',
      label: 'VoteMax status',
      cadenceMs: 15_000,
      lastOkAt: now - 4_000,
      lastAttemptAt: now - 4_000,
      consecutiveFailures: 0,
      error: null,
      disabled: false,
    };
    mutate?.(s);
  });
  return {
    state: store.get(),
    now,
    kraken: { configured: false, tier: 'starter', reconStartAt: null },
    killswitchMode: 'off',
  };
}

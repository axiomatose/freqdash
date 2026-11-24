import type { BotCheckView } from '../types';
import type { FtWalletView, Ms } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, usd, type Rule } from '../util';

const walletUsd = (w: FtWalletView): number => w.currencies.find((c) => c.currency === 'USD')?.balance ?? 0;
const walletAt = (w: FtWalletView): Ms => w.lastWalletSyncAt ?? w.fetchedAt;

interface Drift {
  bot: BotCheckView;
  botUsd: number;
  refUsd: number;
  refSource: string;
}

/**
 * A bot's cached wallet shows a different USD balance than the reference: Kraken's spot USD or, without Kraken,
 * the other bot's wallet (then the staler of the two is blamed). Persistent drift means a stale wallet cache,
 * which makes the bot size its orders wrongly (the root of the 2026-09-28 incident).
 */
export const usdViewDrift: Rule = ({ cfg, bots, kraken }) => {
  const drifts: Drift[] = [];
  const limit = (ref: number): number => Math.max(cfg.usdDriftAbsUsd, cfg.usdDriftRatio * ref);

  if (kraken !== null) {
    if (kraken.balances.length === 0) return [];
    const spot = kraken.balances.filter((e) => e.asset === 'USD' && e.wallet === 'spot');
    const refUsd = spot.reduce((acc, e) => acc + e.total, 0);
    for (const bot of bots) {
      if (bot.wallet === null) continue;
      const botUsd = walletUsd(bot.wallet);
      if (Math.abs(botUsd - refUsd) > limit(refUsd)) drifts.push({ bot, botUsd, refUsd, refSource: 'kraken' });
    }
  } else {
    const withWallet = bots.filter((b): b is BotCheckView & { wallet: FtWalletView } => b.wallet !== null);
    for (const a of withWallet) {
      for (const b of withWallet) {
        if (a.botId >= b.botId) continue;
        const ua = walletUsd(a.wallet);
        const ub = walletUsd(b.wallet);
        if (Math.abs(ua - ub) <= limit(Math.max(ua, ub))) continue;
        const ta = walletAt(a.wallet);
        const tb = walletAt(b.wallet);
        if (ta <= tb && !drifts.some((d) => d.bot.botId === a.botId))
          drifts.push({ bot: a, botUsd: ua, refUsd: ub, refSource: `bot:${b.botId}` });
        if (tb <= ta && !drifts.some((d) => d.bot.botId === b.botId))
          drifts.push({ bot: b, botUsd: ub, refUsd: ua, refSource: `bot:${a.botId}` });
      }
    }
  }

  return drifts.map(({ bot, botUsd, refUsd, refSource }): RawFinding => ({
    rule: 'USD_VIEW_DRIFT',
    fingerprint: fingerprint('USD_VIEW_DRIFT', bot.botId),
    severity: 'info',
    title: `${bot.name}'s wallet shows ${usd(botUsd)} USD, not ${usd(refUsd)}`,
    detail:
      `${bot.name}'s cached wallet differs from the reference (${refSource}) by ${usd(Math.abs(botUsd - refUsd))}. ` +
      `A short difference after a trade is normal; a lasting one means the bot sizes orders from a stale wallet, ` +
      `which a restart of that bot refreshes.`,
    subject: { botId: bot.botId },
    evidence: {
      botUsd,
      refUsd,
      diffUsd: botUsd - refUsd,
      refSource,
      walletSyncAt: bot.wallet === null ? null : walletAt(bot.wallet),
    },
    escalateAfterMs: cfg.usdDriftEscalateMs,
    escalateTo: 'warning',
    clearAfterMs: cfg.usdDriftClearMs,
  }));
};

import {
  ackCoverage,
  botClaimedQty,
  buildAccountSnapshot,
  findAssetAck,
  holdingsByAsset,
  USD,
} from '@/server/accounting';
import type { Severity } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, qty, tradedAssets, usd, type Rule } from '../util';

/**
 * Coins on the account that no bot's open trade and no acknowledgement explains. Uses the Kraken balances (all
 * wallets) or, without Kraken, the freshest bot wallet (whose stale-cache risk caps the severity at warning).
 */
export const untrackedHolding: Rule = ({ now, cfg, bots, kraken, prices, acks }) => {
  const snapshot = buildAccountSnapshot({
    kraken: kraken === null ? null : { balances: kraken.balances, balancesAt: kraken.balancesAt },
    wallets: bots.flatMap((b) => (b.wallet === null ? [] : [b.wallet])),
    prices,
  });
  if (snapshot === null) return [];

  const fromKraken = snapshot.source === 'kraken';
  const traded = tradedAssets(bots);
  const out: RawFinding[] = [];

  for (const h of holdingsByAsset(snapshot).values()) {
    if (h.asset === USD || !(h.total > 0)) continue;
    const claims = bots.map((b) => ({ botId: b.botId, qty: botClaimedQty(b.openTrades, h.asset) }));
    const claimed = claims.reduce((acc, c) => acc + c.qty, 0);
    const ack = findAssetAck(acks, h.asset, now);
    const ackQty = ackCoverage(ack, h.total - claimed);
    const untracked = h.total - claimed - ackQty;
    if (untracked <= Math.max(1e-9, h.total * 1e-9)) continue;

    const valueUsd = h.priceUsd === null ? null : untracked * h.priceUsd;
    let severity: Severity;
    if (valueUsd === null) {
      severity = 'info';
    } else if (valueUsd < cfg.untrackedIgnoreUsd) {
      continue;
    } else {
      severity = 'info';
      if (valueUsd >= Math.max(cfg.untrackedWarnUsd, cfg.untrackedWarnEquityRatio * snapshot.totalUsd))
        severity = 'warning';
      if (traded.has(h.asset) && valueUsd >= cfg.untrackedCriticalUsd) severity = fromKraken ? 'critical' : 'warning';
    }

    const worth = valueUsd === null ? 'unpriced' : `about ${usd(valueUsd)}`;
    out.push({
      rule: 'UNTRACKED_HOLDING',
      fingerprint: fingerprint('UNTRACKED_HOLDING', h.asset),
      severity,
      title: `Untracked ${h.asset}: ${qty(untracked)} (${worth})`,
      detail:
        `The account holds ${qty(h.total)} ${h.asset}; open bot trades explain ${qty(claimed)}` +
        `${ackQty > 0 ? ` and an acknowledgement ${qty(ackQty)}` : ''}. ` +
        `${fromKraken ? '' : `This is estimated from ${snapshot.estimatedFromBot}'s cached wallet, which can be stale. `}` +
        `If you bought or kept these coins on purpose, mark the holding as manual in freqdash; otherwise check Kraken order history.`,
      subject: { asset: h.asset },
      evidence: {
        source: snapshot.source,
        estimatedFromBot: snapshot.estimatedFromBot,
        asOf: snapshot.asOf,
        total: h.total,
        claimedQty: claimed,
        acknowledgedQty: ackQty,
        untrackedQty: untracked,
        priceUsd: h.priceUsd,
        valueUsd,
        tradedByBot: traded.has(h.asset),
        byBot: claims.filter((c) => c.qty > 0),
      },
      minDurationMs: cfg.untrackedMinMs,
      clearAfterMs: cfg.untrackedClearMs,
    });
  }
  return out;
};

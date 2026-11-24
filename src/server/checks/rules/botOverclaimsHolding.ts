import { botClaimedQty, holdingsByAsset } from '@/server/accounting';
import type { Asset } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, qty, type Rule } from '../util';

/** The open trades of the bots together claim more of an asset than the Kraken account holds. */
export const botOverclaimsHolding: Rule = ({ cfg, bots, kraken }) => {
  if (kraken === null || kraken.balances.length === 0) return [];
  const held = holdingsByAsset({ holdings: kraken.balances });
  const assets = new Set<Asset>(bots.flatMap((b) => b.openTrades.map((t) => t.base)));
  const out: RawFinding[] = [];
  for (const asset of assets) {
    const claims = bots.map((b) => ({ botId: b.botId, qty: botClaimedQty(b.openTrades, asset) }));
    const claimed = claims.reduce((acc, c) => acc + c.qty, 0);
    const total = held.get(asset)?.total ?? 0;
    if (claimed - total <= Math.max(cfg.overclaimAbsQty, cfg.overclaimRelQty * claimed)) continue;
    out.push({
      rule: 'BOT_OVERCLAIMS_HOLDING',
      fingerprint: fingerprint('BOT_OVERCLAIMS_HOLDING', asset),
      severity: 'critical',
      title: `Bots claim more ${asset} than the account holds`,
      detail:
        `Open bot trades hold ${qty(claimed)} ${asset} together, but Kraken shows only ${qty(total)}. ` +
        `Coins were sold or moved outside the bots, or a bot's trade record is wrong.`,
      subject: { asset },
      evidence: { total, claimedQty: claimed, shortfall: claimed - total, byBot: claims.filter((c) => c.qty > 0) },
      minDurationMs: cfg.overclaimMinMs,
      clearAfterMs: cfg.overclaimClearMs,
    });
  }
  return out;
};

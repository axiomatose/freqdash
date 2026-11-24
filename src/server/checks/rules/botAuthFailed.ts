import type { RawFinding } from '@/shared/types/findings';
import { fingerprint, type Rule } from '../util';

/** The bot answers but rejects freqdash's credentials (401/403). */
export const botAuthFailed: Rule = ({ cfg, bots }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    if (b.health?.authFailed !== true) continue;
    out.push({
      rule: 'BOT_AUTH_FAILED',
      fingerprint: fingerprint('BOT_AUTH_FAILED', b.botId),
      severity: 'critical',
      title: `${b.name} rejects the freqdash credentials`,
      detail: `The freqtrade API of ${b.name} answered 401/403. freqdash cannot see this bot's trades, so all checks for it are blind.`,
      subject: { botId: b.botId },
      evidence: { lastStatusOkAt: b.lastStatusOkAt },
      clearAfterMs: cfg.authFailedClearMs,
    });
  }
  return out;
};

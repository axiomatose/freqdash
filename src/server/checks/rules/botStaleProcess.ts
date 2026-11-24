import type { RawFinding } from '@/shared/types/findings';
import { duration, fingerprint, type Rule } from '../util';

/** The API answers but the bot's main loop has not run for a while (hung process). */
export const botStaleProcess: Rule = ({ now, cfg, bots }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    const h = b.health;
    if (h === null || !h.reachable || h.lastProcessAt === null) continue;
    const ageMs = now - h.lastProcessAt;
    if (ageMs <= cfg.staleProcessWarnMs) continue;
    out.push({
      rule: 'BOT_STALE_PROCESS',
      fingerprint: fingerprint('BOT_STALE_PROCESS', b.botId),
      severity: ageMs > cfg.staleProcessCriticalMs ? 'critical' : 'warning',
      title: `${b.name}'s trading loop is stale`,
      detail: `${b.name} answers its API but its last processing loop ran ${duration(ageMs)} ago (normally every 5 s).`,
      subject: { botId: b.botId },
      evidence: { lastProcessAt: h.lastProcessAt, ageMs },
      clearAfterMs: cfg.staleProcessClearMs,
    });
  }
  return out;
};

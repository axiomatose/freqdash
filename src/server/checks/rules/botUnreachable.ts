import type { RawFinding } from '@/shared/types/findings';
import { duration, fingerprint, isoTime, type Rule } from '../util';

/** Health check failing (network, timeout, 5xx) for at least `unreachableWarnMs`; critical from `unreachableCriticalMs`. */
export const botUnreachable: Rule = ({ now, cfg, bots }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    const h = b.health;
    if (h === null || h.reachable || h.authFailed) continue;
    const since = b.firstFailureAt ?? h.unreachableSince;
    if (since === null) continue;
    const downMs = now - since;
    if (downMs < cfg.unreachableWarnMs) continue;
    out.push({
      rule: 'BOT_UNREACHABLE',
      fingerprint: fingerprint('BOT_UNREACHABLE', b.botId),
      severity: downMs >= cfg.unreachableCriticalMs ? 'critical' : 'warning',
      title: `${b.name} is unreachable`,
      detail: `The freqtrade API of ${b.name} has not answered for ${duration(downMs)} (since ${isoTime(since)}). Trades may not be managed while it is down.`,
      subject: { botId: b.botId },
      evidence: { since, downMs, lastProcessAt: h.lastProcessAt, lastStatusOkAt: b.lastStatusOkAt },
      clearAfterMs: cfg.unreachableClearMs,
    });
  }
  return out;
};

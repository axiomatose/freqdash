import type { RawFinding } from '@/shared/types/findings';
import { duration, fingerprint, type Rule } from '../util';

/**
 * The bot's log file is configured but cannot be read, or the bot is reachable while its log has been silent for
 * longer than a heartbeat interval allows. Without the log, crashes and unpersisted orders go unseen.
 */
export const logTailUnavailable: Rule = ({ now, cfg, bots }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    const t = b.logTail;
    if (!t.configured) continue;
    let reason: string | null = null;
    if (!t.available) {
      reason = `The log file ${t.file ?? ''} cannot be read${t.error ? ` (${t.error})` : ''}.`;
    } else if (b.health?.reachable === true && t.lastLineAt !== null && now - t.lastLineAt > cfg.logTailSilenceMs) {
      reason = `No new log line for ${duration(now - t.lastLineAt)} although the bot is running (it logs a heartbeat every minute).`;
    }
    if (reason === null) continue;
    out.push({
      rule: 'LOG_TAIL_UNAVAILABLE',
      fingerprint: fingerprint('LOG_TAIL_UNAVAILABLE', b.botId),
      severity: 'warning',
      title: `Log of ${b.name} is not being read`,
      detail: `${reason} freqdash cannot see crashes or unpersisted orders of ${b.name} without it; check the log mount.`,
      subject: { botId: b.botId },
      evidence: { available: t.available, lastLineAt: t.lastLineAt, error: t.error },
      minDurationMs: cfg.logTailMinMs,
    });
  }
  return out;
};

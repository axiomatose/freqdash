import type { BotEvent } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { eventsOf, fingerprint, isoTime, type Rule } from '../util';

/**
 * A `Fatal exception` log record in the last `fatalWindowMs`. `process died` alone is freqtrade's normal shutdown message
 * (a `docker restart` logs it too), so it only counts as extra evidence next to a fatal; BOT_RESTARTED reports plain restarts.
 */
export const botFatalLog: Rule = ({ now, cfg, bots, events }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    const hits = eventsOf(events, b.botId, ['fatal', 'process_died'], now, cfg.fatalWindowMs);
    if (!hits.some((e) => e.type === 'fatal')) continue;
    const times = hits.map((e) => e.at);
    const fatals = hits.filter((e) => e.type === 'fatal');
    const lastFatal = fatals.reduce<BotEvent | null>((acc, e) => (acc === null || e.at > acc.at ? e : acc), null);
    const lastAt = Math.max(...times);
    out.push({
      rule: 'BOT_FATAL_LOG',
      fingerprint: fingerprint('BOT_FATAL_LOG', b.botId),
      severity: 'critical',
      title: `${b.name} crashed`,
      detail: `${b.name} logged ${hits.length} fatal/process-died record${hits.length === 1 ? '' : 's'} in the last ${Math.round(cfg.fatalWindowMs / 60_000)} minutes (latest ${isoTime(lastAt)}${lastFatal?.message ? `: ${lastFatal.message}` : ''}).`,
      subject: { botId: b.botId },
      evidence: {
        count: hits.length,
        fatalCount: fatals.length,
        processDiedCount: hits.length - fatals.length,
        firstAt: Math.min(...times),
        lastAt,
        lastMessage: lastFatal?.message ?? null,
      },
    });
  }
  return out;
};

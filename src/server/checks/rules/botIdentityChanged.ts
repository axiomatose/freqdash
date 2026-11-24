import type { BotEvent } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { eventsOf, fingerprint, isoTime, type Rule } from '../util';

/** The bot's database identity changed (first-start time moved, or its closed-trade count went down). */
export const botIdentityChanged: Rule = ({ now, cfg, bots, events }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    const hits = eventsOf(events, b.botId, ['identity_changed'], now, cfg.identityWindowMs);
    const last = hits.reduce<BotEvent | null>((acc, e) => (acc === null || e.at > acc.at ? e : acc), null);
    if (last === null) continue;
    out.push({
      rule: 'BOT_IDENTITY_CHANGED',
      fingerprint: fingerprint('BOT_IDENTITY_CHANGED', b.botId),
      severity: 'critical',
      title: `${b.name}'s trade database changed`,
      detail: `${b.name} reported a different database identity at ${isoTime(last.at)}${last.message ? ` (${last.message})` : ''}. Its trade history may have been reset or swapped; freqdash's view of its trades may be wrong.`,
      subject: { botId: b.botId },
      evidence: { count: hits.length, lastAt: last.at, message: last.message ?? null },
    });
  }
  return out;
};

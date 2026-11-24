import type { BotEvent } from '@/shared/types/domain';
import type { RawFinding } from '@/shared/types/findings';
import { errorSignature, eventsOf, fingerprint, hashString, type Rule } from '../util';

/** Error records and failed order attempts of the last `errorWindowMs`, one finding per distinct error signature. */
export const botErrorLog: Rule = ({ now, cfg, bots, events }) => {
  const out: RawFinding[] = [];
  for (const b of bots) {
    const groups = new Map<string, BotEvent[]>();
    for (const e of eventsOf(events, b.botId, ['error', 'order_failed'], now, cfg.errorWindowMs)) {
      const sig = errorSignature(e.message ?? e.type, cfg.errorSignatureLength);
      const list = groups.get(sig);
      if (list) list.push(e);
      else groups.set(sig, [e]);
    }
    for (const [sig, list] of groups) {
      const times = list.map((e) => e.at);
      const latest = list.reduce((acc, e) => (e.at > acc.at ? e : acc));
      const sample = (latest.message ?? latest.type).slice(0, 300);
      out.push({
        rule: 'BOT_ERROR_LOG',
        fingerprint: fingerprint('BOT_ERROR_LOG', b.botId, hashString(sig)),
        severity: 'warning',
        title: `${b.name}: ${sample.slice(0, 80)}`,
        detail: `${b.name} logged this ${list.length} time${list.length === 1 ? '' : 's'} in the last ${Math.round(cfg.errorWindowMs / 60_000)} minutes: ${sample}`,
        subject: { botId: b.botId, kind: latest.type },
        evidence: {
          signature: sig,
          count: list.length,
          firstAt: Math.min(...times),
          lastAt: latest.at,
          sample,
          type: latest.type,
        },
      });
    }
  }
  return out;
};

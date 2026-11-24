import type { Severity } from '@/shared/types/domain';
import { describeError } from '../log';

export const DISCORD_MAX_EMBEDS = 10;
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 1000;

export interface DiscordEmbed {
  title: string;
  description: string;
  severity: Severity;
}

const COLORS: Record<Severity, number> = { critical: 0xe5484d, warning: 0xf5a524, info: 0x3e63dd };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Posts up to 10 embeds in one message. Never throws and never puts the webhook URL into `error`. */
export async function sendDiscord(
  url: string,
  content: string,
  embeds: readonly DiscordEmbed[],
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const body = {
    content: clip(content, 200),
    embeds: embeds.slice(0, DISCORD_MAX_EMBEDS).map((e) => ({
      title: clip(e.title, TITLE_MAX),
      description: clip(e.description, DESCRIPTION_MAX),
      color: COLORS[e.severity],
    })),
    allowed_mentions: { parse: [] as string[] },
  };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `discord responded ${res.status}` };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

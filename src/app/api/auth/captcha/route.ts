import type { NextRequest } from 'next/server';
import { getCaptchaService } from '@/server/auth/captcha';
import { apiError, getClientIp, withApiHeaders } from '@/server/auth/guard';

export const dynamic = 'force-dynamic';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const recent = new Map<string, number[]>();

// Public: a fresh login captcha ("new image"). The login endpoint already returns one when it starts requiring it, so
// this is only for a refresh, and it is throttled per address so it cannot be used to burn CPU.
export function GET(req: NextRequest): Response {
  const ip = getClientIp(req);
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    return withApiHeaders(apiError(429, 'rate_limited', 'Too many new images.', { retryAfterSec: 60 }));
  }
  recent.delete(ip);
  recent.set(ip, [...hits, now]);
  if (recent.size > 10_000) recent.delete(recent.keys().next().value as string);
  return withApiHeaders(Response.json(getCaptchaService().issue()));
}

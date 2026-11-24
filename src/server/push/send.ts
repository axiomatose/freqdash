import 'server-only';
import { describeError } from '../log';
import { encryptPayload, vapidAuthorization, type VapidKeys } from './crypto';

// One Web Push delivery: encrypt, sign, POST to the subscription's push service.

/**
 * Push services of the browsers that implement Web Push. A subscription's endpoint is supplied by the browser, so it
 * is checked against this list before the server ever POSTs to it (no requests to arbitrary or internal hosts).
 */
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', // Chrome, Edge (new), Android, Brave, Opera
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari, iOS/iPadOS home-screen apps
  'notify.windows.com', // Edge (legacy WNS)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  keys: VapidKeys;
  subject: string;
  /** Seconds the push service keeps the message for an offline device. */
  ttlSec: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** Collapses undelivered messages with the same topic (at most 32 base64url characters). */
  topic?: string;
  now?: number;
}

export interface PushResult {
  ok: boolean;
  status: number | null;
  /** The subscription no longer exists (404/410): delete it. */
  gone: boolean;
  error?: string;
}

/** Never throws; never puts the endpoint (it is a capability URL) into `error`. */
export async function sendPush(
  target: PushTarget,
  payload: string,
  options: PushOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  if (!isAllowedPushEndpoint(target.endpoint)) {
    return { ok: false, status: null, gone: true, error: 'endpoint is not a known push service' };
  }
  let body: Buffer;
  let authorization: string;
  try {
    body = encryptPayload(Buffer.from(payload, 'utf8'), target.p256dh, target.auth);
    const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
    authorization = vapidAuthorization(target.endpoint, options.keys, options.subject, nowSec + 12 * 3600);
  } catch (err) {
    return {
      ok: false,
      status: null,
      gone: true,
      error: `cannot encrypt for this subscription: ${describeError(err)}`,
    };
  }
  const headers: Record<string, string> = {
    Authorization: authorization,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.floor(options.ttlSec))),
    Urgency: options.urgency,
  };
  if (options.topic !== undefined && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers.Topic = options.topic;
  try {
    const res = await fetchImpl(target.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, status: res.status, gone: false };
    const gone = res.status === 404 || res.status === 410;
    return { ok: false, status: res.status, gone, error: `push service responded ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, gone: false, error: describeError(err) };
  }
}

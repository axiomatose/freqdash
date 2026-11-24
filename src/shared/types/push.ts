// Web Push (VAPID) contract shared by the server, the settings UI and the service worker payload.
import type { Ms, Severity } from './domain';

/** What one device wants to hear about. Killswitch alerts always go out and are not listed here. */
export interface PushPrefs {
  /** Filled buy orders (first entry and position adds). */
  entries: boolean;
  /** Closed trades, with fee-adjusted P&L. */
  exits: boolean;
  /** Lowest severity of findings (problems) to send, or 'off'. Never lower than NOTIFY_MIN_SEVERITY on the server. */
  findings: Severity | 'off';
  /** Also when a finding clears. */
  resolved: boolean;
  /** freqdash started, notification tests from the Status page. */
  system: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  entries: true,
  exits: true,
  findings: 'warning',
  resolved: true,
  system: false,
};

export interface PushDevice {
  id: number;
  label: string | null;
  prefs: PushPrefs;
  createdAt: Ms;
  lastOkAt: Ms | null;
  lastError: string | null;
  /** The push service URL is not exposed; the client matches its own subscription with this hash. */
  endpointHash: string;
}

/** GET /api/v1/push */
export interface PushStatusResponse {
  /** VAPID application server key (base64url, uncompressed P-256 point), or null when push is unavailable. */
  publicKey: string | null;
  /** The signed-in user's devices. */
  devices: PushDevice[];
  /** Findings below this severity are never notified (NOTIFY_MIN_SEVERITY). */
  serverMinSeverity: Severity;
}

/** POST /api/v1/push/subscriptions */
export interface PushSubscribeBody {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  label?: string;
  prefs?: Partial<PushPrefs>;
}

/** What the service worker receives (JSON, encrypted end to end). */
export interface PushPayload {
  title: string;
  body: string;
  /** Same tag replaces an older notification instead of stacking. */
  tag: string;
  /** Relative URL opened on click. */
  url: string;
  severity?: Severity;
  at: Ms;
}

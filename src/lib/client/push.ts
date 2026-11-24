'use client';

// Browser side of Web Push: the service worker, the PushManager subscription and the /api/v1/push hooks.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { PushDevice, PushPrefs, PushStatusResponse, PushSubscribeBody } from '@/shared/types/push';
import { deviceLabel } from '@/shared/device';
import { ApiError, apiFetch } from './api';

const key = ['push'] as const;

export type PushSupport = 'supported' | 'unsupported' | 'needs-install' | 'insecure';

/** What this browser can do. iOS/iPadOS only offer Web Push to apps added to the Home Screen (16.4+). */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return 'needs-install';
  return hasApis ? 'supported' : 'unsupported';
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function toBase64Url(buffer: ArrayBuffer | null): string {
  if (buffer === null) return '';
  let s = '';
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of the endpoint, base64url, first 16 characters: how the server identifies this device to us. */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return toBase64Url(digest).slice(0, 16);
}

export async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** This browser's current subscription, if it was made with `publicKey` (a stale one is dropped). */
export async function currentSubscription(publicKey: string | null): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = (await reg?.pushManager.getSubscription()) ?? null;
  if (sub === null || publicKey === null) return sub;
  const used = toBase64Url(sub.options.applicationServerKey);
  if (used !== '' && used !== publicKey) {
    await sub.unsubscribe().catch(() => undefined);
    return null;
  }
  return sub;
}

export function usePushStatus(enabled = true): UseQueryResult<PushStatusResponse, ApiError> {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiFetch<PushStatusResponse>('/api/v1/push', { signal }),
    enabled,
  });
}

/**
 * Asks for notification permission. Call it straight from the click handler: Safari only shows the prompt during a
 * user gesture, and a mutation runs its function a few ticks later.
 */
export async function askPermission(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser or system settings, then try again.'
        : 'Notification permission was not given.',
    );
  }
}

/** Subscribes this browser (permission must already be granted) and registers it with the server. */
export function useEnablePush(): UseMutationResult<
  PushDevice,
  Error,
  { publicKey: string; permission: Promise<void> }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ publicKey, permission }) => {
      await permission;
      const reg = await registration();
      const sub =
        (await currentSubscription(publicKey)) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      const json = sub.toJSON();
      const body: PushSubscribeBody = {
        subscription: {
          endpoint: sub.endpoint,
          keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
        },
        label: deviceLabel(navigator.userAgent),
      };
      const res = await apiFetch<{ device: PushDevice }>('/api/v1/push/subscriptions', { method: 'POST', body });
      return res.device;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdatePushPrefs(): UseMutationResult<
  PushDevice,
  ApiError,
  { id: number; prefs: Partial<PushPrefs> }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, prefs }) =>
      (await apiFetch<{ device: PushDevice }>(`/api/v1/push/subscriptions/${id}`, { method: 'PUT', body: { prefs } }))
        .device,
    onSuccess: (device) =>
      qc.setQueryData<PushStatusResponse>(key, (old) =>
        old ? { ...old, devices: old.devices.map((d) => (d.id === device.id ? device : d)) } : old,
      ),
  });
}

/** Removes a device on the server; for this device also unsubscribes the browser. */
export function useRemovePushDevice(): UseMutationResult<void, ApiError, { id: number; thisDevice: boolean }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, thisDevice }) => {
      if (thisDevice) {
        const sub = await currentSubscription(null).catch(() => null);
        await sub?.unsubscribe().catch(() => undefined);
      }
      await apiFetch<void>(`/api/v1/push/subscriptions/${id}`, { method: 'DELETE' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export type PushTestResult = { ok: true } | { ok: false; error: string };

export function useTestPush(): UseMutationResult<PushTestResult, ApiError, number> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiFetch<PushTestResult>(`/api/v1/push/subscriptions/${id}/test`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

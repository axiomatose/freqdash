import 'server-only';
import { z } from 'zod';
import { DEFAULT_PUSH_PREFS, type PushDevice, type PushPrefs, type PushStatusResponse } from '@/shared/types/push';
import { getConfig } from '../config';
import { listPushSubscriptions, type PushSubscriptionRecord } from '../db';
import { endpointHash, getPushService } from './service';

// Shapes and validation for the /api/v1/push routes.

export const prefsSchema = z
  .object({
    entries: z.boolean(),
    exits: z.boolean(),
    findings: z.enum(['off', 'info', 'warning', 'critical']),
    resolved: z.boolean(),
    system: z.boolean(),
  })
  .partial()
  .strict();

const b64u = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+={0,2}$/)
    .refine((v) => Buffer.from(v.replace(/=+$/, ''), 'base64url').length === bytes, `must be ${bytes} bytes`)
    .transform((v) => v.replace(/=+$/, ''));

export const subscribeSchema = z
  .object({
    subscription: z.object({
      endpoint: z.url().max(1024),
      keys: z.object({ p256dh: b64u(65), auth: b64u(16) }),
    }),
    label: z.string().trim().max(60).optional(),
    prefs: prefsSchema.optional(),
  })
  .strict();

export function mergePrefs(base: PushPrefs, patch: z.infer<typeof prefsSchema> | undefined): PushPrefs {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function toDevice(r: PushSubscriptionRecord): PushDevice {
  return {
    id: r.id,
    label: r.label,
    prefs: r.prefs,
    createdAt: r.createdAt,
    lastOkAt: r.lastOkAt,
    lastError: r.lastError,
    endpointHash: endpointHash(r.endpoint),
  };
}

export function pushStatus(userId: number): PushStatusResponse {
  return {
    publicKey: getPushService().publicKey(),
    devices: listPushSubscriptions(userId).map(toDevice),
    serverMinSeverity: getConfig().notify.minSeverity,
  };
}

export { DEFAULT_PUSH_PREFS };

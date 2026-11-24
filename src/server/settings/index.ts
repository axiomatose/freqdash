import 'server-only';
import { getConfig } from '../config';
import { deleteSettingRow, getSettingRow, listSettingRows, putSettingRow } from '../db';
import { decryptSecret, encryptSecret } from './crypto';
import { SETTING_DEFS, SETTING_KEYS, isSecretKey, type SettingKey, type SettingValue } from './registry';

export { SETTING_DEFS, SETTING_KEYS, isSettingKey, isSecretKey, type SettingKey, type SettingValue } from './registry';

const secretKey = (): string => getConfig().auth.sessionSecret;

/** The stored value (decrypted for secrets), or the default. A stored value that no longer validates reads as the default. */
export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  const def = SETTING_DEFS[key];
  const row = getSettingRow(key);
  if (row === null) return def.default as SettingValue<K>;
  let raw: unknown;
  if (isSecretKey(key)) {
    raw = decryptSecret(row.value, secretKey());
    if (raw === null) return def.default as SettingValue<K>;
  } else {
    try {
      raw = JSON.parse(row.value);
    } catch {
      return def.default as SettingValue<K>;
    }
  }
  const parsed = def.schema.safeParse(raw);
  return parsed.success ? (parsed.data as SettingValue<K>) : (def.default as SettingValue<K>);
}

export class SettingsError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(`${key}: ${message}`);
  }
}

/**
 * Applies a patch: a value sets a key, `null` clears it back to the default. Everything is validated before anything is
 * written, so a bad value leaves the settings untouched.
 */
export function updateSettings(patch: Partial<Record<SettingKey, unknown>>, by: string | null, now: number): void {
  const writes: { key: SettingKey; value: string | null }[] = [];
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const incoming = patch[key];
    if (incoming === null) {
      writes.push({ key, value: null });
      continue;
    }
    const parsed = SETTING_DEFS[key].schema.safeParse(incoming);
    if (!parsed.success) throw new SettingsError(key, parsed.error.issues[0]?.message ?? 'is invalid');
    writes.push({
      key,
      value: isSecretKey(key) ? encryptSecret(String(parsed.data), secretKey()) : JSON.stringify(parsed.data),
    });
  }
  for (const w of writes) {
    if (w.value === null) deleteSettingRow(w.key);
    else putSettingRow({ key: w.key, value: w.value, secret: isSecretKey(w.key), by }, now);
  }
}

export interface SettingsView {
  /** Non-secret values (defaults filled in). Secrets never appear here. */
  values: Record<string, string | number | boolean | null>;
  /** For each secret: whether a usable value is stored. The value itself is never returned. */
  secretsSet: Record<string, boolean>;
  updatedAt: number | null;
}

export function settingsView(): SettingsView {
  const values: SettingsView['values'] = {};
  const secretsSet: SettingsView['secretsSet'] = {};
  for (const key of SETTING_KEYS) {
    if (isSecretKey(key)) secretsSet[key] = getSetting(key) !== null;
    else values[key] = (getSetting(key) ?? '') as string | number | boolean;
  }
  const rows = listSettingRows();
  return {
    values,
    secretsSet,
    updatedAt: rows.reduce<number | null>((m, r) => (m === null || r.updatedAt > m ? r.updatedAt : m), null),
  };
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Values of `.env.dev.example` (all dummies for the mock upstreams). */
export function devEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, '..', '.env.dev.example'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

export const MOCK = process.env.E2E_MOCK_URL ?? 'http://localhost:9999';
/** First account and its temporary password: AUTH_RESET_USER / AUTH_RESET_PASSWORD in `.env.dev.example`. */
export const USERNAME = devEnv().AUTH_RESET_USER ?? 'admin';
export const SEED_PASSWORD = devEnv().AUTH_RESET_PASSWORD ?? '';
/** What the e2e run changes the temporary password to on a fresh database. */
export const PASSWORD = 'e2e only password 2026';

export async function setScenario(name: string, extra: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`${MOCK}/__scenario`, { method: 'POST', body: JSON.stringify({ name, ...extra }) });
  if (!res.ok) throw new Error(`could not set scenario ${name}: ${res.status}`);
}

/** Where the APP reaches the mock (differs from the test runner's view in docker compose). */
export const MOCK_FOR_APP = process.env.E2E_MOCK_INTERNAL_URL ?? MOCK;

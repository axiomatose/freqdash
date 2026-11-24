import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { devEnv } from './env';

const API = [
  'summary',
  'overview',
  'status',
  'trades',
  'findings',
  'acks',
  'equity?range=7d',
  'bots/votemax',
  'kraken/orders',
  'chart?bot=votemax&pair=BTC/USD&tf=4h',
];

test('no /api/v1 route answers without a session cookie', async ({ request }) => {
  for (const path of API) {
    const res = await request.get(`/api/v1/${path}`);
    expect(res.status(), path).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  }
});

test('pages redirect to the login page without a session', async ({ request }) => {
  const res = await request.get('/', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toMatch(/^\/login/);
});

test('the client bundle contains none of the configured secret values', () => {
  test.skip(!existsSync('.next/static'), 'needs a local production build');
  const env = devEnv();
  const secrets = ['SESSION_SECRET', 'KRAKEN_API_KEY', 'KRAKEN_API_SECRET', 'FT_BOT_1_PASSWORD', 'FT_BOT_2_PASSWORD']
    .map((k) => env[k])
    .filter((v): v is string => Boolean(v));
  expect(secrets.length).toBeGreaterThan(3);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const files = walk('.next/static').filter((f) => /\.(js|css|html|json|map)$/.test(f));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const s of secrets) expect(text.includes(s), `${f} leaks a secret`).toBe(false);
  }
});

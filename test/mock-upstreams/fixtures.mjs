// Fixture and credential loading for the mock upstreams. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const RAW = process.env.MOCK_FIXTURES_DIR ?? path.join(REPO, 'test', 'fixtures', 'raw');

const cache = new Map();

export function hasFixture(rel) {
  return fs.existsSync(path.join(RAW, rel));
}

/** Parsed fixture under test/fixtures/raw, as a private deep copy (callers may mutate it). */
export function fixture(rel) {
  if (!cache.has(rel)) cache.set(rel, JSON.parse(fs.readFileSync(path.join(RAW, rel), 'utf8')));
  return structuredClone(cache.get(rel));
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && m[1] && !line.trimStart().startsWith('#')) out[m[1]] = (m[2] ?? '').trim();
  }
  return out;
}

// Dummy values, identical to .env.dev.example; used only when that file is not reachable (for example in a container).
const DEFAULTS = {
  bots: [
    { id: 'votemax', username: 'mock-votemax-user', password: 'mock-votemax-pass' },
    { id: 'dca', username: 'mock-dca-user', password: 'mock-dca-pass' },
  ],
  krakenKey: 'DEVONLYMOCKKRAKENAPIKEY000000000000000000000000000000000',
  krakenSecret: 'ZGV2LW9ubHktbW9jay1rcmFrZW4tc2VjcmV0LW5vdC1hLXJlYWwta2V5LS0tLS0tLS0tLS0tLS0tLS0tLS0tLQ==',
};

/** Test credentials: the mock reads `.env.dev.example` (or MOCK_ENV_FILE) and never the process environment. */
export function loadCredentials() {
  const file = process.env.MOCK_ENV_FILE ?? path.join(REPO, '.env.dev.example');
  if (!fs.existsSync(file)) return { ...DEFAULTS, source: 'built-in defaults' };
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  const bots = [];
  for (let n = 1; n <= 10; n++) {
    const id = env[`FT_BOT_${n}_ID`];
    const username = env[`FT_BOT_${n}_USERNAME`];
    const password = env[`FT_BOT_${n}_PASSWORD`];
    if (id && username && password) bots.push({ id, username, password });
  }
  return {
    bots: bots.length > 0 ? bots : DEFAULTS.bots,
    krakenKey: env.KRAKEN_API_KEY || DEFAULTS.krakenKey,
    krakenSecret: env.KRAKEN_API_SECRET || DEFAULTS.krakenSecret,
    source: path.relative(REPO, file) || file,
  };
}

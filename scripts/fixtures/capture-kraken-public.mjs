#!/usr/bin/env node
// Captures live Kraken PUBLIC responses (GET only) as fixtures. Plain Node ESM, no dependencies.
//
//   node scripts/fixtures/capture-kraken-public.mjs [--out DIR]
//
// Only api.kraken.com/0/public/* is contacted. Private endpoints are never called. Each response body is
// written exactly as received (so the fixture is the real wire format), plus a small MANIFEST.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : path.join(REPO, 'test', 'fixtures', 'raw', 'kraken', 'public');

const BASE = 'https://api.kraken.com/0/public';
const PAIRS = 'XBTUSD,ETHUSD,SHIBUSD,BABYUSD';

const CAPTURES = [
  ['Time.json', 'Time'],
  ['Assets.json', 'Assets?asset=XBT,ETH,USD,SHIB,BABY'],
  ['AssetPairs.json', `AssetPairs?pair=${PAIRS}`],
  ['Ticker.json', `Ticker?pair=${PAIRS}`],
  ['OHLC.XBTUSD.240.json', 'OHLC?pair=XBTUSD&interval=240'],
  ['OHLC.ETHUSD.240.json', 'OHLC?pair=ETHUSD&interval=240'],
  ['OHLC.XBTUSD.60.json', 'OHLC?pair=XBTUSD&interval=60'],
];

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { capturedAt: new Date().toISOString(), base: BASE, files: {} };
  for (const [file, endpoint] of CAPTURES) {
    const res = await fetch(`${BASE}/${endpoint}`, { method: 'GET', signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    const parsed = JSON.parse(body);
    if (!res.ok || (Array.isArray(parsed.error) && parsed.error.length > 0)) {
      throw new Error(`${endpoint}: HTTP ${res.status} ${JSON.stringify(parsed.error)}`);
    }
    fs.writeFileSync(path.join(outDir, file), body.endsWith('\n') ? body : `${body}\n`);
    manifest.files[file] = { endpoint, bytes: Buffer.byteLength(body) };
    process.stdout.write(`${file}  ${Buffer.byteLength(body)} bytes\n`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 1)}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});

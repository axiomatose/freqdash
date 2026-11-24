#!/usr/bin/env node
// Signs and sends one private Kraken request to the mock, for manual curl-style checks.
//
//   node test/mock-upstreams/kraken-call.mjs Balance
//   node test/mock-upstreams/kraken-call.mjs ClosedOrders ofs=0 closetime=close
//   node test/mock-upstreams/kraken-call.mjs Balance --bad-signature
//   node test/mock-upstreams/kraken-call.mjs Balance --nonce=1          (rejected once a larger nonce was used)
//
// Base URL: MOCK_BASE (default http://localhost:9999). The key and secret come from .env.dev.example (dummy values).
import { loadCredentials } from './fixtures.mjs';
import { krakenSign } from './kraken.mjs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [method, ...pairs] = args.filter((a) => !a.startsWith('--'));
if (!method) {
  console.error('usage: kraken-call.mjs <Method> [key=value ...] [--bad-signature] [--nonce=N]');
  process.exit(2);
}

const creds = loadCredentials();
const nonceFlag = flags.find((f) => f.startsWith('--nonce='));
const nonce = nonceFlag ? nonceFlag.slice('--nonce='.length) : String(Date.now());
const params = new URLSearchParams({ nonce });
for (const pair of pairs) {
  const eq = pair.indexOf('=');
  params.set(pair.slice(0, eq < 0 ? pair.length : eq), eq < 0 ? '' : pair.slice(eq + 1));
}
const body = params.toString();
const path = `/0/private/${method}`;
const secret = flags.includes('--bad-signature')
  ? Buffer.from('not-the-mock-secret').toString('base64')
  : creds.krakenSecret;

const base = (process.env.MOCK_BASE ?? 'http://localhost:9999').replace(/\/+$/, '');
const res = await fetch(`${base}/kraken${path}`, {
  method: 'POST',
  headers: {
    'API-Key': creds.krakenKey,
    'API-Sign': krakenSign(path, nonce, Buffer.from(body), secret),
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body,
});
console.log(JSON.stringify(await res.json(), null, 2));

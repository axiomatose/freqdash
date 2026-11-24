#!/usr/bin/env node
// Killswitch agent: the ONLY component that touches the Docker socket, and the only thing it can do is stop
// containers from a fixed allowlist. freqdash (a web-facing app) never gets the socket; it asks this agent.
//
//   POST /stop   Authorization: Bearer <KILLSWITCH_TOKEN>   {"container":"freqtrade-votemax"}
//   GET  /health
//
// Environment: KILLSWITCH_TOKEN (required, 24+ chars), KILLSWITCH_ALLOWED (comma separated container names, required),
// PORT (9100), DOCKER_SOCKET (/var/run/docker.sock), STOP_TIMEOUT_SEC (10).
// Zero dependencies, on purpose: the whole thing is meant to be read in a minute.
import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 1024;

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** POST /containers/<name>/stop over the Docker unix socket. Resolves with the HTTP status. */
export function dockerStop(socketPath, name, timeoutSec) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method: 'POST',
        path: `/containers/${encodeURIComponent(name)}/stop?t=${timeoutSec}`,
        timeout: (timeoutSec + 15) * 1000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('timeout', () => req.destroy(new Error('docker timed out')));
    req.on('error', reject);
    req.end();
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * True when neither KILLSWITCH_TOKEN nor KILLSWITCH_ALLOWED is set: the killswitch is not in use, so the agent idles
 * instead of failing (a crash would make Docker restart it forever). Half a configuration is still an error.
 */
export function isUnconfigured(env) {
  return (env.KILLSWITCH_TOKEN ?? '').trim() === '' && (env.KILLSWITCH_ALLOWED ?? '').trim() === '';
}

export function createAgent({ token, allowed, stop, log = () => {} }) {
  if (typeof token !== 'string' || token.length < 24)
    throw new Error('KILLSWITCH_TOKEN must be at least 24 characters');
  const allow = new Set(allowed);
  if (allow.size === 0) throw new Error('KILLSWITCH_ALLOWED must list at least one container');

  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, allowed: [...allow] });
    if (req.method !== 'POST' || req.url !== '/stop') return send(res, 404, { ok: false, error: 'not found' });

    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) {
      log('rejected: bad token');
      return send(res, 401, { ok: false, error: 'unauthorized' });
    }

    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let container;
      try {
        container = JSON.parse(raw).container;
      } catch {
        return send(res, 400, { ok: false, error: 'invalid JSON' });
      }
      if (typeof container !== 'string' || !allow.has(container)) {
        log(`rejected: container not allowed (${String(container).slice(0, 64)})`);
        return send(res, 403, { ok: false, error: 'container not allowed' });
      }
      try {
        const status = await stop(container);
        // 204 stopped, 304 was already stopped, 404 no such container.
        if (status === 204 || status === 304) {
          log(`stopped ${container} (${status})`);
          return send(res, 200, { ok: true, container, result: status === 304 ? 'already-stopped' : 'stopped' });
        }
        log(`docker answered ${status} for ${container}`);
        return send(res, 502, { ok: false, container, error: `docker answered ${status}` });
      } catch (err) {
        log(`docker error for ${container}: ${err instanceof Error ? err.message : 'unknown'}`);
        return send(res, 502, { ok: false, container, error: 'docker unavailable' });
      }
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && isUnconfigured(process.env)) {
  // Not configured: listen on nothing and stay up, so `docker compose up` shows a running container, not a restart loop.
  console.log(JSON.stringify({ msg: 'killswitch agent not configured (no token, no allowlist): idle' }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const socket = env.DOCKER_SOCKET ?? '/var/run/docker.sock';
  const timeout = Number(env.STOP_TIMEOUT_SEC ?? 10);
  const server = createAgent({
    token: env.KILLSWITCH_TOKEN ?? '',
    allowed: (env.KILLSWITCH_ALLOWED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    stop: (name) => dockerStop(socket, name, timeout),
    log: (m) => console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'killswitch-agent', msg: m })),
  });
  server.listen(Number(env.PORT ?? 9100), '0.0.0.0', () =>
    console.log(JSON.stringify({ msg: 'killswitch agent listening' })),
  );
}

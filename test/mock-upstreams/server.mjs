#!/usr/bin/env node
// freqdash mock upstreams: two freqtrade bots, the Kraken REST API, and Discord on one port, for tests and local
// development. Zero dependencies (Node 22 built-ins). `npm run mock` starts it on port 9999 (env MOCK_PORT overrides).
// See README.md in this directory for the endpoints, the scenarios and curl examples.
import http from 'node:http';
import path from 'node:path';
import { HERE, fixture, loadCredentials } from './fixtures.mjs';
import { PUBLIC_ENDPOINTS, ENDPOINTS, checkBasicAuth, freqtradeResponse } from './freqtrade.mjs';
import {
  PRIVATE_ALLOWLIST,
  authenticatePrivate,
  krakenAccount,
  ordersAt,
  parseParams,
  privateResponse,
  publicResponse,
} from './kraken.mjs';
import { LogWriter } from './logwriter.mjs';
import { openaiChat, openaiModels } from './openai.mjs';
import {
  SCENARIO_NAMES,
  activeOutage,
  botAvailability,
  incidentProgress,
  makeScenario,
  parseScenarioRequest,
  periodicIntervalMs,
  startupTsAt,
} from './scenarios.mjs';

const MAX_BODY_BYTES = 1_048_576;
const MAX_JOURNAL = 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createClock() {
  let frozen = null;
  let offset = 0;
  const now = () => frozen ?? Date.now() + offset;
  return {
    now,
    mode: () => (frozen === null ? 'real' : 'manual'),
    /**
     * {mode?: 'real'|'manual', now?: ms, advanceMs?: ms}. 'manual' freezes the clock (at `now` if given), 'real' returns to
     * the wall clock (shifted to `now` if given), `now` alone jumps, `advanceMs` moves it forward.
     */
    apply({ mode, now: target, advanceMs }) {
      const current = now();
      if (mode === 'manual') frozen = target ?? current;
      else if (mode === 'real') {
        frozen = null;
        offset = target === undefined ? 0 : target - Date.now();
      } else if (target !== undefined) {
        if (frozen === null) offset = target - Date.now();
        else frozen = target;
      }
      if (advanceMs) {
        if (frozen === null) offset += advanceMs;
        else frozen += advanceMs;
      }
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = (await readBody(req)).toString('utf8').trim();
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * Creates the mock (not yet listening). Options: runDir (log directory), hangMs (how long a hanging bot holds a
 * connection before dropping it).
 */
function createMock({ runDir = path.join(HERE, '.run'), hangMs = 30_000 } = {}) {
  const creds = loadCredentials();
  const bots = new Map(creds.bots.map((b) => [b.id, b]));
  const clock = createClock();
  const nonces = new Map();
  const received = [];
  const calls = [];
  let seq = 0;

  const logs = new LogWriter({
    runDir,
    bots: creds.bots.map((b) => b.id),
    version: fixture('freqtrade/votemax_version.json').version,
  });
  const baselineStartupTs = fixture('freqtrade/votemax_health.json').bot_startup_ts;
  let scenario = makeScenario({ name: 'normal' }, clock.now());
  logs.reset(scenario);
  logs.flush(scenario, clock.now());

  const world = () => ({ now: clock.now(), scenario });

  function activate(request) {
    scenario = makeScenario(request, clock.now());
    if (request.resetNonce) nonces.clear();
    logs.reset(scenario, request.resetLogs);
    logs.flush(scenario, clock.now());
  }

  const scenarioInfo = () => ({
    name: scenario.name,
    speed: scenario.speed,
    delayMs: scenario.delayMs,
    gapCapSec: scenario.gapCapSec,
    mode: scenario.botDownMode,
    startedAt: scenario.startedAt,
    available: SCENARIO_NAMES,
  });

  function stateBody() {
    const now = clock.now();
    logs.flush(scenario, now);
    const body = {
      now,
      nowIso: new Date(now).toISOString(),
      clock: { mode: clock.mode() },
      scenario: scenarioInfo(),
      elapsedMs: (now - scenario.startedAt) * scenario.speed,
      heartbeatEveryMs: periodicIntervalMs(scenario.speed),
      bots: Object.fromEntries(
        [...bots.keys()].map((id) => [id, { availability: botAvailability(id, scenario, now) }]),
      ),
      logs: logs.summary(),
      kraken: {
        openOrders: ordersAt({ now, scenario }).open.length,
        closedOrders: ordersAt({ now, scenario }).closed.length,
        balances: Object.fromEntries(krakenAccount({ now, scenario }).rows.map((r) => [r.asset, r.balance])),
      },
      incident: null,
    };
    if (scenario.plan) {
      const plan = scenario.plan;
      body.incident = {
        ...incidentProgress(plan, now),
        votemax: {
          outageActive: activeOutage(plan, now)?.kind ?? null,
          outages: plan.outages,
          startupTs: startupTsAt(plan, now, baselineStartupTs),
        },
      };
    }
    return body;
  }

  // -------------------------------------------------------------------------------------- control endpoints

  async function control(req, res, pathname, url, meta) {
    meta.skip = true;
    const method = req.method ?? 'GET';
    switch (pathname) {
      case '/__scenario': {
        if (method === 'GET') return send(res, 200, scenarioInfo());
        if (method !== 'POST') throw new HttpError(405, 'use GET or POST');
        const parsed = parseScenarioRequest(await readJson(req));
        if (!parsed.ok) throw new HttpError(400, parsed.message);
        activate(parsed.value);
        return send(res, 200, scenarioInfo());
      }
      case '/__state':
        return send(res, 200, stateBody());
      case '/__clock': {
        if (method === 'POST') {
          const body = await readJson(req);
          const bad =
            (body.mode !== undefined && body.mode !== 'real' && body.mode !== 'manual') ||
            ['now', 'advanceMs'].some((k) => body[k] !== undefined && !Number.isFinite(body[k]));
          if (bad) throw new HttpError(400, 'body: {mode?: "real"|"manual", now?: ms, advanceMs?: ms}');
          clock.apply(body);
          logs.flush(scenario, clock.now());
        } else if (method !== 'GET') throw new HttpError(405, 'use GET or POST');
        return send(res, 200, { now: clock.now(), mode: clock.mode() });
      }
      case '/__received': {
        if (method === 'DELETE') {
          received.length = 0;
          return send(res, 204);
        }
        if (method !== 'GET') throw new HttpError(405, 'use GET or DELETE');
        return send(res, 200, {
          count: received.length,
          discord: received.filter((r) => r.channel === 'discord'),
        });
      }
      case '/__calls': {
        if (method === 'DELETE') {
          calls.length = 0;
          return send(res, 204);
        }
        if (method !== 'GET') throw new HttpError(405, 'use GET or DELETE');
        const only = url.searchParams.get('violations');
        const items = only === '1' || only === 'true' ? calls.filter((c) => c.violation) : calls;
        return send(res, 200, { count: items.length, calls: items });
      }
      default:
        throw new HttpError(404, 'unknown control endpoint');
    }
  }

  // -------------------------------------------------------------------------------------- notification sinks

  async function sink(req, res, pathname, url, channel) {
    const body = await readBody(req);
    const text = body.toString('utf8');
    let parsed = text;
    if (/json/i.test(req.headers['content-type'] ?? '')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    seq += 1;
    received.push({
      seq,
      at: clock.now(),
      channel,
      method: req.method,
      path: pathname,
      query: Object.fromEntries(url.searchParams),
      body: parsed,
    });
    if (received.length > MAX_JOURNAL) received.shift();
    return url.searchParams.get('wait') === 'true' ? send(res, 200, { id: String(seq), type: 0 }) : send(res, 204);
  }

  // -------------------------------------------------------------------------------------- upstream endpoints

  function failBot(req, res, mode, meta) {
    meta.outcome = mode;
    if (mode === '503') return send(res, 503, { detail: 'Service Unavailable' });
    if (mode === 'reset') {
      req.socket.destroy();
      return undefined;
    }
    const timer = setTimeout(() => req.socket.destroy(), hangMs);
    res.on('close', () => clearTimeout(timer));
    return undefined;
  }

  function freqtrade(req, res, botId, endpoint, url, meta) {
    const bot = bots.get(botId);
    const method = req.method ?? 'GET';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      meta.violation = `${method} to a freqtrade bot (the app must be read-only)`;
    const now = clock.now();
    const availability = botAvailability(botId, scenario, now);
    if (availability !== 'up') return failBot(req, res, availability, meta);
    if (method !== 'GET' && method !== 'HEAD')
      return send(res, 405, { detail: 'Method Not Allowed' }, { Allow: 'GET, HEAD' });
    if (!ENDPOINTS.includes(endpoint)) return send(res, 404, { detail: 'Not Found' });
    if (!PUBLIC_ENDPOINTS.includes(endpoint) && !checkBasicAuth(req.headers.authorization, bot)) {
      return send(res, 401, { detail: 'Unauthorized' }, { 'WWW-Authenticate': 'Basic realm="freqtrade"' });
    }
    const w = world();
    const result = freqtradeResponse(botId, endpoint, url.searchParams, w, {
      logRecords: (id, limit) => logs.records(id, limit),
      krakenRows: () => krakenAccount(w).rows,
    });
    return send(res, result.status, result.body);
  }

  function krakenPublic(req, res, name, url, bodyParams) {
    const params = { ...Object.fromEntries(url.searchParams), ...bodyParams };
    const result = publicResponse(name, params, world());
    return send(res, result.status, result.body);
  }

  async function krakenPrivate(req, res, name, meta) {
    const body = await readBody(req);
    if (scenario.name === 'no-kraken') {
      meta.violation = 'private Kraken endpoint called while Kraken is not configured (no-kraken)';
      return send(res, 404, { error: ['EGeneral:Unknown method'], result: {} });
    }
    if (!PRIVATE_ALLOWLIST.includes(name))
      meta.violation = `Kraken private method ${name} is not in the read-only allowlist`;
    if (req.method !== 'POST') return send(res, 405, { error: ['EGeneral:Invalid arguments'], result: {} });
    if (scenario.name === 'kraken-auth-error') return send(res, 200, { error: ['EAPI:Invalid key'], result: {} });
    const auth = authenticatePrivate(
      { path: `/0/private/${name}`, headers: req.headers, body },
      { key: creds.krakenKey, secret: creds.krakenSecret, nonces },
    );
    if (!auth.ok) return send(res, 200, { error: [auth.error], result: {} });
    const result = privateResponse(name, auth.params, world());
    return send(res, result.status, result.body);
  }

  // -------------------------------------------------------------------------------------- routing

  async function route(req, res, meta) {
    let url;
    let pathname;
    try {
      url = new URL(req.url ?? '/', 'http://mock');
      pathname = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
    } catch {
      throw new HttpError(400, 'bad request path');
    }
    logs.flush(scenario, clock.now());

    if (pathname.startsWith('/__')) return control(req, res, pathname, url, meta);
    if (pathname === '/') {
      meta.skip = true;
      return send(res, 200, {
        ok: true,
        name: 'freqdash-mock-upstreams',
        scenario: scenarioInfo(),
        bots: [...bots.keys()],
      });
    }

    let m = /^\/kraken\/0\/public\/([A-Za-z]+)\/?$/.exec(pathname);
    if (m?.[1]) {
      const bodyParams = req.method === 'POST' ? parseParams(await readBody(req), req.headers['content-type']) : {};
      return krakenPublic(req, res, m[1], url, bodyParams);
    }
    m = /^\/kraken\/0\/private\/([A-Za-z]+)\/?$/.exec(pathname);
    if (m?.[1]) return krakenPrivate(req, res, m[1], meta);
    if (req.method === 'POST' && pathname === '/openai/v1/chat/completions') {
      return openaiChat(req, res, await readBody(req), send);
    }
    if (req.method === 'GET' && pathname === '/openai/v1/models') return openaiModels(req, res, send);
    if (/^\/discord\/webhook(\/.*)?$/.test(pathname)) return sink(req, res, pathname, url, 'discord');
    m = /^\/([a-z0-9-]+)\/api\/v1\/([a-z_]+)\/?$/.exec(pathname);
    if (m?.[1] && m[2] && bots.has(m[1])) return freqtrade(req, res, m[1], m[2], url, meta);
    return send(res, 404, { error: 'not_found', message: `no mock route for ${req.method} ${pathname}` });
  }

  const server = http.createServer((req, res) => {
    const meta = { skip: false, violation: null, outcome: null };
    const startedUrl = req.url ?? '';
    res.on('close', () => {
      if (meta.skip) return;
      seq += 1;
      calls.push({
        seq,
        at: clock.now(),
        method: req.method,
        path: startedUrl.replace(/([?&](?:token|key|secret)=)[^&]*/gi, '$1REDACTED'),
        status: meta.outcome ?? res.statusCode,
        violation: meta.violation,
      });
      if (calls.length > MAX_JOURNAL) calls.shift();
    });
    route(req, res, meta).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, {
        error: status === 500 ? 'internal' : 'bad_request',
        message: err instanceof Error ? err.message : 'error',
      });
    });
  });

  const flushTimer = setInterval(() => logs.flush(scenario, clock.now()), 200);
  flushTimer.unref();

  return {
    server,
    creds,
    runDir,
    close() {
      clearInterval(flushTimer);
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host });
  });
}

async function main() {
  const port = Number.parseInt(process.env.MOCK_PORT ?? '9999', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[mock] invalid MOCK_PORT: ${process.env.MOCK_PORT}`);
    process.exit(1);
  }
  const mock = createMock({
    runDir: process.env.MOCK_RUN_DIR ? path.resolve(process.env.MOCK_RUN_DIR) : path.join(HERE, '.run'),
    hangMs: Number.parseInt(process.env.MOCK_HANG_MS ?? '30000', 10),
  });
  let address;
  try {
    // Dual-stack first so both http://localhost (::1) and 127.0.0.1 work; plain IPv4 where IPv6 is unavailable.
    address = await listen(mock.server, port, process.env.MOCK_HOST ?? '::').catch((err) => {
      if (process.env.MOCK_HOST || !['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(err.code)) throw err;
      return listen(mock.server, port, '0.0.0.0');
    });
  } catch (err) {
    console.error(`[mock] cannot listen on port ${port}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  const actual = typeof address === 'object' && address ? address.port : port;
  console.log(`[mock] freqdash mock upstreams on http://localhost:${actual}  (scenario: normal)`);
  console.log(
    `[mock] credentials from ${mock.creds.source}; logs in ${path.relative(process.cwd(), mock.runDir) || mock.runDir}`,
  );
  console.log(`MOCK_LISTENING http://127.0.0.1:${actual}`);

  const shutdown = () => {
    void mock.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();

// Scenario definitions and the time-compressed replay of the 2026-09-28 incident (pure functions, no I/O apart
// from fixture reads). Node built-ins only.
//
// Time model. A scenario is activated at virtual time `startedAt` (ms since epoch; the virtual clock is the real clock
// unless a test freezes it). Everything the mock reports (log timestamps, Kraken order times, /health) is derived
// from that clock. The incident timeline is expressed as offsets in the ORIGINAL incident time; `plan.tOf(offset)`
// maps an offset to virtual time: `t0 + compress(offset) / speed`, where `compress` caps every quiet gap between two
// consecutive incident moments at `gapCapMs` (otherwise the 67 minute pause before the 25th order would dominate).
import { fixture } from './fixtures.mjs';

export const SCENARIO_NAMES = ['normal', 'incident', 'bot-down', 'kraken-auth-error', 'no-kraken'];
export const BOT_DOWN_MODES = ['reset', 'hang', '503'];
export const DEFAULT_INCIDENT_SPEED = 6; // the real crash loop placed an order every ~17 s; 17 / 6 is about 3 s
export const DEFAULT_INCIDENT_DELAY_MS = 3000;
export const DEFAULT_GAP_CAP_SEC = 90;
export const MIN_PERIODIC_MS = 250;
export const OUTAGE_GRACE_MS = 2000; // the API is still down this long (original time) after `Logfile configured`
export const SYNTH_ORDER_TXID = 'OWDY2Z-TVWRN-IJBALL';

/** Validates the body of POST /__scenario. Returns {ok:true, value} or {ok:false, message}. */
export function parseScenarioRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return { ok: false, message: 'body must be a JSON object' };
  const { name } = body;
  if (typeof name !== 'string' || !SCENARIO_NAMES.includes(name)) {
    return { ok: false, message: `name must be one of ${SCENARIO_NAMES.join(', ')}` };
  }
  const num = (key, min, max) => {
    const v = body[key];
    if (v === undefined || v === null) return { ok: true, value: undefined };
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      return { ok: false, message: `${key} must be a number in [${min}, ${max}]` };
    return { ok: true, value: v };
  };
  const speed = num('speed', 0.001, 100000);
  if (!speed.ok) return speed;
  const delayMs = num('delayMs', 0, 3_600_000);
  if (!delayMs.ok) return delayMs;
  const gapCapSec = num('gapCapSec', 0, 86_400);
  if (!gapCapSec.ok) return gapCapSec;
  let botDownMode = null;
  if (body.mode !== undefined && body.mode !== null) {
    if (typeof body.mode !== 'string' || !BOT_DOWN_MODES.includes(body.mode)) {
      return { ok: false, message: `mode must be one of ${BOT_DOWN_MODES.join(', ')}` };
    }
    botDownMode = body.mode;
  }
  for (const flag of ['resetLogs', 'resetNonce']) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean')
      return { ok: false, message: `${flag} must be a boolean` };
  }
  return {
    ok: true,
    value: {
      name,
      speed: speed.value,
      delayMs: delayMs.value,
      gapCapSec: gapCapSec.value,
      botDownMode,
      resetLogs: body.resetLogs ?? true,
      resetNonce: body.resetNonce ?? false,
    },
  };
}

/** Builds the runtime scenario object. `now` is the virtual time of activation. */
export function makeScenario(request, now) {
  const incident = request.name === 'incident';
  const speed = request.speed ?? (incident ? DEFAULT_INCIDENT_SPEED : 1);
  const delayMs = request.delayMs ?? (incident ? DEFAULT_INCIDENT_DELAY_MS : 0);
  const gapCapSec = request.gapCapSec ?? DEFAULT_GAP_CAP_SEC;
  const scenario = {
    name: request.name,
    speed,
    delayMs,
    gapCapSec,
    botDownMode: request.name === 'bot-down' ? request.botDownMode : null,
    startedAt: now,
    t0: now + delayMs,
    plan: null,
  };
  if (incident) {
    scenario.plan = buildIncidentPlan(loadIncidentData(), { t0: scenario.t0, speed, gapCapMs: gapCapSec * 1000 });
  }
  return scenario;
}

export function loadIncidentData() {
  return {
    timeline: fixture('incident/timeline.json'),
    closed: fixture('kraken/private/ClosedOrders.incident.json').result.closed,
  };
}

// ------------------------------------------------------------------------------------------ incident plan

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/freqtrade/freqtrade/main.py", line 52, in main',
  '    return_code = args["func"](args)',
  '  File "/freqtrade/freqtrade/commands/trade_commands.py", line 25, in start_trading',
  '    worker.run()',
  '  File "/freqtrade/freqtrade/worker.py", line 79, in run',
  '    state = self._worker(old_state=state)',
  '  File "/freqtrade/freqtrade/freqtradebot.py", line 654, in enter_positions',
  '    trades_created += self.create_trade(pair)',
  '  File "/freqtrade/freqtrade/freqtradebot.py", line 1014, in execute_entry',
  '    trade = Trade(',
  '  File "/freqtrade/freqtrade/util/ft_precise.py", line 13, in __init__',
  '    super().__init__(number, decimals)',
  '  File "/home/ftuser/.local/lib/python3.14/site-packages/ccxt/base/precise.py", line 21, in __init__',
  '    modifier = int(modifier)',
];

const FATAL_FALLBACK = "ValueError: invalid literal for int() with base 10: ''";

/** Log records (offsets in ms relative to the event) that one timeline event produces, in the real bot's format. */
function recordsForEvent(ev) {
  const ftbot = 'freqtrade.freqtradebot';
  switch (ev.type) {
    case 'entry_signal':
      return [
        {
          d: 0,
          logger: ftbot,
          level: 'INFO',
          message: `Long signal found: about create a new trade for ${ev.pair} with stake_amount: ${ev.stakeUsd} and price: ${ev.price} ...`,
        },
      ];
    case 'order_created':
      return [
        {
          d: 0,
          logger: ftbot,
          level: 'INFO',
          message: `Order ${ev.orderId} was created for ${ev.pair} and status is open.`,
        },
      ];
    case 'order_failed':
      return [
        { d: 0, logger: ftbot, level: 'WARNING', message: `Unable to create trade for ${ev.pair}: ${ev.message}` },
      ];
    case 'process_died':
      return [
        { d: -1, logger: 'freqtrade.commands.trade_commands', level: 'INFO', message: 'worker found ... calling exit' },
        {
          d: 0,
          logger: 'freqtrade.rpc.rpc_manager',
          level: 'INFO',
          message: "Sending rpc message: {'type': status, 'status': 'process died'}",
        },
        { d: 100, logger: ftbot, level: 'INFO', message: 'Cleaning up modules ...' },
        { d: 200, logger: 'freqtrade.rpc.rpc_manager', level: 'INFO', message: 'Cleaning up rpc modules ...' },
        { d: 300, logger: 'freqtrade.rpc.api_server.webserver', level: 'INFO', message: 'Stopping API Server' },
      ];
    case 'fatal':
      return [
        {
          d: 0,
          logger: 'freqtrade',
          level: 'ERROR',
          message: ['Fatal exception!', ...TRACEBACK, ev.message ?? FATAL_FALLBACK].join('\n'),
        },
      ];
    case 'startup':
      return [
        { d: -1, logger: 'freqtrade.loggers', level: 'INFO', message: 'Enabling colorized output.' },
        { d: 0, logger: 'freqtrade.loggers', level: 'INFO', message: 'Logfile configured' },
        { d: 1, logger: 'freqtrade.loggers', level: 'INFO', message: 'Verbosity set to 2' },
        { d: 2, logger: 'freqtrade.configuration.configuration', level: 'INFO', message: 'Runmode set to live.' },
      ];
    default:
      return [];
  }
}

/** Piecewise-linear, monotone map of original offsets that caps each gap between two anchors at `capMs` (0 = no cap). */
export function makeCompressor(anchors, capMs) {
  const a = [...new Set(anchors)].sort((x, y) => x - y);
  const c = [0];
  for (let i = 1; i < a.length; i++) {
    const gap = a[i] - a[i - 1];
    c.push(c[i - 1] + (capMs > 0 ? Math.min(gap, capMs) : gap));
  }
  const last = a.length - 1;
  return (o) => {
    if (o <= a[0]) return o - a[0];
    if (o >= a[last]) return c[last] + (o - a[last]);
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= o) lo = mid;
      else hi = mid;
    }
    return c[lo] + (o - a[lo]) * ((c[hi] - c[lo]) / (a[hi] - a[lo]));
  };
}

export function buildIncidentPlan({ timeline, closed }, { t0, speed, gapCapMs }) {
  const T0 = timeline.events[0].at;
  const events = timeline.events.map((e, idx) => ({ ...e, idx, o: e.at - T0 }));
  const lastEventO = Math.max(...events.map((e) => e.o));

  // Orders the incident produced: every Kraken order opened inside the incident window (25 logged + 1 Kraken-only).
  const orders = Object.entries(closed)
    .filter(([, rec]) => {
      const ms = Math.round(rec.opentm * 1000);
      return ms >= T0 - 60_000 && ms <= T0 + lastEventO + 120_000;
    })
    .map(([txid, rec]) => ({
      txid,
      rec,
      openO: Math.round(rec.opentm * 1000) - T0,
      closeO: Math.round(rec.closetm * 1000) - T0,
    }));
  const incidentIds = new Set(orders.map((o) => o.txid));

  const compress = makeCompressor([...events.map((e) => e.o), ...orders.flatMap((o) => [o.openO, o.closeO])], gapCapMs);
  const tOf = (o) => Math.round(t0 + compress(o) / speed);

  const raw = [];
  for (const ev of events) {
    for (const r of recordsForEvent(ev))
      raw.push({ o: ev.o + r.d, seq: raw.length, logger: r.logger, level: r.level, message: r.message });
  }
  raw.sort((x, y) => x.o - y.o || x.seq - y.seq);
  const logLines = raw.map((r) => ({ t: tOf(r.o), logger: r.logger, level: r.level, message: r.message }));

  const timed = events.map((e) => ({ ...e, t: tOf(e.o) }));
  const startups = timed.filter((e) => e.type === 'startup').map((e) => ({ t: e.t }));
  const outages = [];
  for (const died of timed.filter((e) => e.type === 'process_died')) {
    const next = timed.find((e) => e.type === 'startup' && e.o > died.o);
    const end = next ? next.t + Math.round(OUTAGE_GRACE_MS / speed) : died.t + Math.round(20_000 / speed);
    outages.push({ start: died.t, end: Math.max(end, died.t + 1), kind: outages.length % 2 === 0 ? 'reset' : '503' });
  }

  const krakenOrders = orders
    .map((o) => ({ txid: o.txid, rec: o.rec, openT: tOf(o.openO), closeT: tOf(o.closeO) }))
    .sort((x, y) => x.openT - y.openT || x.txid.localeCompare(y.txid));
  const staticClosed = Object.entries(closed).filter(([txid]) => !incidentIds.has(txid));

  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const endsAt = Math.max(...timed.map((e) => e.t), ...krakenOrders.map((o) => o.closeT));

  return {
    t0,
    speed,
    gapCapMs,
    tOf,
    timed,
    logLines,
    startups,
    outages,
    orders: krakenOrders,
    staticClosed,
    totals: counts,
    endsAt,
  };
}

// ------------------------------------------------------------------------------------------ derived state

export function activeOutage(plan, now) {
  return plan.outages.find((o) => now >= o.start && now < o.end) ?? null;
}

/** How a bot's API answers right now: 'up', or the failure mode ('reset', 'hang', '503'). */
export function botAvailability(botId, scenario, now) {
  if (scenario.name === 'bot-down') return scenario.botDownMode ?? (botId === 'votemax' ? 'reset' : 'hang');
  if (scenario.name === 'incident' && botId === 'votemax') return activeOutage(scenario.plan, now)?.kind ?? 'up';
  return 'up';
}

/** `bot_startup_ts` (seconds): the fixture value until the first simulated restart, then strictly increasing. */
export function startupTsAt(plan, now, baselineTs) {
  let ts = baselineTs;
  for (const s of plan.startups) {
    if (s.t > now) break;
    ts = Math.max(Math.floor(s.t / 1000), ts + 1);
  }
  return ts;
}

export function incidentProgress(plan, now) {
  const seen = {};
  for (const e of plan.timed) if (e.t <= now) seen[e.type] = (seen[e.type] ?? 0) + 1;
  const visible = plan.orders.filter((o) => o.openT <= now);
  return {
    t0: plan.t0,
    endsAt: plan.endsAt,
    done: now >= plan.endsAt,
    counts: {
      entrySignals: seen.entry_signal ?? 0,
      ordersCreated: seen.order_created ?? 0,
      ordersFailed: seen.order_failed ?? 0,
      processDied: seen.process_died ?? 0,
      fatals: seen.fatal ?? 0,
      startups: seen.startup ?? 0,
    },
    totals: {
      entrySignals: plan.totals.entry_signal ?? 0,
      ordersCreated: plan.totals.order_created ?? 0,
      ordersFailed: plan.totals.order_failed ?? 0,
      processDied: plan.totals.process_died ?? 0,
      fatals: plan.totals.fatal ?? 0,
      startups: plan.totals.startup ?? 0,
      krakenOrders: plan.orders.length,
    },
    krakenOrdersVisible: visible.length,
    krakenOrdersOpen: visible.filter((o) => now < o.closeT).length,
  };
}

// ------------------------------------------------------------------------------------------ log helpers

export function formatLogTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('.', ',').replace('Z', '');
}

export function periodicIntervalMs(speed) {
  return Math.max(MIN_PERIODIC_MS, Math.round(60_000 / speed));
}

/** Heartbeat (every 60 s of scenario time) and wallet-sync lines with virtual time in (from, to]. */
export function periodicLines(botId, scenario, from, to, version) {
  if (scenario.name === 'bot-down') return [];
  const step = periodicIntervalMs(scenario.speed);
  const offset = Math.round(step / 4);
  const lines = [];
  const emit = (t, logger, message) => {
    if (t <= from || t > to) return;
    if (scenario.plan && botId === 'votemax' && activeOutage(scenario.plan, t)) return;
    lines.push({ t, logger, level: 'INFO', message });
  };
  const kFrom = Math.max(0, Math.floor((from - scenario.startedAt) / step) - 1);
  const kTo = Math.floor((to - scenario.startedAt) / step);
  // A huge jump of the virtual clock must not produce an unbounded number of lines.
  for (let k = Math.max(kFrom, kTo - 2000); k <= kTo; k++) {
    const base = scenario.startedAt + k * step;
    emit(base, 'freqtrade.worker', `Bot heartbeat. PID=1, version='${version}', state='RUNNING'`);
    emit(base + offset, 'freqtrade.wallets', 'Wallets synced.');
  }
  return lines.sort((a, b) => a.t - b.t);
}

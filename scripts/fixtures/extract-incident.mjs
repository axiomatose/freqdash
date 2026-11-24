#!/usr/bin/env node
// Extracts sanitized freqtrade log excerpts and the 2026-09-28 incident timeline.
// Plain Node ESM, no dependencies. Read-only on the source logs.
//
//   node scripts/fixtures/extract-incident.mjs [--incident-dir DIR] [--live-log FILE] [--out DIR]
//                                              [--normal-from ISO] [--normal-to ISO]
//
// Outputs (under --out, default <repo>/test/fixtures/raw):
//   logs/votemax-incident-2026-09-28.log   INFO+ records of the incident windows, DEBUG and urllib3 dropped
//   logs/votemax-normal-vv.log             2-minute DEBUG-inclusive excerpt of the live log, redacted
//   incident/timeline.json                 events parsed from the incident excerpt (ms UTC)
//
// The raw logs contain a Discord webhook URL (urllib3.connectionpool DEBUG lines), JWTs (uvicorn
// websocket lines) and browser cookies (uvicorn DEBUG header dumps). Every urllib3.connectionpool record
// is dropped, secret patterns are replaced by REDACTED, and the outputs are re-scanned before exit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const INCIDENT_MARKER = '2026-09-28 04:00:07,965';
const INCIDENT_WINDOWS = [
  ['2026-09-28T03:59:00.000Z', '2026-09-28T04:08:00.000Z'],
  ['2026-09-28T05:13:00.000Z', '2026-09-28T05:16:00.000Z'],
];
const DEFAULT_NORMAL_WINDOW = ['2026-09-28T22:20:00.000Z', '2026-09-28T22:22:00.000Z'];

const HEADER =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3}) - (\S+) - (DEBUG|INFO|WARNING|ERROR|CRITICAL) - (.*)$/;

const args = parseArgs(process.argv.slice(2));
const incidentDir = args['incident-dir'] ?? 'D:/docker/freqtrade/backups/incident-2026-09-28-logs';
const liveLog = args['live-log'] ?? 'D:/docker/freqtrade/logs/votemax.log';
const outDir = args.out ?? path.join(REPO, 'test', 'fixtures', 'raw');
const normalWindow = [args['normal-from'] ?? DEFAULT_NORMAL_WINDOW[0], args['normal-to'] ?? DEFAULT_NORMAL_WINDOW[1]];

// ---------------------------------------------------------------- redaction

// Value-level patterns. Replacement is the bare word REDACTED so no secret-looking key survives.
const VALUE_PATTERNS = [
  /(?:https?:\/\/)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi,
  /\/api\/webhooks\/[\w/-]+/g,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /eyJ[\w-]{10,}/g,
  /token=[^&\s"']+/gi,
];
// Lines that dump headers or credentials are replaced wholesale.
const SENSITIVE_LINE = /cookie|authorization|password|passwd|secret|api[-_]?key|api-sign|sec-websocket-key|bearer/i;

function redactValues(line) {
  let out = line;
  for (const re of VALUE_PATTERNS) out = out.replace(re, 'REDACTED');
  return out;
}

/** Returns the lines to emit for a record, or null when the record must be dropped. */
function sanitizeRecord(rec, stats) {
  if (rec.logger === 'urllib3.connectionpool') {
    stats.droppedUrllib3 += 1;
    return null;
  }
  if (rec.lines.some((l) => SENSITIVE_LINE.test(l))) {
    stats.redactedRecords += 1;
    return [`${rec.header} - REDACTED`];
  }
  return rec.lines.map((l) => {
    const r = redactValues(l);
    if (r !== l) stats.redactedValues += 1;
    return r;
  });
}

// ---------------------------------------------------------------- parsing

function parseRecords(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const records = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = HEADER.exec(line);
    if (m) {
      const [, y, mo, d, h, mi, s, ms, logger, level, message] = m;
      cur = {
        at: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms),
        logger,
        level,
        message,
        header: `${line.slice(0, 23)} - ${logger} - ${level}`,
        lines: [line],
      };
      records.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return records;
}

function inWindows(at, windows) {
  return windows.some(([from, to]) => at >= from && at < to);
}

function toMsWindows(iso) {
  return iso.map(([a, b]) => [Date.parse(a), Date.parse(b)]);
}

// ---------------------------------------------------------------- events

const RE_SIGNAL =
  /^Long signal found: about create a new trade for (\S+) with stake_amount: ([\d.]+) and price: ([\d.]+)/;
const RE_ORDER = /^Order (O[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}) was created for (\S+) and status is (\w+)/;
const RE_FAILED = /^Unable to create trade for (\S+?): (.*)$/;

/** Mirrors the event table of PLAN 6.2 (INFO+ records only). */
function extractEvents(records) {
  const events = [];
  const lastSignal = new Map();
  for (const r of records) {
    if (r.level === 'DEBUG') continue;
    const msg = r.message;
    let m;
    if (r.logger === 'freqtrade.loggers' && /^Logfile configured/.test(msg)) {
      events.push({ type: 'startup', at: r.at });
    } else if (r.logger === 'freqtrade' && r.level === 'ERROR' && /^Fatal exception/.test(msg)) {
      const tail = r.lines.slice(1).filter((l) => l.trim() !== '');
      events.push({ type: 'fatal', at: r.at, message: tail.length > 0 ? tail[tail.length - 1].trim() : msg });
    } else if (/Sending rpc message: .*'process died'/.test(msg)) {
      events.push({ type: 'process_died', at: r.at });
    } else if ((m = RE_SIGNAL.exec(msg))) {
      const sig = { type: 'entry_signal', at: r.at, pair: m[1], price: Number(m[3]), stakeUsd: Number(m[2]) };
      events.push(sig);
      lastSignal.set(m[1], sig);
    } else if ((m = RE_ORDER.exec(msg))) {
      const ev = { type: 'order_created', at: r.at, pair: m[2], orderId: m[1] };
      const sig = lastSignal.get(m[2]);
      if (sig && r.at - sig.at >= 0 && r.at - sig.at <= 5000) {
        ev.price = sig.price;
        ev.stakeUsd = sig.stakeUsd;
      }
      events.push(ev);
    } else if ((r.level === 'WARNING' || r.level === 'ERROR') && (m = RE_FAILED.exec(msg))) {
      events.push({ type: 'order_failed', at: r.at, pair: m[1], message: m[2] });
    }
  }
  return events
    .map((e, i) => [e, i])
    .sort((a, b) => a[0].at - b[0].at || a[1] - b[1])
    .map(([e]) => e);
}

const round8 = (x) => Math.round(x * 1e8) / 1e8;
const round5 = (x) => Math.round(x * 1e5) / 1e5;

function buildTimeline(records, windows, sourceFile) {
  const events = extractEvents(records);
  const count = (t) => events.filter((e) => e.type === t).length;
  const signals = events.filter((e) => e.type === 'entry_signal');
  const orders = events.filter((e) => e.type === 'order_created');
  const sum = (arr, f) => arr.reduce((a, e) => a + f(e), 0);
  const first = orders[0];
  const last = orders[orders.length - 1];
  return {
    schema: 1,
    bot: 'votemax',
    pair: 'ETH/USD',
    source: { file: sourceFile, note: 'rotated copy preserved after the incident; timestamps are UTC' },
    windows: windows.map(([a, b]) => ({ from: a, to: b, fromMs: Date.parse(a), toMs: Date.parse(b) })),
    counts: {
      entry_signal: count('entry_signal'),
      order_created: count('order_created'),
      order_failed: count('order_failed'),
      process_died: count('process_died'),
      fatal: count('fatal'),
      startup: count('startup'),
    },
    totals: {
      orderStakeUsd: round5(sum(orders, (e) => e.stakeUsd ?? 0)),
      orderVolEth: round8(sum(orders, (e) => round8((e.stakeUsd ?? 0) / (e.price ?? 1)))),
      signalStakeUsd: round5(sum(signals, (e) => e.stakeUsd)),
      signalVolEth: round8(sum(signals, (e) => round8(e.stakeUsd / e.price))),
    },
    firstOrder: first ? { orderId: first.orderId, at: first.at } : null,
    lastOrder: last ? { orderId: last.orderId, at: last.at } : null,
    events,
  };
}

// ---------------------------------------------------------------- main

function readIncidentFile() {
  const names = fs
    .readdirSync(incidentDir)
    .filter((n) => /^votemax\.log(\.\d+)?$/.test(n))
    .sort();
  for (const n of names) {
    const full = path.join(incidentDir, n);
    const text = fs.readFileSync(full, 'utf8');
    if (text.includes(INCIDENT_MARKER)) return { name: n, text };
  }
  throw new Error(`no votemax.log* in ${incidentDir} contains "${INCIDENT_MARKER}"`);
}

function emit(records, stats) {
  const out = [];
  for (const rec of records) {
    const lines = sanitizeRecord(rec, stats);
    if (lines) out.push(...lines);
  }
  return `${out.join('\n')}\n`;
}

function writeOut(rel, content) {
  const full = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const SECRET_SCAN = [
  /webhooks\/[0-9]+\//,
  /eyJ[A-Za-z0-9_-]{10,}/,
  /token=/,
  /Authorization/,
  /password/i,
  /discord\.com\/api\/webhooks/,
  /urllib3/,
];

function assertClean(rel, content) {
  for (const re of SECRET_SCAN) {
    if (re.test(content)) throw new Error(`${rel}: output still matches ${re}`);
  }
}

function main() {
  const { name, text } = readIncidentFile();
  const all = parseRecords(text);
  const winMs = toMsWindows(INCIDENT_WINDOWS);

  // Incident excerpt: INFO+ only, windows applied per record (log lines are not strictly time-ordered).
  const kept = all.filter((r) => r.level !== 'DEBUG' && inWindows(r.at, winMs));
  const incStats = { droppedUrllib3: 0, redactedRecords: 0, redactedValues: 0 };
  const incidentLog = emit(kept, incStats);
  assertClean('logs/votemax-incident-2026-09-28.log', incidentLog);
  writeOut('logs/votemax-incident-2026-09-28.log', incidentLog);

  // Timeline from exactly the records written above. Events that the whole source file has outside
  // the windows are listed separately so nothing is silently lost (e.g. the 04:57 balance outage).
  const timeline = buildTimeline(kept, INCIDENT_WINDOWS, name);
  timeline.outsideWindowEvents = extractEvents(all.filter((r) => r.level !== 'DEBUG')).filter(
    (e) => !inWindows(e.at, winMs),
  );
  writeOut('incident/timeline.json', `${JSON.stringify(timeline, null, 1)}\n`);

  // Normal -vv excerpt from the live log (read-only), DEBUG included.
  const live = parseRecords(fs.readFileSync(liveLog, 'utf8'));
  const nw = toMsWindows([normalWindow])[0];
  const normal = live.filter((r) => r.at >= nw[0] && r.at < nw[1]);
  if (normal.length === 0) throw new Error(`live log has no records in ${normalWindow.join(' .. ')}`);
  const normStats = { droppedUrllib3: 0, redactedRecords: 0, redactedValues: 0 };
  const normalLog = emit(normal, normStats);
  assertClean('logs/votemax-normal-vv.log', normalLog);
  writeOut('logs/votemax-normal-vv.log', normalLog);

  const starts = timeline.events.filter((e) => e.type === 'startup').map((e) => e.at);
  const gaps = starts
    .slice(1)
    .map((t, i) => t - starts[i])
    .sort((a, b) => a - b);
  const summary = {
    sourceFile: name,
    incidentRecordsKept: kept.length,
    incidentBytes: Buffer.byteLength(incidentLog),
    incidentStats: incStats,
    normalRecordsKept: normal.length,
    normalBytes: Buffer.byteLength(normalLog),
    normalStats: normStats,
    counts: timeline.counts,
    outsideWindowEvents: timeline.outsideWindowEvents.map((e) => `${e.type}@${new Date(e.at).toISOString()}`),
    totals: timeline.totals,
    firstOrder: timeline.firstOrder,
    lastOrder: timeline.lastOrder,
    medianGapBetweenStartupsMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[(i += 1)];
  }
  return out;
}

main();

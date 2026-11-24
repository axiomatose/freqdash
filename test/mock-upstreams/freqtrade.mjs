// Freqtrade REST mock (`/<botId>/api/v1/*`), served from the real samples in test/fixtures/raw/freqtrade. Node built-ins only.
import crypto from 'node:crypto';
import { fixture, hasFixture } from './fixtures.mjs';
import { startupTsAt } from './scenarios.mjs';

/** Endpoints that answer without credentials, as on a real freqtrade API. */
export const PUBLIC_ENDPOINTS = ['ping'];
const SIMPLE = [
  'show_config',
  'status',
  'balance',
  'whitelist',
  'locks',
  'count',
  'profit',
  'performance',
  'sysinfo',
  'version',
];
export const ENDPOINTS = [...PUBLIC_ENDPOINTS, ...SIMPLE, 'health', 'trades', 'logs', 'plot_config', 'pair_candles'];

export const KRAKEN_TO_BOT_CURRENCY = { ZUSD: 'USD', XXBT: 'BTC', XETH: 'ETH' };

export function checkBasicAuth(header, bot) {
  if (typeof header !== 'string' || !/^Basic /i.test(header)) return false;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  // Hash both sides so the comparison has a fixed length.
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  const userOk = crypto.timingSafeEqual(digest(decoded.slice(0, colon)), digest(bot.username));
  const passOk = crypto.timingSafeEqual(digest(decoded.slice(colon + 1)), digest(bot.password));
  return userOk && passOk;
}

const isoMicros = (sec) => new Date(sec * 1000).toISOString().replace(/\.000Z$/, '.000000Z');

function health(botId, world) {
  const h = fixture(`freqtrade/${botId}_health.json`);
  const lastProcess = Math.floor(world.now / 5000) * 5;
  h.last_process_ts = lastProcess;
  h.last_process = isoMicros(lastProcess);
  const { scenario, now } = world;
  if (scenario.name === 'incident' && botId === 'votemax') {
    h.bot_startup_ts = startupTsAt(scenario.plan, now, h.bot_startup_ts);
    h.bot_startup = isoMicros(h.bot_startup_ts);
  }
  return h;
}

function trades(botId, query) {
  const all = fixture(`freqtrade/${botId}_trades.json`).trades;
  const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '500', 10) || 500, 1), 500);
  const offset = Math.max(Number.parseInt(query.get('offset') ?? '0', 10) || 0, 0);
  const slice = all.slice(offset, offset + limit);
  // `total_trades` is the number of trades this mock holds, so a paginating client terminates cleanly.
  return { trades: slice, trades_count: slice.length, offset, total_trades: all.length };
}

const logTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function logs(botId, query, logRecords) {
  const limit = Number.parseInt(query.get('limit') ?? '', 10);
  const records = logRecords(botId, Number.isFinite(limit) && limit > 0 ? limit : undefined);
  return { log_count: records.length, logs: records.map((r) => [logTime(r.t), r.t, r.logger, r.level, r.message]) };
}

const LINE = (color) => ({ color, type: 'line' });

function plotConfig(botId) {
  const strategy = fixture(`freqtrade/${botId}_show_config.json`).strategy;
  if (strategy === 'VoteMaxMulti') {
    return {
      main_plot: {
        ema20: LINE('#f0b429'),
        ema50: LINE('#7b61ff'),
        support_4h: LINE('#2fb344'),
        resistance_4h: LINE('#d63939'),
        support_1d_1d: LINE('#5eba7d'),
        resistance_1d_1d: LINE('#e57373'),
        support_1w_1w: LINE('#8bc34a'),
        resistance_1w_1w: LINE('#ff8a65'),
        support_1m_1w: LINE('#a5d6a7'),
        resistance_1m_1w: LINE('#ffab91'),
      },
      subplots: {
        RSI: { rsi: LINE('#4dabf7'), rsi_ob: LINE('#d63939'), rsi_os: LINE('#2fb344') },
        Score: {
          entry_score: LINE('#2fb344'),
          exit_score: LINE('#d63939'),
          vote_threshold: LINE('#adb5bd'),
          support_threshold: LINE('#868e96'),
          exit_threshold: LINE('#ced4da'),
        },
        Touches: { touch_sup: LINE('#2fb344'), touch_res: LINE('#d63939'), touch_threshold: LINE('#adb5bd') },
      },
    };
  }
  return {
    main_plot: { ema20: LINE('#f0b429'), ema50: LINE('#7b61ff') },
    subplots: { RSI: { rsi: LINE('#4dabf7'), rsi_ob: LINE('#d63939'), rsi_os: LINE('#2fb344') } },
  };
}

function pairCandles(botId, query) {
  const pair = query.get('pair');
  const timeframe = query.get('timeframe');
  if (!pair || !timeframe) return { status: 422, body: { detail: 'pair and timeframe are required' } };
  const whitelist = fixture(`freqtrade/${botId}_whitelist.json`).whitelist;
  if (!whitelist.includes(pair)) return { status: 404, body: { detail: `Pair ${pair} is not in the whitelist` } };
  const base = pair.split('/')[0];
  const rel = `freqtrade/${botId}_pair_candles_${base}_${timeframe}.json`;
  // Only the strategy timeframe is served; anything else has no analyzed dataframe (`length` 0), as on the real bot.
  const body = hasFixture(rel)
    ? fixture(rel)
    : { ...fixture(`freqtrade/${botId}_pair_candles_${base}_4h.json`), timeframe, data: [] };
  const limit = Number.parseInt(query.get('limit') ?? '', 10);
  if (Number.isFinite(limit) && limit > 0) body.data = body.data.slice(-limit);
  body.length = body.data.length;
  return { status: 200, body };
}

/** The dca bot's wallet follows the Kraken account during the incident; the crash-looping votemax bot keeps a stale one. */
function balance(botId, world, krakenRows) {
  const body = fixture(`freqtrade/${botId}_balance.json`);
  if (world.scenario.name !== 'incident' || botId !== 'dca') return body;
  const price = { XETH: Number(fixture('kraken/public/Ticker.json').result.XETHZUSD.c[0]) };
  for (const row of krakenRows) {
    const cur = body.currencies.find((c) => c.currency === (KRAKEN_TO_BOT_CURRENCY[row.asset] ?? row.asset));
    if (!cur || (row.asset !== 'ZUSD' && row.asset !== 'XETH')) continue;
    cur.balance = row.balance;
    cur.used = row.hold;
    cur.free = row.balance - row.hold;
    cur.est_stake = row.balance * (price[row.asset] ?? 1);
  }
  body.total = body.currencies.reduce((sum, c) => sum + c.est_stake, 0);
  return body;
}

/**
 * Body for one endpoint. `deps` = {logRecords(botId, limit), krakenRows()}. Returns {status, body}.
 */
export function freqtradeResponse(botId, endpoint, query, world, deps) {
  if (!hasFixture(`freqtrade/${botId}_show_config.json`)) return { status: 404, body: { detail: 'Not Found' } };
  switch (endpoint) {
    case 'ping':
      return { status: 200, body: { status: 'pong' } };
    case 'health':
      return { status: 200, body: health(botId, world) };
    case 'trades':
      return { status: 200, body: trades(botId, query) };
    case 'logs':
      return { status: 200, body: logs(botId, query, deps.logRecords) };
    case 'plot_config':
      return { status: 200, body: plotConfig(botId) };
    case 'pair_candles':
      return pairCandles(botId, query);
    case 'balance':
      return { status: 200, body: balance(botId, world, world.scenario.name === 'incident' ? deps.krakenRows() : []) };
    default:
      return SIMPLE.includes(endpoint) && hasFixture(`freqtrade/${botId}_${endpoint}.json`)
        ? { status: 200, body: fixture(`freqtrade/${botId}_${endpoint}.json`) }
        : { status: 404, body: { detail: 'Not Found' } };
  }
}

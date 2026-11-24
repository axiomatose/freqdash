// Kraken REST mock: public endpoints, private endpoints and request authentication. Node built-ins only.
// The signature algorithm is implemented here from Kraken's published description, independently of the app's client:
//   API-Sign = base64( HMAC-SHA512( key = base64decode(secret), msg = path + SHA256(nonce + postdata) ) )
import crypto from 'node:crypto';
import { fixture, hasFixture } from './fixtures.mjs';

/** The only private methods the app may call (read-only). Anything else is recorded as a violation. */
export const PRIVATE_ALLOWLIST = [
  'Balance',
  'BalanceEx',
  'OpenOrders',
  'ClosedOrders',
  'QueryOrders',
  'TradeVolume',
  'Ledgers',
];
// Kraken returns 50 closed orders per page; MOCK_CLOSED_ORDERS_PAGE lowers it so tests can exercise several pages.
const pageOverride = Number.parseInt(process.env.MOCK_CLOSED_ORDERS_PAGE ?? '', 10);
export const CLOSED_ORDERS_PAGE = pageOverride > 0 ? pageOverride : 50;

const ok = (result) => ({ status: 200, body: { error: [], result } });
const publicFail = (message, status = 200) => ({ status, body: { error: [message] } });
const privateFail = (message, status = 200) => ({ status, body: { error: [message], result: {} } });

export function krakenSign(path, nonce, body, secretB64) {
  const digest = crypto.createHash('sha256').update(String(nonce)).update(body).digest();
  return crypto
    .createHmac('sha512', Buffer.from(secretB64, 'base64'))
    .update(Buffer.concat([Buffer.from(path, 'utf8'), digest]))
    .digest('base64');
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function parseParams(body, contentType) {
  const text = body.toString('utf8');
  try {
    if (/json/i.test(contentType ?? '')) {
      const parsed = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    }
    return Object.fromEntries(new URLSearchParams(text));
  } catch {
    return {};
  }
}

/**
 * Checks key, signature and nonce of a private request, in that order. `nonces` maps API key to the last accepted nonce
 * (BigInt) and is updated on success only. Returns {ok:true, params} or {ok:false, error}.
 */
export function authenticatePrivate({ path, headers, body }, { key, secret, nonces }) {
  const params = parseParams(body, headers['content-type']);
  if (headers['api-key'] !== key) return { ok: false, error: 'EAPI:Invalid key' };
  const nonceText = params.nonce === undefined ? '' : String(params.nonce);
  const signature = headers['api-sign'];
  if (typeof signature !== 'string' || !safeEqual(signature, krakenSign(path, nonceText, body, secret))) {
    return { ok: false, error: 'EAPI:Invalid signature' };
  }
  if (!/^\d{1,20}$/.test(nonceText)) return { ok: false, error: 'EAPI:Invalid nonce' };
  const nonce = BigInt(nonceText);
  if (nonce <= (nonces.get(key) ?? 0n)) return { ok: false, error: 'EAPI:Invalid nonce' };
  nonces.set(key, nonce);
  return { ok: true, params };
}

// ------------------------------------------------------------------------------------------ public endpoints

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

function rfc1123(ms) {
  const d = new Date(ms);
  const date = `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCFullYear() % 100)}`;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

function pairKey(pairs, name) {
  const wanted = String(name).toUpperCase();
  for (const [key, p] of Object.entries(pairs)) {
    if ([key, p.altname, p.wsname].some((v) => typeof v === 'string' && v.toUpperCase() === wanted)) return key;
  }
  return null;
}

function requestedPairs(pairs, list) {
  const keys = [];
  for (const name of String(list).split(',').filter(Boolean)) {
    const key = pairKey(pairs, name);
    if (!key) return null;
    keys.push(key);
  }
  return keys.length > 0 ? keys : null;
}

export function publicResponse(method, params, world) {
  switch (method) {
    case 'Time': {
      return ok({ unixtime: Math.floor(world.now / 1000), rfc1123: rfc1123(world.now) });
    }
    case 'Assets':
      return ok(fixture('kraken/public/Assets.json').result);
    case 'AssetPairs': {
      const all = fixture('kraken/public/AssetPairs.json').result;
      if (!params.pair) return ok(all);
      const keys = requestedPairs(all, params.pair);
      return keys ? ok(Object.fromEntries(keys.map((k) => [k, all[k]]))) : publicFail('EQuery:Unknown asset pair');
    }
    case 'Ticker': {
      if (!params.pair) return publicFail('EGeneral:Invalid arguments');
      const pairs = fixture('kraken/public/AssetPairs.json').result;
      const ticker = fixture('kraken/public/Ticker.json').result;
      const keys = requestedPairs(pairs, params.pair);
      if (!keys || keys.some((k) => !(k in ticker))) return publicFail('EQuery:Unknown asset pair');
      return ok(Object.fromEntries(keys.map((k) => [k, ticker[k]])));
    }
    case 'OHLC': {
      if (!params.pair) return publicFail('EGeneral:Invalid arguments');
      const pairs = fixture('kraken/public/AssetPairs.json').result;
      const key = pairKey(pairs, params.pair);
      if (!key) return publicFail('EQuery:Unknown asset pair');
      const interval = Number.parseInt(params.interval ?? '1', 10);
      const rel = `kraken/public/OHLC.${pairs[key].altname}.${interval}.json`;
      if (!Number.isInteger(interval) || !hasFixture(rel)) return publicFail('EGeneral:Invalid arguments:interval');
      const raw = fixture(rel).result;
      const since = params.since === undefined ? null : Number(params.since);
      const rows = Object.keys(raw).find((k) => k !== 'last');
      const result = { ...raw };
      if (rows && since !== null && Number.isFinite(since)) result[rows] = raw[rows].filter((row) => row[0] > since);
      return ok(result);
    }
    default:
      return publicFail('EGeneral:Unknown method', 404);
  }
}

// ------------------------------------------------------------------------------------------ orders

const zeroLike = (s) => String(s).replace(/[1-9]/g, '0');

function closedForm(rec, openT, closeT) {
  return { ...rec, opentm: openT / 1000, closetm: closeT / 1000 };
}

function openForm(rec, openT) {
  return {
    refid: null,
    userref: rec.userref,
    status: 'open',
    opentm: openT / 1000,
    starttm: 0,
    expiretm: 0,
    descr: rec.descr,
    vol: rec.vol,
    vol_exec: zeroLike(rec.vol_exec),
    cost: '0.00000',
    fee: '0.00000',
    price: '0.00000',
    stopprice: '0.00000',
    limitprice: '0.00000',
    misc: '',
    oflags: rec.oflags,
  };
}

/** Orders as Kraken shows them at `world.now`: {open: [{txid, order}], closed: [{txid, order}]}, closed newest first. */
export function ordersAt(world) {
  const { scenario, now } = world;
  let closed;
  const open = [];
  if (scenario.name === 'incident') {
    const plan = scenario.plan;
    closed = plan.staticClosed.map(([txid, order]) => ({ txid, order }));
    for (const o of plan.orders) {
      if (o.closeT <= now) closed.push({ txid: o.txid, order: closedForm(o.rec, o.openT, o.closeT) });
      else if (o.openT <= now) open.push({ txid: o.txid, order: openForm(o.rec, o.openT) });
    }
  } else {
    closed = Object.entries(fixture('kraken/private/ClosedOrders.normal.json').result.closed).map(([txid, order]) => ({
      txid,
      order,
    }));
  }
  closed.sort((a, b) => b.order.closetm - a.order.closetm || a.txid.localeCompare(b.txid));
  open.sort((a, b) => b.order.opentm - a.order.opentm || a.txid.localeCompare(b.txid));
  return { open, closed };
}

function timeBound(value, all) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const hit = all.find((o) => o.txid === value);
  return hit ? hit.order.closetm : null;
}

function closedOrdersResult(params, world) {
  const { closed } = ordersAt(world);
  const start = timeBound(params.start, closed);
  const end = timeBound(params.end, closed);
  const mode = ['open', 'close', 'both'].includes(params.closetime) ? params.closetime : 'both';
  const inRange = (t) => (start === null || t > start) && (end === null || t <= end);
  const matches = closed.filter(({ order }) => {
    if (mode === 'open') return inRange(order.opentm);
    if (mode === 'close') return inRange(order.closetm);
    return inRange(order.opentm) || inRange(order.closetm);
  });
  const ofs = Math.max(0, Number.parseInt(params.ofs ?? '0', 10) || 0);
  const page = matches.slice(ofs, ofs + CLOSED_ORDERS_PAGE);
  return ok({ closed: Object.fromEntries(page.map(({ txid, order }) => [txid, order])), count: matches.length });
}

function queryOrdersResult(params, world) {
  const ids = String(params.txid ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0 || ids.length > 50) return privateFail('EGeneral:Invalid arguments');
  const { open, closed } = ordersAt(world);
  const found = {};
  for (const id of ids) {
    const hit = open.find((o) => o.txid === id) ?? closed.find((o) => o.txid === id);
    if (hit) found[id] = hit.order;
  }
  return Object.keys(found).length > 0 ? ok(found) : privateFail('EOrder:Unknown order');
}

// ------------------------------------------------------------------------------------------ account

const decimalsOf = (s) => (String(s).includes('.') ? String(s).length - String(s).indexOf('.') - 1 : 0);

/**
 * Kraken balances at `world.now` as [{asset, balance, hold, decimals}] plus the BalanceEx entry shape.
 * Outside the incident they mirror the bots' wallet fixture, so the account agrees with both bots. During the incident
 * they run from BalanceEx.before to BalanceEx.after (plus the bot's open BTC position) as the orders fill.
 */
export function krakenAccount(world) {
  const { scenario, now } = world;
  const ex = fixture('kraken/private/BalanceEx.json').result;
  const wallet = fixture('freqtrade/votemax_balance.json').currencies;
  const botQty = (currency) => Number(wallet.find((c) => c.currency === currency)?.balance ?? 0);
  const botCurrency = { ZUSD: 'USD', XXBT: 'BTC', XETH: 'ETH' };
  const rows = [];
  if (scenario.name !== 'incident') {
    for (const [asset, entry] of Object.entries(ex)) {
      rows.push({ asset, balance: botQty(botCurrency[asset] ?? asset), hold: 0, decimals: decimalsOf(entry.balance) });
    }
    return { rows, shape: 'full' };
  }
  const before = fixture('kraken/private/BalanceEx.before.json').result;
  const after = fixture('kraken/private/BalanceEx.after.json').result;
  const { orders } = scenario.plan;
  const settled = orders.filter((o) => o.closeT <= now);
  const allDone = settled.length === orders.length;
  const pending = orders.filter((o) => o.openT <= now && now < o.closeT);
  for (const [asset, entry] of Object.entries(ex)) {
    const decimals = decimalsOf(entry.balance);
    let balance;
    if (asset === 'XXBT') balance = botQty('BTC');
    else if (allDone) balance = Number(after[asset]?.balance ?? 0);
    else {
      balance = Number(before[asset]?.balance ?? 0);
      if (asset === 'ZUSD') balance -= settled.reduce((s, o) => s + Number(o.rec.cost) + Number(o.rec.fee), 0);
      if (asset === 'XETH') balance += settled.reduce((s, o) => s + Number(o.rec.vol_exec), 0);
    }
    const hold = asset === 'ZUSD' ? pending.reduce((s, o) => s + Number(o.rec.descr.price) * Number(o.rec.vol), 0) : 0;
    rows.push({ asset, balance, hold, decimals });
  }
  return { rows, shape: 'basic' };
}

// ------------------------------------------------------------------------------------------ private endpoints

export function privateResponse(method, params, world) {
  switch (method) {
    case 'Balance': {
      const { rows } = krakenAccount(world);
      return ok(Object.fromEntries(rows.map((r) => [r.asset, r.balance.toFixed(r.decimals)])));
    }
    case 'BalanceEx': {
      const { rows, shape } = krakenAccount(world);
      const entry = (r) => {
        const zero = (0).toFixed(r.decimals);
        const base = { balance: r.balance.toFixed(r.decimals) };
        const hold = { hold_trade: r.hold.toFixed(r.decimals) };
        return shape === 'full' ? { ...base, credit: zero, credit_used: zero, ...hold } : { ...base, ...hold };
      };
      return ok(Object.fromEntries(rows.map((r) => [r.asset, entry(r)])));
    }
    case 'OpenOrders':
      return ok({ open: Object.fromEntries(ordersAt(world).open.map(({ txid, order }) => [txid, order])) });
    case 'ClosedOrders':
      return closedOrdersResult(params, world);
    case 'QueryOrders':
      return queryOrdersResult(params, world);
    case 'TradeVolume':
      return ok(fixture('kraken/private/TradeVolume.json').result);
    case 'Ledgers':
      return ok({ ledger: {}, count: 0 });
    default:
      return privateFail('EGeneral:Permission denied');
  }
}

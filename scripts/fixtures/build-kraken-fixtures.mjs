#!/usr/bin/env node
// Builds the SYNTHETIC Kraken private-endpoint fixtures (no key, no network). Plain Node ESM, no dependencies.
//
//   node scripts/fixtures/build-kraken-fixtures.mjs [--raw DIR]
//
// Inputs (all under --raw, default <repo>/test/fixtures/raw):
//   freqtrade/{votemax,dca}_{trades,status}.json   real bot samples
//   incident/timeline.json                         from extract-incident.mjs
//   kraken/public/{Assets,AssetPairs}.json         real captures (decimals); built-in fallbacks if absent
// Outputs: kraken/private/*.json and kraken/errors/*.json.
//
// Shapes follow the real Kraken REST API: every number is a decimal STRING, opentm/closetm are float epoch
// seconds, descr.pair is the altname (XBTUSD, ETHUSD), fees are quoted in USD (oflags fciq).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const rawIdx = argv.indexOf('--raw');
const RAW = rawIdx >= 0 ? argv[rawIdx + 1] : path.join(REPO, 'test', 'fixtures', 'raw');

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(RAW, rel), 'utf8'));
const tryReadJson = (rel) => (fs.existsSync(path.join(RAW, rel)) ? readJson(rel) : null);
const writeJson = (rel, obj) => {
  const full = path.join(RAW, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${JSON.stringify(obj, null, 1)}\n`);
};

// ---------------------------------------------------------------- pair / asset specs

const FALLBACK_PAIRS = {
  XBTUSD: { pair_decimals: 1, lot_decimals: 8, cost_decimals: 5 },
  ETHUSD: { pair_decimals: 2, lot_decimals: 8, cost_decimals: 5 },
  SHIBUSD: { pair_decimals: 9, lot_decimals: 5, cost_decimals: 5 },
  BABYUSD: { pair_decimals: 5, lot_decimals: 5, cost_decimals: 5 },
};
const FALLBACK_ASSET_DECIMALS = { ZUSD: 4, XXBT: 10, XETH: 10, SHIB: 5, BABY: 5 };

const assetPairsRaw = tryReadJson('kraken/public/AssetPairs.json');
const assetsRaw = tryReadJson('kraken/public/Assets.json');
const PAIRS = { ...FALLBACK_PAIRS };
if (assetPairsRaw) {
  for (const p of Object.values(assetPairsRaw.result)) {
    PAIRS[p.altname] = { pair_decimals: p.pair_decimals, lot_decimals: p.lot_decimals, cost_decimals: p.cost_decimals };
  }
}
const ASSET_DECIMALS = { ...FALLBACK_ASSET_DECIMALS };
if (assetsRaw) for (const [k, v] of Object.entries(assetsRaw.result)) ASSET_DECIMALS[k] = v.decimals;

/** 'ETH/USD' -> 'ETHUSD', 'BTC/USD' -> 'XBTUSD' (Kraken altname). */
const altname = (pair) => {
  const [base, quote] = pair.split('/');
  return `${base === 'BTC' ? 'XBT' : base}${quote}`;
};
const secs = (ms) => Number((ms / 1000).toFixed(4));
const EPS = 1e-9;

// ---------------------------------------------------------------- order builder

function krakenOrder(o) {
  const spec = PAIRS[o.pairAlt];
  if (!spec) throw new Error(`no pair spec for ${o.pairAlt}`);
  const volStr = o.vol.toFixed(spec.lot_decimals);
  const execStr = o.volExec.toFixed(spec.lot_decimals);
  const limitStr = o.limitPrice.toFixed(spec.pair_decimals);
  const filled = o.volExec > 0;
  const avgStr = filled ? o.avgPrice.toFixed(spec.pair_decimals) : '0.00000';
  const costStr = filled ? (o.volExec * o.avgPrice).toFixed(spec.cost_decimals) : '0.00000';
  const feeStr = filled ? (Number(costStr) * o.feeRate).toFixed(spec.cost_decimals) : '0.00000';
  return {
    refid: null,
    userref: 0,
    status: o.status,
    reason: o.reason ?? null,
    opentm: secs(o.openMs),
    closetm: secs(o.closeMs),
    starttm: 0,
    expiretm: 0,
    descr: {
      pair: o.pairAlt,
      type: o.side,
      ordertype: 'limit',
      price: limitStr,
      price2: '0',
      leverage: 'none',
      order: `${o.side} ${volStr} ${o.pairAlt} @ limit ${limitStr}`,
      close: '',
    },
    vol: volStr,
    vol_exec: execStr,
    cost: costStr,
    fee: feeStr,
    price: avgStr,
    stopprice: '0.00000',
    limitprice: '0.00000',
    misc: '',
    oflags: 'fciq',
  };
}

function closedOrdersResponse(orders) {
  const entries = Object.entries(orders).sort((a, b) => b[1].closetm - a[1].closetm);
  return { error: [], result: { closed: Object.fromEntries(entries), count: entries.length } };
}

// ---------------------------------------------------------------- sample bot orders -> Kraken orders

function botSampleOrders() {
  const out = {};
  const skippedOpen = [];
  for (const bot of ['votemax', 'dca']) {
    const trades = [...readJson(`freqtrade/${bot}_trades.json`).trades, ...readJson(`freqtrade/${bot}_status.json`)];
    for (const t of trades) {
      for (const o of t.orders) {
        const entry = o.ft_is_entry ?? o.ft_order_side === 'buy';
        const feeRate = entry ? t.fee_open : t.fee_close;
        const status = { closed: 'closed', canceled: 'canceled', expired: 'expired' }[o.status];
        if (!status) {
          skippedOpen.push(o.order_id);
          continue;
        }
        const openMs = o.order_timestamp;
        out[o.order_id] = krakenOrder({
          pairAlt: altname(o.pair ?? t.pair),
          side: o.ft_order_side,
          vol: o.amount,
          volExec: o.filled,
          limitPrice: o.price ?? o.safe_price,
          avgPrice: o.safe_price,
          feeRate,
          openMs,
          closeMs: o.order_filled_timestamp ?? openMs,
          status,
          reason: status === 'closed' ? null : 'User requested',
        });
      }
    }
  }
  return { orders: out, skippedOpen };
}

// ---------------------------------------------------------------- incident orders

const TAKER = 0.004;
/** 0.1130240889 (dca wallet) minus 8.9e-9 (votemax wallet dust) = 0.11302408, in 1e-8 units. */
const TARGET_ETH_UNITS = 11302408;

function incidentOrders(timeline) {
  const orders = {};
  let sumUnits = 0;
  for (const e of timeline.events) {
    if (e.type !== 'order_created') continue;
    const units = Math.round((e.stakeUsd / e.price) * 1e8);
    sumUnits += units;
    orders[e.orderId] = krakenOrder({
      pairAlt: 'ETHUSD',
      side: 'buy',
      vol: units / 1e8,
      volExec: units / 1e8,
      limitPrice: e.price,
      avgPrice: e.price,
      feeRate: TAKER,
      openMs: e.at,
      closeMs: e.at + 30000,
      status: 'closed',
    });
  }
  // The Kraken-only order: no log line exists for it, its volume closes the gap to the wallet.
  const synthUnits = TARGET_ETH_UNITS - sumUnits;
  if (synthUnits <= 0) throw new Error(`incident orders already exceed the wallet: ${sumUnits}`);
  const synthOpen = Date.parse('2026-09-28T04:03:36.250Z');
  orders['OWDY2Z-TVWRN-IJBALL'] = krakenOrder({
    pairAlt: 'ETHUSD',
    side: 'buy',
    vol: synthUnits / 1e8,
    volExec: synthUnits / 1e8,
    limitPrice: 2647.4,
    avgPrice: 2647.4,
    feeRate: TAKER,
    openMs: synthOpen,
    closeMs: synthOpen + 30000,
    status: 'closed',
  });
  // Manual SHIB purchase (to be acknowledged by the user); after the first bot trade so it is inside the recon range.
  const shibOpen = Date.parse('2026-06-15T13:05:41.238Z');
  orders['OYYVFI-FJISQ-5N6DW5'] = krakenOrder({
    pairAlt: 'SHIBUSD',
    side: 'buy',
    vol: 1901628.18,
    volExec: 1901628.18,
    limitPrice: 0.00000585,
    avgPrice: 0.00000585,
    feeRate: TAKER,
    openMs: shibOpen,
    closeMs: shibOpen + 12000,
    status: 'closed',
  });
  // Zero-fill canceled order (bot-style 10 minute entry timeout the day before the incident).
  const cancelOpen = Date.parse('2026-09-27T12:00:07.510Z');
  orders['O5GCGD-X5FJN-JFUFDO'] = krakenOrder({
    pairAlt: 'ETHUSD',
    side: 'buy',
    vol: 0.005,
    volExec: 0,
    limitPrice: 2645.1,
    avgPrice: 0,
    feeRate: TAKER,
    openMs: cancelOpen,
    closeMs: cancelOpen + 600710,
    status: 'canceled',
    reason: 'User requested',
  });
  return { orders, sumUnits, synthUnits };
}

// ---------------------------------------------------------------- balances

const fmtAsset = (asset, x) => x.toFixed(ASSET_DECIMALS[asset] ?? 10);

function balanceExSimple(map) {
  return {
    error: [],
    result: Object.fromEntries(
      Object.entries(map).map(([a, { balance, hold = 0 }]) => [
        a,
        { balance: fmtAsset(a, balance), hold_trade: fmtAsset(a, hold) },
      ]),
    ),
  };
}

function balanceExFull(map) {
  return {
    error: [],
    result: Object.fromEntries(
      Object.entries(map).map(([a, { balance, hold = 0 }]) => [
        a,
        {
          balance: fmtAsset(a, balance),
          credit: fmtAsset(a, 0),
          credit_used: fmtAsset(a, 0),
          hold_trade: fmtAsset(a, hold),
        },
      ]),
    ),
  };
}

function balanceLegacy(map) {
  return {
    error: [],
    result: Object.fromEntries(Object.entries(map).map(([a, { balance }]) => [a, fmtAsset(a, balance)])),
  };
}

// ---------------------------------------------------------------- main

function main() {
  const timeline = readJson('incident/timeline.json');
  const dcaBalance = readJson('freqtrade/dca_balance.json');
  const btcTrade = readJson('freqtrade/votemax_status.json').find((t) => t.pair === 'BTC/USD' && t.is_open);
  if (!btcTrade) throw new Error('votemax_status.json has no open BTC/USD trade');

  // ---- orders
  const sample = botSampleOrders();
  const inc = incidentOrders(timeline);
  writeJson('kraken/private/ClosedOrders.normal.json', closedOrdersResponse(sample.orders));
  writeJson('kraken/private/ClosedOrders.incident.json', closedOrdersResponse({ ...sample.orders, ...inc.orders }));
  writeJson('kraken/private/OpenOrders.empty.json', { error: [], result: { open: {} } });

  // ---- balances. After-incident USD is anchored on the dca bot's wallet (total minus priced holdings);
  // before-incident USD adds back everything the 26 incident orders cost (cost + fee).
  const cur = Object.fromEntries(dcaBalance.currencies.map((c) => [c.currency, c]));
  const usdAfter = Number((dcaBalance.total - dcaBalance.currencies.reduce((a, c) => a + c.est_stake, 0)).toFixed(4));
  const spent = Object.values(inc.orders)
    .filter((o) => o.descr.pair === 'ETHUSD' && o.opentm >= Date.parse('2026-09-28T00:00:00Z') / 1000)
    .reduce((a, o) => a + Number(o.cost) + Number(o.fee), 0);
  const usdBefore = Number((usdAfter + spent).toFixed(4));
  const ethAfter = cur.ETH.balance; // 0.1130240889
  const ethBefore = 8.9e-9;
  const shib = cur.SHIB.balance;
  const baby = cur.BABY.balance;
  writeJson(
    'kraken/private/BalanceEx.before.json',
    balanceExSimple({
      ZUSD: { balance: usdBefore },
      XETH: { balance: ethBefore },
      SHIB: { balance: shib },
      BABY: { balance: baby },
    }),
  );
  writeJson(
    'kraken/private/BalanceEx.after.json',
    balanceExSimple({
      ZUSD: { balance: usdAfter },
      XETH: { balance: ethAfter },
      SHIB: { balance: shib },
      BABY: { balance: baby },
    }),
  );

  const usdNow = Number((usdAfter - btcTrade.open_trade_value).toFixed(4));
  const current = {
    ZUSD: { balance: usdNow },
    XXBT: { balance: btcTrade.amount },
    XETH: { balance: ethAfter },
    SHIB: { balance: shib },
    BABY: { balance: baby },
  };
  writeJson('kraken/private/BalanceEx.json', balanceExFull(current));
  writeJson('kraken/private/Balance.json', balanceLegacy(current));

  // Wallet-suffix and hold variants for the normalizer / asset catalog (values are arbitrary).
  writeJson(
    'kraken/private/BalanceEx.wallets.json',
    balanceExFull({
      ZUSD: { balance: 250.1234, hold: 20 },
      XXBT: { balance: 0.00046744 },
      'XBT.F': { balance: 0.001 },
      'DOT.S': { balance: 12.5 },
      'USD.HOLD': { balance: 5 },
    }),
  );

  // ---- fees
  const fee = (taker, maker, tier, nextTaker, nextMaker) => ({
    fee: {
      fee: taker,
      minfee: '0.1000',
      maxfee: '0.4000',
      nextfee: nextTaker,
      tiervolume: '0.0000',
      nextvolume: '10000.0000',
    },
    maker: {
      fee: maker,
      minfee: '0.0000',
      maxfee: '0.2500',
      nextfee: nextMaker,
      tiervolume: '0.0000',
      nextvolume: '10000.0000',
    },
    tier,
  });
  const btcFee = fee('0.4000', '0.2500', 0, '0.3500', '0.2000');
  writeJson('kraken/private/TradeVolume.json', {
    error: [],
    result: {
      currency: 'ZUSD',
      volume: '612.1234',
      fees: { XXBTZUSD: btcFee.fee, XETHZUSD: btcFee.fee },
      fees_maker: { XXBTZUSD: btcFee.maker, XETHZUSD: btcFee.maker },
    },
  });

  // ---- errors (HTTP 200 with an error array, as Kraken sends them)
  const errors = {
    invalid_key: 'EAPI:Invalid key',
    invalid_signature: 'EAPI:Invalid signature',
    permission_denied: 'EGeneral:Permission denied',
    rate_limit: 'EAPI:Rate limit exceeded',
    throttled: 'EService:Throttled',
    invalid_nonce: 'EAPI:Invalid nonce',
    unavailable: 'EService:Unavailable',
  };
  for (const [name, msg] of Object.entries(errors)) writeJson(`kraken/errors/${name}.json`, { error: [msg] });

  const incEth = Object.values(inc.orders).filter(
    (o) => o.descr.pair === 'ETHUSD' && o.opentm >= Date.parse('2026-09-28T00:00:00Z') / 1000,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        sampleOrders: Object.keys(sample.orders).length,
        skippedOpenSampleOrders: sample.skippedOpen,
        incidentOrdersTotal: Object.keys(inc.orders).length,
        incidentEthOrders: incEth.length,
        loggedVolUnits: inc.sumUnits,
        loggedVolEth: inc.sumUnits / 1e8,
        synthVolEth: inc.synthUnits / 1e8,
        sumVolEth: (inc.sumUnits + inc.synthUnits) / 1e8,
        usdBefore,
        usdAfter,
        usdNow,
        incidentCostUsd: Number(incEth.reduce((a, o) => a + Number(o.cost), 0).toFixed(5)),
        incidentFeeUsd: Number(incEth.reduce((a, o) => a + Number(o.fee), 0).toFixed(5)),
      },
      null,
      1,
    )}\n`,
  );
  if (Math.abs((inc.sumUnits + inc.synthUnits) / 1e8 - (ethAfter - ethBefore)) > 1e-8 + EPS) {
    throw new Error('incident volume does not reconcile with the wallet');
  }
}

main();

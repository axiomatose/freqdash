import { describe, expect, it } from 'vitest';
import rawAssets from '../../../test/fixtures/raw/kraken/public/Assets.json';
import rawPairs from '../../../test/fixtures/raw/kraken/public/AssetPairs.json';
import { buildAssetCatalog } from './assets';
import { KrakenError } from './errors';
import { createNonceSource } from './nonce';
import { KrakenPrivateClient } from './private';
import { KrakenRateLimiter } from './ratelimit';
import { queryOrdersByTxid, syncClosedOrders, syncLedgerEntries } from './sync';
import type { KrakenCaller, KrakenFetch, KrakenParams, KrakenPrivateMethod } from './types';

const catalog = buildAssetCatalog(rawAssets, rawPairs);
const T0 = 1_790_000_000;

interface RawOrder {
  status: string;
  opentm: number;
  closetm: number;
  descr: { pair: string; type: string; ordertype: string; price: string };
  vol: string;
  vol_exec: string;
  cost: string;
  fee: string;
  price: string;
}

/** Order `i` closed at `T0 + 100 * i` seconds. */
function rawOrder(i: number): [string, RawOrder] {
  const closetm = T0 + 100 * i;
  return [
    `OTEST${String(i).padStart(2, '0')}-AAAAA-${String(i).padStart(6, '0')}`,
    {
      status: 'closed',
      opentm: closetm - 10.5,
      closetm,
      descr: { pair: 'XBTUSD', type: 'buy', ordertype: 'limit', price: '80000.0' },
      vol: '0.001',
      vol_exec: '0.001',
      cost: '80.00000',
      fee: '0.32000',
      price: '80000.0',
    },
  ];
}

function rawEntry(i: number): [string, Record<string, unknown>] {
  return [
    `L${String(i).padStart(4, '0')}`,
    { refid: `R${i}`, time: T0 + i, type: 'deposit', asset: 'ZUSD', amount: '10.0', fee: '0' },
  ];
}

interface Call {
  method: KrakenPrivateMethod;
  params: KrakenParams;
}

/** A private client double that pages like Kraken: newest first, 50 per page, `count` = all matches. */
function fakeKraken(options: { orders?: number; ledger?: number; onCall?: (index: number) => void } = {}) {
  const orders = new Map<string, RawOrder>(Array.from({ length: options.orders ?? 0 }, (_, i) => rawOrder(i + 1)));
  const ledger = new Map<string, Record<string, unknown>>(
    Array.from({ length: options.ledger ?? 0 }, (_, i) => rawEntry(i + 1)),
  );
  const calls: Call[] = [];
  const client: KrakenCaller = {
    call: async (method, params = {}) => {
      calls.push({ method, params });
      options.onCall?.(calls.length);
      const start = Number(params.start ?? 0);
      const ofs = Number(params.ofs ?? 0);
      if (method === 'ClosedOrders') {
        const matching = [...orders.entries()]
          .filter(([, o]) => o.closetm > start)
          .sort((a, b) => b[1].closetm - a[1].closetm);
        return { closed: Object.fromEntries(matching.slice(ofs, ofs + 50)), count: matching.length };
      }
      if (method === 'Ledgers') {
        const matching = [...ledger.entries()]
          .filter(([, e]) => (e.time as number) > start && (params.type === undefined || e.type === params.type))
          .sort((a, b) => (b[1].time as number) - (a[1].time as number));
        return { ledger: Object.fromEntries(matching.slice(ofs, ofs + 50)), count: matching.length };
      }
      if (method === 'QueryOrders') {
        const wanted = String(params.txid).split(',');
        return Object.fromEntries(wanted.filter((txid) => orders.has(txid)).map((txid) => [txid, orders.get(txid)]));
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, calls, orders, ledger };
}

describe('syncClosedOrders', () => {
  it('backfills 120 orders in 3 pages of 50 and reports the backfill complete', async () => {
    const { client, calls } = fakeKraken({ orders: 120 });
    const result = await syncClosedOrders(client, {
      reconStartSec: T0 - 1_000,
      cursorSec: null,
      backfillComplete: false,
      catalog,
    });

    expect(calls.map((c) => c.method)).toEqual(['ClosedOrders', 'ClosedOrders', 'ClosedOrders']);
    expect(calls.map((c) => c.params.ofs)).toEqual([0, 50, 100]);
    for (const call of calls) expect(call.params).toMatchObject({ start: T0 - 1_000, closetime: 'close' });
    expect(result.pages).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.orders).toHaveLength(120);
    expect(new Set(result.orders.map((o) => o.txid)).size).toBe(120);
    expect(result.orders.map((o) => o.openedAt)).toEqual(result.orders.map((o) => o.openedAt).sort((a, b) => a - b));
    expect(result.orders[0]).toMatchObject({ pair: 'BTC/USD', krakenPair: 'XBTUSD', status: 'closed' });
    expect(result.cursorSec).toBe(T0 + 100 * 120);
  });

  it('stops exactly when count is reached (100 orders = 2 pages)', async () => {
    const { client, calls } = fakeKraken({ orders: 100 });
    const result = await syncClosedOrders(client, { reconStartSec: T0 - 1, cursorSec: null, backfillComplete: false });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ complete: true, pages: 2 });
    expect(result.orders).toHaveLength(100);
  });

  it('completes a backfill of an account without orders in one call', async () => {
    const { client, calls } = fakeKraken({ orders: 0 });
    const result = await syncClosedOrders(client, { reconStartSec: T0, cursorSec: null, backfillComplete: false });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ orders: [], cursorSec: T0, complete: true, pages: 1 });
  });

  it('syncs incrementally from cursor - 600 s and re-reads the overlap without duplicates', async () => {
    const { client, calls } = fakeKraken({ orders: 120 });
    const cursorSec = T0 + 100 * 118; // orders 1..118 are already known
    const result = await syncClosedOrders(client, {
      reconStartSec: T0 - 1,
      cursorSec,
      backfillComplete: true,
      catalog,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toMatchObject({ start: cursorSec - 600, ofs: 0, closetime: 'close' });
    // closetm > cursor - 600: orders 113..120, so the 6 overlapping ones come back together with the 2 new ones.
    expect(result.orders.map((o) => o.txid)).toEqual(
      [113, 114, 115, 116, 117, 118, 119, 120].map((i) => rawOrder(i)[0]),
    );
    expect(result.complete).toBe(true);
    expect(result.cursorSec).toBe(T0 + 100 * 120);
  });

  it('never moves the cursor backwards, even when only overlap comes back', async () => {
    const { client } = fakeKraken({ orders: 120 });
    const cursorSec = T0 + 100 * 130; // ahead of everything Kraken has (e.g. a skewed clock)
    const result = await syncClosedOrders(client, { reconStartSec: T0, cursorSec, backfillComplete: true });
    expect(result.orders).toEqual([]);
    expect(result.cursorSec).toBe(cursorSec);
  });

  it('ignores the cursor until the backfill is marked complete', async () => {
    const { client, calls } = fakeKraken({ orders: 60 });
    const result = await syncClosedOrders(client, {
      reconStartSec: T0 - 5,
      cursorSec: T0 + 3_000,
      backfillComplete: false,
    });
    expect(calls[0]!.params.start).toBe(T0 - 5);
    expect(result.orders).toHaveLength(60);
    expect(result.cursorSec).toBe(T0 + 6_000);
  });

  it('dedupes orders that shift between pages when a new order closes mid-sync, and the next sync picks it up', async () => {
    const harness = fakeKraken({
      orders: 120,
      onCall: (index) => {
        // Between the first and the second page read, order 121 closes: everything moves down by one, so the
        // last order of page 1 shows up again at the top of page 2.
        if (index === 2) harness.orders.set(...rawOrder(121));
      },
    });
    const first = await syncClosedOrders(harness.client, {
      reconStartSec: T0 - 1,
      cursorSec: null,
      backfillComplete: false,
    });
    expect(first.complete).toBe(true);
    expect(first.orders).toHaveLength(120);
    expect(new Set(first.orders.map((o) => o.txid)).size).toBe(120);
    expect(first.cursorSec).toBe(T0 + 100 * 120);

    const second = await syncClosedOrders(harness.client, {
      reconStartSec: T0 - 1,
      cursorSec: first.cursorSec,
      backfillComplete: true,
    });
    expect(second.orders.map((o) => o.txid)).toContain(rawOrder(121)[0]);
    expect(second.cursorSec).toBe(T0 + 100 * 121);
  });

  it('reports an incomplete read when the page cap is hit, and keeps the cursor where it was', async () => {
    const { client } = fakeKraken({ orders: 120 });
    const result = await syncClosedOrders(client, {
      reconStartSec: T0 - 1,
      cursorSec: null,
      backfillComplete: false,
      maxPages: 2,
    });
    expect(result).toMatchObject({ complete: false, pages: 2, cursorSec: T0 - 1 });
    expect(result.orders).toHaveLength(100);
  });

  it('gives up on a listing that announces more orders than it returns', async () => {
    let calls = 0;
    const client: KrakenCaller = {
      call: async () => {
        calls += 1;
        return { closed: calls === 1 ? Object.fromEntries([rawOrder(1)]) : {}, count: 200 };
      },
    };
    const result = await syncClosedOrders(client, { reconStartSec: T0, cursorSec: null, backfillComplete: false });
    expect(calls).toBe(2);
    expect(result.complete).toBe(false);
    expect(result.orders).toHaveLength(1);
  });

  it('stops on a short page when Kraken sends no count', async () => {
    const client: KrakenCaller = { call: async () => ({ closed: Object.fromEntries([rawOrder(1), rawOrder(2)]) }) };
    const result = await syncClosedOrders(client, { reconStartSec: T0, cursorSec: null, backfillComplete: false });
    expect(result).toMatchObject({ complete: true, pages: 1 });
    expect(result.orders).toHaveLength(2);
  });

  it('propagates client errors and rejects unusable responses', async () => {
    const failing: KrakenCaller = {
      call: async () => {
        throw new KrakenError('permission', 'ClosedOrders: EGeneral:Permission denied');
      },
    };
    await expect(
      syncClosedOrders(failing, { reconStartSec: T0, cursorSec: null, backfillComplete: false }),
    ).rejects.toMatchObject({ kind: 'permission' });

    const odd: KrakenCaller = { call: async () => ({ open: {} }) };
    await expect(
      syncClosedOrders(odd, { reconStartSec: T0, cursorSec: null, backfillComplete: false }),
    ).rejects.toMatchObject({
      kind: 'parse',
    });
  });

  it('accepts the whole Kraken envelope as well as the bare result', async () => {
    const client: KrakenCaller = {
      call: async () => ({ error: [], result: { closed: Object.fromEntries([rawOrder(1)]), count: 1 } }),
    };
    const result = await syncClosedOrders(client, { reconStartSec: T0, cursorSec: null, backfillComplete: false });
    expect(result.orders).toHaveLength(1);
  });

  it('works end to end through the real private client (signed, serial, nonces increasing)', async () => {
    const harness = fakeKraken({ orders: 120 });
    const bodies: string[] = [];
    const fetchImpl: KrakenFetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = String(init?.body);
      bodies.push(body);
      const params = Object.fromEntries(new URLSearchParams(body));
      const result = await harness.client.call(path.split('/').pop() as KrakenPrivateMethod, params);
      return new Response(JSON.stringify({ error: [], result }));
    };
    let now = 1_790_000_000_000;
    const client = new KrakenPrivateClient({
      apiKey: 'test-key',
      apiSecret: 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==',
      baseUrl: 'http://localhost:9999/kraken',
      nonce: createNonceSource(
        () => null,
        () => undefined,
        () => now,
      ),
      limiter: new KrakenRateLimiter({
        tier: 'starter',
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
      fetchImpl,
    });

    const result = await syncClosedOrders(client, {
      reconStartSec: T0 - 1,
      cursorSec: null,
      backfillComplete: false,
      catalog,
    });

    expect(result.orders).toHaveLength(120);
    expect(result.complete).toBe(true);
    expect(bodies).toHaveLength(3);
    const parsed = bodies.map((body) => new URLSearchParams(body));
    expect(parsed.map((p) => p.get('ofs'))).toEqual(['0', '50', '100']);
    const nonces = parsed.map((p) => Number(p.get('nonce')));
    expect(nonces[1]!).toBeGreaterThan(nonces[0]!);
    expect(nonces[2]!).toBeGreaterThan(nonces[1]!);
    expect(parsed[0]!.get('closetime')).toBe('close');
  });
});

describe('queryOrdersByTxid', () => {
  it('queries in chunks of 50, dedupes the input and merges the results', async () => {
    const { client, calls, orders } = fakeKraken({ orders: 120 });
    const txids = [...orders.keys()];
    const result = await queryOrdersByTxid(client, [...txids, ...txids.slice(0, 10), 'OUNKNOWN-AAAAA-BBBBBB'], catalog);

    expect(calls.map((c) => (c.params.txid as string[]).length)).toEqual([50, 50, 21]);
    expect(calls.every((c) => c.method === 'QueryOrders')).toBe(true);
    expect(result).toHaveLength(120);
    expect(result[0]).toMatchObject({ pair: 'BTC/USD' });
  });

  it('does not call Kraken when there is nothing to look up', async () => {
    const { client, calls } = fakeKraken();
    await expect(queryOrdersByTxid(client, [])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('syncLedgerEntries', () => {
  const base = { reconStartSec: T0 - 1, cursorSec: null, backfillComplete: false, catalog };

  it('backfills every type in one paged read from the reconciliation start', async () => {
    const { client, calls } = fakeKraken({ ledger: 120 });
    const result = await syncLedgerEntries(client, base);

    expect(calls.map((c) => [c.params.type, c.params.start, c.params.ofs])).toEqual([
      [undefined, T0 - 1, 0],
      [undefined, T0 - 1, 50],
      [undefined, T0 - 1, 100],
    ]);
    expect(result).toMatchObject({ complete: true, pages: 3, cursorSec: T0 + 120 });
    expect(result.entries).toHaveLength(120);
    expect(result.entries[0]).toMatchObject({ type: 'deposit', asset: 'USD', amount: 10, refid: 'R1' });
    expect(result.entries.map((e) => e.at)).toEqual(result.entries.map((e) => e.at).sort((a, b) => a - b));
  });

  it('reads only the tail, 600 s before the cursor, once the backfill is done', async () => {
    const { client, calls } = fakeKraken({ ledger: 120 });
    const result = await syncLedgerEntries(client, { ...base, cursorSec: T0 + 100, backfillComplete: true });
    expect(calls[0]!.params.start).toBe(T0 + 100 - 600);
    expect(result.cursorSec).toBe(T0 + 120);
  });

  it('is incomplete, and holds the cursor back, when the read stopped early', async () => {
    const { client } = fakeKraken({ ledger: 120 });
    const result = await syncLedgerEntries(client, { ...base, maxPages: 1 });
    expect(result.complete).toBe(false);
    expect(result.entries).toHaveLength(50);
    expect(result.cursorSec).toBe(T0 - 1);
  });
});

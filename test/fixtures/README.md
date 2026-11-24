# freqdash test fixtures

Everything under `test/fixtures/raw/` is either captured from the real bots or the public Kraken API, or is
synthetic and documented as such below. Nothing here may contain a credential. `raw/fixtures.test.ts`
validates the inventory, the shapes and the incident numbers, and scans every file for secret patterns.

## Provenance

| Path                                       | Origin          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw/freqtrade/*.json` (32)                | REAL            | GET responses from both bots (freqtrade 2026.8, API 2.5) on 2026-09-28 about 21:29 UTC. Already redacted when copied. `pair_candles` is truncated to 4 rows; `trades` to `limit=3` (votemax `total_trades` is 7). All other list fields in these samples were also truncated to at most 3 items when captured, EXCEPT `votemax_balance.json` / `dca_balance.json`, which were re-captured in full (5 currencies each incl. USD; the real API never omits USD). |
| `raw/kraken/public/*.json`                 | REAL            | Raw response bodies from `api.kraken.com/0/public`, captured 2026-09-28 22:32 UTC by `scripts/fixtures/capture-kraken-public.mjs`. `MANIFEST.json` lists the URLs.                                                                                                                                                                                                                                                                                             |
| `raw/logs/votemax-incident-2026-09-28.log` | REAL, sanitized | INFO and above of the crash loop, windows 03:59:00-04:08:00 and 05:13:00-05:16:00 UTC.                                                                                                                                                                                                                                                                                                                                                                         |
| `raw/logs/votemax-normal-vv.log`           | REAL, sanitized | 2 minutes (22:20:00-22:22:00 UTC) of the live `-vv` log, DEBUG included. Quiet period: one open BTC/USD trade, no orders.                                                                                                                                                                                                                                                                                                                                      |
| `raw/incident/timeline.json`               | DERIVED         | Events parsed from the incident excerpt by `scripts/fixtures/extract-incident.mjs`. Times are epoch ms UTC.                                                                                                                                                                                                                                                                                                                                                    |
| `raw/kraken/private/*.json`                | SYNTHETIC       | Kraken private responses shaped like the real API. There is no read-only key yet.                                                                                                                                                                                                                                                                                                                                                                              |
| `raw/kraken/errors/*.json`                 | SYNTHETIC       | `{"error":["..."]}` bodies (Kraken answers these with HTTP 200).                                                                                                                                                                                                                                                                                                                                                                                               |

### Regenerating

```
node scripts/fixtures/extract-incident.mjs        # logs + timeline (needs the preserved incident logs and the live votemax.log)
node scripts/fixtures/capture-kraken-public.mjs   # public Kraken captures (GET only, no key)
node scripts/fixtures/build-kraken-fixtures.mjs   # synthetic private fixtures (reads the three sets above)
npx vitest run test/fixtures
```

All three scripts are plain Node 22 ESM with no dependencies. The extraction reads the source logs read-only; the
incident logs come from a preserved copy of the rotated `votemax.log.2`. The normal excerpt
comes from the live log, which rotates, so re-running it later needs `--normal-from/--normal-to` for a window that
still exists.

## Sanitization

The raw bot logs contain a Discord webhook URL (in connection-pool DEBUG lines), JWTs in websocket query strings
and browser session headers (uvicorn DEBUG lines). The extraction script:

- drops every record of the HTTP client's connection-pool logger, in both excerpts;
- drops all DEBUG records from the incident excerpt (the normal excerpt keeps them on purpose);
- replaces webhook paths, JWTs and query-string tokens by `REDACTED`, and replaces any record that mentions
  session headers, credentials or keys by `<timestamp> - <logger> - <LEVEL> - REDACTED`;
- re-scans its own output and aborts if a secret pattern is still present.

No such replacement was needed in either committed excerpt (0 redactions); the chosen windows contain no websocket
handshakes. The plan's acceptance grep over `test/fixtures` is clean, and the fixture test repeats it.

## The incident (2026-09-28, votemax, ETH/USD)

Measured on the preserved log (`votemax.log.2`):

| Quantity                                                   | Value                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Entry signals (`Long signal found`)                        | 26, first 04:00:07.822, last 05:14:12.212 UTC                                         |
| `Order ... was created`                                    | 25, first `OX2D7A-ROVIF-A3YVZW` 04:00:07.965, last `OJ6DEM-PMOHZ-XDLFQB` 05:14:12.349 |
| Failed attempts inside the windows                         | 1: `InvalidNonce`, signal 04:03:59.960, WARNING line 04:04:00.099                     |
| `process died` / `Fatal exception!` / `Logfile configured` | 25 / 25 / 25 (median gap between restarts 16.8 s)                                     |
| Sum of the 25 logged orders                                | 288.05229 USD, 0.10872497 ETH (stake / price rounded to 8 dp per order)               |
| Sum of all 26 signals                                      | 293.69964 USD, 0.11085788 ETH                                                         |
| Fatal message                                              | `ValueError: invalid literal for int() with base 10: ''`                              |

Two details that matter to parsers:

- Log lines are not strictly time ordered (several threads log at once, e.g. a `Wallets synced.` stamped 04:04:00.810
  sits before a 04:03:59.956 line). Never assume monotonic timestamps.
- Outside the excerpt windows the same file has a second `Unable to create trade for ETH/USD` at 04:57:40.717
  (`Could not get balance due to ExchangeNotAvailable ... EService:Unavailable`, after repeated `get_balances()` failures).
  The plan's `order_failed` regex would match it. It is listed in `timeline.json` as `outsideWindowEvents` and is not part of
  `events` or `counts`, so the timeline equals what a parser produces from the excerpt.

`timeline.json` event types: `entry_signal` (fixture only, not a `BotEventType`), `startup`, `fatal`, `process_died`,
`order_created` (enriched with `price` and `stakeUsd` from the preceding signal), `order_failed`. `fatal.message` is the
last traceback line; `order_failed.at` is the WARNING line time.

## Synthetic Kraken fixtures (`raw/kraken/private`)

Shapes follow the documented REST responses: all numbers are decimal strings (volumes with the pair's `lot_decimals`,
prices with `pair_decimals`, cost and fee with 5 dp, balances with the asset's `decimals` from the captured `Assets`),
`opentm`/`closetm` are float seconds, `descr.pair` is the altname, `userref` is `0`, fees are in USD (`oflags: fciq`).

| File                                            | Content                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Balance.json`, `BalanceEx.json`                | Current account: ZUSD, XXBT 0.00046744, XETH 0.1130240889, SHIB 1901628.18, BABY 0.21895. `BalanceEx.json` has all four fields (`balance`, `credit`, `credit_used`, `hold_trade`).                                                                                       |
| `BalanceEx.before.json`, `BalanceEx.after.json` | Account at the start and at the end of the incident (`balance` and `hold_trade` only). ETH goes from 8.9e-9 to 0.1130240889.                                                                                                                                             |
| `BalanceEx.wallets.json`                        | Arbitrary values with a non-zero hold and the wallet suffixes `.F`, `.S`, `.HOLD` for the normalizer and asset catalog.                                                                                                                                                  |
| `OpenOrders.empty.json`                         | `{"open":{}}`.                                                                                                                                                                                                                                                           |
| `ClosedOrders.normal.json`                      | The 15 orders found in the sample trades and status (txid = `order_id`, vol = `amount`, vol_exec = `filled`, avg price = `safe_price`, cost = filled x price, fee = cost x the trade's `fee_open` for entries / `fee_close` for exits, times from the order timestamps). |
| `ClosedOrders.incident.json`                    | The 15 above plus the 25 logged incident orders, the Kraken-only order, the manual SHIB order and the zero-fill canceled order.                                                                                                                                          |
| `TradeVolume.json`                              | Taker `0.4000`, maker `0.2500` for `XXBTZUSD` and `XETHZUSD` (keyed by the AssetPairs key).                                                                                                                                                                              |

Incident orders: `vol = stake / price` to 8 dp, `status=closed`, `vol_exec = vol`, `cost = vol x price`, `fee = 0.4% of cost`,
`opentm` = log time, `closetm = opentm + 30 s`, limit price = fill price.

Why there is an order without a log line: the dca bot's cached wallet shows 0.1130240889 ETH, which is 0.00429911 ETH
more than the 25 logged orders explain. `OWDY2Z-TVWRN-IJBALL` (04:03:36.250 UTC, 2647.40) is synthetic and only exists to
close that gap, so that the 26 ETH buys of the incident sum to `0.1130240889 - 8.9e-9 = 0.11302408` ETH. The real cause
will be settled by the Kraken backfill once a key exists; until then its time and price are invented.

Other synthetic orders: `OYYVFI-FJISQ-5N6DW5` (manual SHIB buy, 2026-06-15, to be acknowledged in the scenario) and
`O5GCGD-X5FJN-JFUFDO` (ETH buy canceled after 10 minutes with zero fill, 2026-09-27 12:00 UTC, deliberately outside the
incident scenario window). BABY is dust with no order.

USD balances are anchored on the real bots: `after` = the dca wallet total minus its priced holdings (1501.1379), `before` =
`after` plus cost and fee of the 26 incident orders (1801.7694), current = `after` minus the open BTC trade's
`open_trade_value` (1461.9925).

Not verified against the live API (there is no key): whether `TradeVolume` is keyed by the AssetPairs key or by the
requested altname, and whether real `BalanceEx` responses always carry `credit`/`credit_used`. Normalizers should accept both.

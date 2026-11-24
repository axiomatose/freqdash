# Mock upstreams

One zero-dependency Node 22 process that stands in for everything freqdash talks to: the two freqtrade bots, the
Kraken REST API, and a Discord webhook. It serves the real samples from `test/fixtures/raw/`, verifies
credentials and Kraken signatures for real, and can replay the 2026-09-28 crash-loop incident on a compressed clock.

```
npm run mock                 # http://localhost:9999   (MOCK_PORT=0 picks a free port, printed as MOCK_LISTENING)
npx vitest run test/mock-upstreams
```

Only this package binds port 9999. The dev config (`.env.dev.example`) already points at it:

| App setting                     | Mock endpoint                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `FT_BOT_1_URL` / `FT_BOT_2_URL` | `http://localhost:9999/votemax`, `http://localhost:9999/dca`                     |
| `KRAKEN_API_BASE_URL`           | `http://localhost:9999/kraken` (paths `/0/public/*`, `/0/private/*`)             |
| `DISCORD_WEBHOOK_URL`           | `http://localhost:9999/discord/webhook`                                          |
| `FT_BOT_n_LOGFILE`              | `./test/mock-upstreams/.run/{votemax,dca}.log` (written by the mock, gitignored) |

Credentials are read from `.env.dev.example` (dummy values: bot users `mock-votemax-user` / `mock-dca-user`, the dummy
Kraken key and secret). The process environment is never consulted, so real secrets cannot leak in. Without that file
the same dummy values are built in.

## Environment

| Variable                  | Default                                    | Meaning                                                                               |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `MOCK_PORT`               | `9999`                                     | Port (`0` = random).                                                                  |
| `MOCK_HOST`               | `::` (dual stack, falls back to `0.0.0.0`) | Bind address.                                                                         |
| `MOCK_RUN_DIR`            | `test/mock-upstreams/.run`                 | Where the bot log files are written.                                                  |
| `MOCK_ENV_FILE`           | `.env.dev.example`                         | Credential source.                                                                    |
| `MOCK_FIXTURES_DIR`       | `test/fixtures/raw`                        | Fixture root.                                                                         |
| `MOCK_HANG_MS`            | `30000`                                    | How long a "hanging" bot holds a connection before dropping it.                       |
| `MOCK_CLOSED_ORDERS_PAGE` | `50`                                       | Kraken `ClosedOrders` page size (lower it to test paging with the 43 fixture orders). |

## Curl examples

Run these from Git Bash. URLs are complete, so no path mangling happens; if you ever pass a bare `/...` argument (for
example `--url /__state` or a Docker path) prefix the command with `MSYS_NO_PATHCONV=1`.

```bash
# freqtrade bots (HTTP Basic; only `ping` is public, like the real API)
curl -s http://localhost:9999/votemax/api/v1/ping
curl -s -u mock-votemax-user:mock-votemax-pass http://localhost:9999/votemax/api/v1/health
curl -s -u mock-dca-user:mock-dca-pass "http://localhost:9999/dca/api/v1/trades?limit=2&offset=1"
curl -s -u mock-votemax-user:mock-votemax-pass "http://localhost:9999/votemax/api/v1/pair_candles?pair=BTC/USD&timeframe=4h&limit=3"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9999/votemax/api/v1/health     # 401

# Kraken public
curl -s http://localhost:9999/kraken/0/public/Time
curl -s "http://localhost:9999/kraken/0/public/Ticker?pair=XBTUSD,ETHUSD"
curl -s "http://localhost:9999/kraken/0/public/OHLC?pair=XBTUSD&interval=240"

# Kraken private: requests must be signed. This helper signs with the dummy secret and prints the reply.
node test/mock-upstreams/kraken-call.mjs Balance
node test/mock-upstreams/kraken-call.mjs ClosedOrders ofs=0 closetime=close
node test/mock-upstreams/kraken-call.mjs Balance --bad-signature   # {"error":["EAPI:Invalid signature"],"result":{}}
node test/mock-upstreams/kraken-call.mjs Balance --nonce=1         # {"error":["EAPI:Invalid nonce"],"result":{}}

# notification sinks
curl -s -X POST http://localhost:9999/discord/webhook -H 'Content-Type: application/json' -d '{"content":"[freqdash] test"}'
curl -s http://localhost:9999/__received                    # {"count":1,"discord":[...]}
curl -s -X DELETE http://localhost:9999/__received

# scenario control
curl -s http://localhost:9999/__scenario
curl -s -X POST http://localhost:9999/__scenario -d '{"name":"incident"}'
curl -s -X POST http://localhost:9999/__scenario -d '{"name":"incident","speed":20}'
curl -s http://localhost:9999/__state
curl -s -X POST http://localhost:9999/__scenario -d '{"name":"normal"}'
```

In PowerShell use `curl.exe` and pass JSON through a file (`-d '@body.json'`) to avoid quote mangling.

## Signing a private Kraken request yourself

`API-Sign = base64( HMAC-SHA512( base64decode(secret), path + SHA256(nonce + postdata) ) )`

- `path` is `/0/private/<Method>` **without** the `/kraken` prefix of the mock URL (a real Kraken never sees it);
- `postdata` is the exact urlencoded body that is sent, including `nonce=...`;
- `API-Key` must be the dummy key; the nonce must be strictly larger than every nonce accepted before for that key.

Check order: `EAPI:Invalid key`, then `EAPI:Invalid signature`, then `EAPI:Invalid nonce` (a rejected request does not
advance the nonce). All private replies are HTTP 200 with `{"error":[...],"result":{...}}`. Methods outside the
read-only allowlist (`Balance BalanceEx OpenOrders ClosedOrders QueryOrders TradeVolume Ledgers`, for example
`AddOrder`) answer `EGeneral:Permission denied` and are recorded as violations (see below).

## Scenarios

`POST /__scenario {"name": ...}`. Optional fields: `speed` (scenario clock factor), `delayMs` (incident start delay),
`gapCapSec` (see incident), `mode` (bot-down), `resetLogs` (default true: truncate the log files), `resetNonce`
(default false).

| Scenario                | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normal` (boot default) | Static and healthy. Both bots serve the fixtures with a fresh `last_process_ts`. Kraken balances mirror the bots' wallet fixture (USD 573.05, BTC 0.00046744, ETH dust, SHIB, BABY), no open orders, `ClosedOrders.normal` (15 orders, all of them bot orders). Logs get a heartbeat and a `Wallets synced.` line every 60 s. Expect at most `UNTRACKED_HOLDING` for the manual SHIB holding, which the app's acknowledgement handles. |
| `incident`              | Time-compressed replay of the crash loop, see below. Default `speed` 6, `delayMs` 3000.                                                                                                                                                                                                                                                                                                                                                |
| `bot-down`              | Both bots are unreachable: votemax resets the connection, dca hangs (the client's timeout fires). `mode` `reset`, `hang` or `503` applies to both. No log lines are written. Kraken stays up.                                                                                                                                                                                                                                          |
| `kraken-auth-error`     | Private endpoints answer `EAPI:Invalid key` (HTTP 200). Public endpoints and the bots are healthy.                                                                                                                                                                                                                                                                                                                                     |
| `no-kraken`             | Private endpoints answer HTTP 404, as if unconfigured; the app should not call them (each call is recorded as a violation). Public endpoints and the bots are healthy.                                                                                                                                                                                                                                                                 |

### incident

The real incident (2026-09-28, votemax, ETH/USD) is replayed from `raw/incident/timeline.json`,
`raw/kraken/private/ClosedOrders.incident.json` and `BalanceEx.before/after.json`. Original moments are mapped to
`t0 + compress(offset) / speed`, where `t0 = activation + delayMs` and `compress` caps every quiet gap at `gapCapSec`
(default 90 s of original time; `0` disables it: the real 67 minutes before the 25th order would otherwise dominate).
At the default speed 6 an order appears about every 3 s instead of every 17 s, and the whole replay takes about 100 s.

Everything is re-based on the current time, so the app sees orders, log lines and balances that "just happened".

| Source                                | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| votemax API                           | Unreachable from each `process died` until 2 s (original time) after the next `Logfile configured`: outages alternate between a dropped connection and HTTP 503. `health.bot_startup_ts` changes on every simulated restart (strictly increasing). `bot_start_ts` never changes. `/status` and `/trades` never show an orphan txid.                                                                                                                                                                                                                                                                                  |
| dca API                               | Healthy. Its `/balance` follows the Kraken account (the ETH grows); the crash-looping votemax keeps a stale wallet (ETH 8.9e-9), as in the real incident.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Kraken `OpenOrders`                   | Each of the 26 orders (25 logged plus the log-less `OWDY2Z-TVWRN-IJBALL`) is open for 30 s of original time from its `opentm`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Kraken `ClosedOrders` / `QueryOrders` | An order appears when it closes. The other 17 fixture orders (bot history, the manual SHIB buy, the zero-fill cancel) are always there. End state: `count` 43.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Kraken `Balance` / `BalanceEx`        | From `BalanceEx.before` (USD 1801.7694, ETH 8.9e-9) to `BalanceEx.after` (USD 1501.1379, ETH 0.1130240889) as orders fill, plus the bot's open BTC position. USD held by open orders shows as `hold_trade`. This shape has no `credit` fields (the other scenarios do).                                                                                                                                                                                                                                                                                                                                                |
| `.run/votemax.log`                    | Real-format lines per event: `Long signal found ...`, `Order <txid> was created for ETH/USD and status is open.`, `Sending rpc message: {'type': status, 'status': 'process died'}`, `freqtrade - ERROR - Fatal exception!` with a traceback ending `ValueError: invalid literal for int() with base 10: ''`, `Logfile configured`, one `Unable to create trade ... InvalidNonce` WARNING. Totals: 26 signals, 25 orders, 1 failure, 25 died, 25 fatal, 25 startups. A heartbeat and a `Wallets synced.` line every 60 s of scenario time (`60 / speed` real seconds, at least 250 ms) except while the bot is down. |
| `.run/dca.log`                        | Heartbeats and wallet syncs only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/logs` (API buffer)                  | Recent lines, cleared on each simulated restart; the fatal record is never in it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Control endpoints

| Endpoint                             | Purpose                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /__scenario`                    | Current scenario, speed, delay, cap, start time.                                                                                                                                                                                                                                                           |
| `GET /__state`                       | Clock, per-bot availability, log line counts, Kraken order and balance summary and, during an incident, the replay progress (`counts` vs `totals`, `done`, `endsAt`, the outage windows, the current `startupTs`).                                                                                         |
| `GET/POST /__clock`                  | Virtual clock. `{"mode":"manual","now":ms}` freezes it, `{"advanceMs":ms}` moves it forward (log lines up to the new time are written at once), `{"mode":"real"}` returns to the wall clock. After going back to real time, re-activate the scenario. Deterministic tests use this; nothing else needs it. |
| `GET/DELETE /__received`             | Discord posts (`{count, discord}`).                                                                                                                                                                                                                                                                        |
| `GET/DELETE /__calls[?violations=1]` | Journal of the last 1000 upstream requests (`method`, `path`, `status`, `violation`). A violation is a non-GET request to a bot, a Kraken private method outside the read-only allowlist, or any private Kraken call in `no-kraken`. Assert that it stays empty.                                           |

## Fidelity notes and deviations

- Freqtrade `ping` needs no credentials (as on a real bot); everything else needs Basic auth for that bot. Non-GET
  requests answer 405.
- `/trades` reports `total_trades` = the number of trades the mock holds (3 for votemax, although the real bot has 7),
  so a paginating client always terminates.
- `plot_config` has no fixture and is synthesized from the sample candle columns and the documented layout (VoteMax:
  EMA and support/resistance on the main plot, panes RSI, Score, Touches; DcaBot: EMA and RSI).
- `pair_candles` serves the 4 sampled 4h rows for BTC/USD and ETH/USD; another timeframe returns `length` 0, a pair
  outside the whitelist 404.
- Kraken `Time` follows the virtual clock; `Assets` and `AssetPairs` return the captured 5 assets and 4 pairs (`pair`
  filters `AssetPairs` and `Ticker`); `OHLC` exists for `XBTUSD` at 60 and 240 and `ETHUSD` at 240 (`since` works);
  `Ledgers` is always empty; `TradeVolume` is keyed by the AssetPairs key (`XXBTZUSD`).
- `ClosedOrders` supports `ofs`, `start`, `end` (times or txids) and `closetime` (`open`, `close`, `both`), newest first,
  50 per page, and `count` is the total number of matches. `QueryOrders` returns the known txids and errors with
  `EOrder:Unknown order` when none is known.
- Rate limits are not simulated.
- Restarting the mock truncates the log files, which the app's tailer sees as a rotation.

## OpenAI-compatible endpoint (assistant)

`POST http://localhost:9999/openai/v1/chat/completions` streams a scripted reply (SSE, tool calls, small delays) for any bearer
key of 8+ characters. Point the assistant at it in Settings: base URL `http://localhost:9999/openai/v1`, any key. Keywords in the
last message pick the behavior: `silence` (a write that needs approval), `remember` (saves a memory), `reset` (killswitch, always
asks), `wrong`/`status`/`bots`/`balance`/`how` (reads the summary, then answers with a table); anything else is a plain answer.

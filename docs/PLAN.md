# freqdash: Implementation Plan (v1)

> The original design document, kept because code comments cite its sections (`F1`..`F15`, section numbers). It was
> written for one install with two bots (`votemax`, `dca`); the README describes the current, general setup, and details
> here (the shared dashboard password, ntfy, `<freqtrade>/...` host paths) may be superseded.

A read-only trading-bot dashboard for two freqtrade bots sharing one Kraken account. It uses Next.js 16, TypeScript, SQLite, a Kraken read-only key (optional) and log tailing.

---


## 1. Ground truth from exploration (implementers must respect these)

| # | Fact (verified against real bots / samples / Kraken public API) | Consequence |
|---|---|---|
| F1 | `/api/v1/trades` returns **closed trades only** (votemax `total_trades`=7 vs `/profit.trade_count`=8). `/status` returns open trades. | Take the union of both. Refresh `/trades` when a trade disappears from `/status`. |
| F2 | `/status` orders **lack** `ft_is_entry`, `order_date`, `average` and `price`. They do have `order_id, ft_order_side, safe_price, filled, order_timestamp, order_filled_timestamp, ft_order_tag, status, is_open`. | Derive `isEntry = ft_is_entry ?? (side === 'buy')` (spot long). |
| F3 | Freqtrade's `trades[].orders` only lists filled or open orders. A timed-out entry with zero fill deletes the trade and its order vanishes from the API. | Persist every order id ever seen (`bot_orders_seen`). Otherwise the orphan checks produce false positives. |
| F4 | Timestamp units are mixed. `/health *_ts` and `pair_candles.last_analyzed_ts` are **seconds**. Order/trade `*_timestamp`, `__date_ts`, `data_start_ts` and `/logs` ts are **ms**. Kraken `opentm/closetm/time` are seconds (float). Freqtrade date strings like `"2026-04-27 16:00:08"` carry **no timezone** (they are UTC). | Adapters normalize everything to `Ms` (epoch ms). Never parse the freqtrade date strings. Charts convert to seconds only at the UI edge. |
| F5 | HTTP Basic auth works on every endpoint (verified live on 2026.8). | No JWT or token-refresh logic is needed. |
| F6 | `/health` fields: `bot_start_ts` is the first-ever start (from the bot DB). `bot_startup_ts` is the start of the current process. `last_process_ts` is the last loop (normally every 5 s). | Restart = `bot_startup_ts` changed. DB swap/reset = `bot_start_ts` changed. |
| F7 | `pair_candles` returns at most 719 rows (about 120 days of 4h). Size is 220 KB (votemax, 38 cols) or 136 KB (dca, 19 cols), about 60 ms. The **last row is the last CLOSED candle**; the forming candle is excluded. Informative timeframes are not served (`tf=1d` gives length 0). `enter_long` is `null`, `0` or `1.0`. `at_support` is boolean. NaN comes back as `null`. | Cache it. Append the forming candle from Kraken public OHLC. Snap markers to bar times. |
| F8 | `GET /api/v1/plot_config` returns `main_plot` and `subplots` with colors. VoteMax: main = ema20/50 plus support/resistance at 4h/1d/1w/1m. Subplots are RSI (rsi, rsi_ob, rsi_os), Score (entry_score, exit_score, vote/support/exit_threshold) and Touches. DcaBot: ema20/50 plus RSI. | Use it to drive indicator layout, with a heuristic fallback. |
| F9 | DcaBot sets `enter_long` **only on the last row**, and DCA adds come from `adjust_trade_position`. | Historical DCA signals don't exist in the dataframe, so freqdash must **record signals live** (`signal_history`). |
| F10 | The `/logs` buffer holds about 870 to 1000 records, which is only **3 to 5 minutes** at `-vv`. It is lost on crash. `Fatal exception!` is logged *after* the API server stops, so it is **never visible via `/logs`**. | Tail the log **files** (read-only mount). `/logs` is only a fallback. |
| F11 | Log line format is `YYYY-MM-DD HH:MM:SS,mmm - logger - LEVEL - message`, in UTC. Tracebacks are continuation lines. Useful INFO+ lines: `Order <txid> was created for <pair> and status is open.`, `Long signal found: ... stake_amount: X and price: Y`, `Unable to create trade for <pair>: ...` (WARNING), `Sending rpc message: {... 'process died'}`, `freqtrade - ERROR - Fatal exception!`, `freqtrade.loggers - INFO - Logfile configured` (first line of every start), `Wallets synced.`, and `Bot heartbeat. PID=1, version='..', state='RUNNING'` (every 60 s). | These patterns are what the log parser matches. |
| F12 | **Incident facts** (2026-09-28 UTC, votemax, ETH/USD): 26 entry signals between 04:00:07.8 and 05:14:12. **25** "Order ... was created" lines. 1 attempt at 04:03:59.96 failed with `EAPI:Invalid nonce`. Crash-restart period was about 16 s: `worker found ... calling exit`, then `process died`, then `Fatal exception!` + `ValueError: invalid literal for int() with base 10: ''`, then about 6 s to `Logfile configured`. The 25 placed orders total $288.05 / 0.108725 ETH; all 26 signals total $293.70 / 0.110858 ETH. The dca bot's cached wallet shows **0.1130240889 ETH**, which is 0.0043 ETH more than the 25 logged orders. The Kraken backfill will settle this. The bot ran 2026.4 at the time. | Fixture design (WP0b/WP3). |
| F13 | The two bots' `/balance` disagree (different totals, and ETH 8.9e-9 vs 0.113). | This shows the stale-wallet problem. Never sum them. |
| F14 | Kraken `AssetPairs` `fees`/`fees_maker` now return **empty arrays** (the incident's root cause). Pair naming: key `XXBTZUSD`, altname `XBTUSD`, wsname `XBT/USD`, base `XXBT`; `XETHZUSD`/`ETHUSD`; `SHIBUSD` base `SHIB` quote `ZUSD`. `Assets` altname is `XBT` for `XXBT`. `OHLC interval=240` returns 721 rows; the last row's time is greater than `result.last`, meaning it is the forming candle. | Get expected fees from private `TradeVolume`. Build the pair catalog from `AssetPairs`. |
| F15 | votemax trade 3 exit shows `fee_close` = 0.8% ($0.509 on $63.67). | The fee check will flag it as a historical info finding. |

---

## 2. Architecture and tech decisions

```
 phone / desktop browser
        | HTTPS via cloudflared (optional) or http://LAN:8043
        v
+---------------- freqdash container (node:22-bookworm-slim, uid 1001) ----------------+
|  Next.js 16 standalone server (App Router)                                           |
|   proxy.ts (auth gate + security headers)                                            |
|   /api/v1/* route handlers --read--> StateStore (globalThis) + SQLite                |
|   React client pages (TanStack Query polling 10 s)                                   |
|                                                                                      |
|  instrumentation.ts -> boot() -> Poller (single scheduler, setTimeout chains)        |
|     freqtrade jobs --GET only, Basic--> http://freqtrade-{votemax,dca}:8080          |
|     kraken jobs --serial signed POST, allowlist--> api.kraken.com (read-only key)    |
|     market jobs --public GET--> api.kraken.com/0/public                              |
|     log tailer --fs read--> /ftlogs/*.log (ro bind of the bots' log dir)    |
|     checks engine (PURE) -> lifecycle (PURE) -> findings table -> notifier           |
|  SQLite (better-sqlite3, WAL) on named volume /data                                  |
+--------------------------------------------------------------------------------------+
        notifier --> Discord webhook (optional)
```

| Decision | Choice | Why |
|---|---|---|
| Framework | **Next.js 16.2.x, App Router, React 19.2, TypeScript strict** | Current major. In 16, `middleware.ts` became **`proxy.ts`** (Node runtime); `next lint` was removed, so use the ESLint CLI. |
| Poller hosting | **Single container. Poller starts from `instrumentation.ts` `register()`**, guarded by `NEXT_RUNTIME==='nodejs'`, `NEXT_PHASE!=='phase-production-build'`, `POLLER_ENABLED!=='false'`, and a `globalThis` flag. | This is the official once-per-process hook. It keeps standalone output (a custom server would lose it and complicate the build). A separate worker container would mean two images of config, secrets duplicated, and SQLite shared across containers. Rejected for v1. The poller is written framework-agnostic (`startPoller(deps)`) so a 10-line `worker.ts` could move it out later. |
| Pitfalls handled | (1) The instrumentation bundle and route bundles can get **separate module instances**, so all shared runtime state lives on `globalThis[Symbol.for('freqdash.*')]` and in SQLite, never in module singletons. (2) The poller must not start during `next build`. (3) Edge runtime: use a dynamic `import('./server/boot')` only under nodejs so better-sqlite3 never reaches edge. (4) Dev HMR double start: globalThis guard. (5) Every job is try/catch'd, plus `process.on('unhandledRejection')` logs. (6) A SIGTERM listener stops timers and closes the DB, without calling `process.exit`. (7) Invalid auth/bot config makes `register()` throw, so the container fails fast with a readable, value-free error. | |
| Storage | **SQLite via better-sqlite3**, WAL, on a **named volume** `freqdash-data:/data` | Synchronous and fast. Next auto-externalizes it (also listed in `serverExternalPackages`). A named volume avoids WAL/locking trouble on Windows bind mounts. |
| Live data to UI | **Client polling** with TanStack Query v5 (`refetchInterval` 10 s, paused when the tab is hidden) | Robust through cloudflared and mobile backgrounding. The payloads are small. SSE is not worth the complexity. |
| Styling/components | **Tailwind v4** (CSS-first `@theme` tokens), **shadcn/ui** (Radix) primitives in `src/components/ui`, `lucide-react`, `vaul` for mobile bottom sheets. Dark theme only in v1. | Fast, consistent, well known to Sonnet. |
| Desktop vs mobile | CSS breakpoints (no UA sniffing). At `>=1024px` (lg): sidebar shell and multi-column grids. Below 768px: top app bar, **bottom tab bar**, stacked cards, sheets instead of dialogs, tables become card lists. The chart picks its config via `useMediaQuery` after mount. | SSR-consistent and still gives two distinct designs. |
| Charting | **TradingView lightweight-charts 5.2** | Verified: panes (`chart.addSeries(Type, opts, paneIndex)`, `pane.setHeight`), `createSeriesMarkers` with shapes arrowUp/arrowDown/circle/square and **price positions `atPriceTop/Bottom/Middle` + `price`** (exact fill prices), `LineType.WithSteps` for S/R, `createPriceLine` for thresholds, touch pinch/drag (`handleScale.pinch`, `handleScroll.horzTouchDrag`), `autoSize`. No built-in tooltip; build one with `subscribeCrosshairMove`. Markers must sit on existing bar times and be sorted. Apache-2.0 with an attribution requirement, so keep the default `attributionLogo`. Rejected: ECharts (heavier, less trading-native), Highcharts Stock (commercial). |
| Kraken client | **Hand-rolled signed client (~200 LOC) with a hard endpoint allowlist.** Not ccxt. | ccxt is huge and bundles trading methods. It hides raw fields (`hold_trade`, `vol_exec`), its market loading depends on `AssetPairs` (which broke in the incident), and it has a history of Next bundling issues. A hand-rolled client gives exact nonce, rate-limit and error control. |
| Freqtrade client | Hand-rolled `fetch`, **GET-only allowlist**, HTTP Basic per request | Freqtrade has no read-only API role. The dashboard holds control-capable credentials, so it must be structurally unable to POST. |
| Validation | zod v4. Lenient raw-response schemas (`.passthrough()`, nullable numbers). Strict env and request-body schemas. | Resilient to freqtrade version drift. |
| Tests | **Vitest** (unit, node env; `// @vitest-environment happy-dom` for the few component tests). **Playwright**: about 8 e2e checks at 1440x900 and 390x844 against a mock-upstream stack, plus a screenshot script for UI work packages. Coverage gate is 90% for `checks/` and `accounting/`. | Business logic is pure and heavily unit-tested. E2E stays small. |
| Lint/format | ESLint 9 flat config (`eslint-config-next/core-web-vitals` + `typescript-eslint` + `eslint-config-prettier`), Prettier | Matches Next 16. |
| Node/base image | `node:22-bookworm-slim` for build and runtime (glibc, not alpine) | Matches host Node 22. better-sqlite3 prebuilds exist for it. |

---

## 3. Auth, CSRF, secrets

* **Login (user accounts, supersedes the original shared `DASHBOARD_PASSWORD`):** a `users` table (migration v3). On an empty table, boot creates `admin` with a random temporary password, logged once, and `must_change_password = 1`; `AUTH_RESET_USER` set before the first start creates that account instead. Passwords are scrypt hashes (`scrypt$15$8$1$salt$hash`, N=2^15, verified off the event loop); an unknown username is checked against a dummy hash so timing does not reveal which accounts exist. The username is used for attribution (acks, silences, settings). A failed attempt gets a fixed ~400 ms delay. A temporary password unlocks only `/change-password` and `POST /api/auth/password` (everything else: pages redirect there, APIs answer 403 `password_change_required`). Account recovery: `AUTH_RESET_USER` + `AUTH_RESET_PASSWORD`, applied once per pair at boot; a username that does not exist yet is created (how further accounts are added).
* **Captcha:** after 2 wrong passwords within 15 min for the same client address or the same username, the login also requires a self-hosted PNG captcha (5 characters, single use, 5 min TTL, in memory). A missing or wrong captcha is answered 401 with a new challenge and does not count as a password attempt.
* **Sessions (server-side, supersede the original stateless signed cookie):** the cookie `fd_session` holds an opaque 256-bit random token; the `sessions` table (migration v4) holds its SHA-256 hash with the user, created/last-seen times, an idle expiry, an absolute expiry, a device label (from the User-Agent) and the client address. Idle timeout = `SESSION_MAX_AGE_DAYS` (default 30), slid forward on use (written at most every 5 min); absolute lifetime = 90 days (or the idle timeout if longer). A session ends at sign-out (row deleted, so a copied cookie dies too), when the user ends it in Settings > Account (one, or all but the current), when the password changes (all of the user's sessions; this browser gets a new token), or on an `AUTH_RESET_*` reset. The proxy (`gate.ts`, no database) only checks that a well-formed cookie is present; `withAuth` (API) and `(app)/layout.tsx` (pages, via `requirePageSession`) look the session up, take the username and temporary-password flag from the database, and redirect to `/login` or `/change-password`. Expired rows are pruned by the maintenance job. Flags: `HttpOnly; SameSite=Lax; Path=/; Max-Age=<absolute lifetime>`. `Secure` is set when `COOKIE_SECURE=true`, or when `auto` and `X-Forwarded-Proto: https` (cloudflared sets it), so LAN http still works. `SESSION_SECRET` (at least 32 chars) is no longer part of the session; it keys the encryption of stored secrets.
* **Rate limiting (in-memory):** per IP, 5 failures per 15 min gives a 15 min lockout (HTTP 429 with `Retry-After`). Globally, 20 failures per 15 min locks everyone out for 15 min. This protects against spoofed IPs. IP source: `cf-connecting-ip` when `TRUST_PROXY=cloudflare`, else the first `x-forwarded-for` hop, else `'unknown'`.
* **Defense in depth:** `proxy.ts` gates pages (redirects to `/login?next=<relative path only>`) and returns 401 JSON for `/api/v1/*`. **Every route handler also calls `withAuth()`**, so there is no reliance on proxy alone (lesson of CVE-2025-29927). Public paths are only `/login`, `/api/auth/login`, `/api/auth/captcha`, `/api/health`, `/_next/static/*`, `/manifest.webmanifest`, `/sw.js` (Web Push service worker) and `/icons/*`.
* **CSRF:** all mutating routes (login, logout, silence/unsilence, acks, notify test) require (a) `Content-Type: application/json` (non-JSON gets 415, which forces a CORS preflight for cross-origin requests), and (b) `Sec-Fetch-Site: same-origin` when that header is present, otherwise an `Origin` that is in `APP_ORIGINS` or equal to `X-Forwarded-Host`/`Host`. Failure returns 403. No token is needed.
* **Security headers** (set in proxy on every response): `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` (add `'unsafe-eval'` only in dev). Also `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. All `/api/*` responses get `Cache-Control: no-store`.
* **Secrets:** all secrets live in `.env` next to `compose.yaml`, loaded by compose `env_file`. The repo gets `.env.example` and `.env.dev.example`, and `.gitignore`/`.dockerignore` exclude `.env*` (except the examples), `data/` and `*.sqlite*`. Rules:
  * No `NEXT_PUBLIC_*` variables at all.
  * Every server module imports `server-only`.
  * `redactSecrets()` (WP0a) masks Discord webhook paths, JWTs, `token=`, `Authorization`/`API-Sign`, and the exact values of every configured secret. It is applied to all logged text, all stored errors and all log lines.
  * Notifier errors are logged only as `discord: HTTP 404`. The URL is never logged.
  * The Kraken key must be a **new read-only key**: Funds Query, Query open orders & trades, Query closed orders & trades (plus optionally Query ledger entries). The client can only call allowlisted methods.

---

## 4. Directory layout (repository root)

```
compose.yaml  compose.dev.yaml  compose.test.yaml  Dockerfile  .dockerignore  .gitignore
.env.example  .env.dev.example  README.md  docs/RUNBOOK.md
package.json  package-lock.json  tsconfig.json  next.config.ts  eslint.config.mjs  .prettierrc
vitest.config.ts  playwright.config.ts  postcss.config.mjs  components.json
public/ manifest.webmanifest  icons/{icon-192.png,icon-512.png,apple-touch-icon.png}
scripts/ shot.mjs  fixtures/{extract-incident.mjs, build-kraken-fixtures.mjs}
src/
  instrumentation.ts        proxy.ts
  app/
    layout.tsx  globals.css
    login/page.tsx  login/LoginForm.tsx
    (app)/layout.tsx  (app)/page.tsx  (app)/bots/[botId]/page.tsx  (app)/chart/page.tsx
    (app)/trades/page.tsx  (app)/findings/page.tsx  (app)/status/page.tsx  (app)/ui-kit/page.tsx
    api/health/route.ts
    api/auth/{login,logout,session}/route.ts
    api/v1/{summary,overview,trades,equity,status,chart}/route.ts
    api/v1/bots/[botId]/route.ts
    api/v1/kraken/orders/route.ts
    api/v1/findings/route.ts  api/v1/findings/[id]/{silence,unsilence}/route.ts
    api/v1/acks/route.ts  api/v1/acks/[id]/route.ts
    api/v1/notify/test/route.ts
  shared/  types/{domain,findings,api,state}.ts  constants.ts  runbook.ts
  server/
    config.ts  log.ts  boot.ts
    state/store.ts
    db/{client,migrations}.ts  db/repos/*.ts
    auth/{session,sessions,page,password,ratelimit,gate,guard,origin,captcha,reset}.ts
    freqtrade/{client,schemas,normalize,candles}.ts
    logs/{parser,events,tailer}.ts
    kraken/{sign,nonce,ratelimit,private,public,errors,assets,normalize,sync}.ts
    accounting/{pnl,stats,account,allocation,equity}.ts
    checks/{types,config,engine,lifecycle,util}.ts  checks/rules/*.ts
    poller/{scheduler,context}.ts  poller/jobs/*.ts
    notify/{dispatcher,discord}.ts
    push/{crypto,send,service,trades,views}.ts
    views/*.ts
    chart/{builder,indicators,markers,cache}.ts
    mock/responses.ts
  components/ ui/*  shell/*  data/*  overview/*  bots/*  equity/*  trades/*  findings/*  status/*  chart/*
  lib/client/{api,queries,format,useMediaQuery,prefs}.ts
test/
  fixtures/raw/{freqtrade,kraken/public,kraken/private,kraken/errors,logs,incident}/...
  fixtures/incident/scenario.ts  fixtures/README.md
  mock-upstreams/{server.mjs,scenarios.mjs,README.md}
e2e/*.spec.ts
```

**compose.yaml**
```yaml
services:
  freqdash:
    build: .
    image: freqdash:latest
    container_name: freqdash
    restart: unless-stopped
    env_file: .env
    environment: [TZ=UTC, DATA_DIR=/data, NODE_OPTIONS=--max-old-space-size=384]
    ports: ["8043:3000"]
    volumes:
      - freqdash-data:/data
      - ../freqtrade/logs:/ftlogs:ro
    tmpfs: [/tmp, /app/.next/cache]
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 512m
    logging: { driver: json-file, options: { max-size: 10m, max-file: "3" } }
    networks: [bots]
networks: { bots: { external: true, name: "${BOT_NETWORK:?}" } }
volumes: { freqdash-data: {} }
```

**Dockerfile** (multi-stage; the `test` stage only builds with `--target test`)
```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
FROM deps AS test
COPY . .
RUN npm run verify
FROM deps AS build
COPY . .
RUN npm run build
FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -g 1001 app && useradd -u 1001 -g app -s /usr/sbin/nologin app \
 && mkdir -p /data /app/.next/cache && chown -R app:app /data /app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
```

`next.config.ts`:
```ts
{
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingIncludes: { '/*': ['./node_modules/better-sqlite3/build/Release/*.node'] }
}
```

`compose.dev.yaml` defines a `tools` service (`node:22-bookworm-slim`, `working_dir /app`, volumes `.:/app` and the named volume `freqdash_node_modules:/app/node_modules`). It is the canonical Docker gate: `docker compose -f compose.dev.yaml run --rm tools sh -c "npm ci && npm run verify"`.

`.env.example`:
```ini
# Auth (required)
DASHBOARD_PASSWORD=
SESSION_SECRET=                 # openssl rand -base64 48
SESSION_MAX_AGE_DAYS=30
COOKIE_SECURE=auto              # auto|true|false
APP_ORIGINS=http://localhost:8043
APP_PUBLIC_URL=                 # optional, for links in notifications
TRUST_PROXY=cloudflare          # none|cloudflare
# Bots (1..10)
FT_BOT_1_ID=votemax
FT_BOT_1_NAME=VoteMax
FT_BOT_1_URL=http://freqtrade-votemax:8080
FT_BOT_1_USERNAME=
FT_BOT_1_PASSWORD=
FT_BOT_1_LOGFILE=/ftlogs/votemax.log
FT_BOT_1_COLOR=#4F8CFF
FT_BOT_2_ID=dca
FT_BOT_2_NAME=DCA
FT_BOT_2_URL=http://freqtrade-dca:8080
FT_BOT_2_USERNAME=
FT_BOT_2_PASSWORD=
FT_BOT_2_LOGFILE=/ftlogs/dca.log
FT_BOT_2_COLOR=#B38CFF
# Kraken READ-ONLY key (optional -> freqtrade-only mode). NEVER reuse the bots' key.
KRAKEN_API_KEY=
KRAKEN_API_SECRET=
KRAKEN_API_BASE_URL=https://api.kraken.com
KRAKEN_TIER=starter             # starter|intermediate|pro
RECON_START=                    # ISO; default = earliest bot trade open - 5 min
# Notifications (optional)
DISCORD_WEBHOOK_URL=
NOTIFY_MIN_SEVERITY=warning
# Runtime
POLLER_ENABLED=true
LOG_BACKFILL_HOURS=96
LOG_LEVEL=info
```

---

## 5. Data model

### 5.1 SQLite schema (`src/server/db/migrations.ts`, embedded as TS strings so they ship in the standalone output)

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
 -- keys: schema_version, kraken_nonce, kraken_backfill_complete, kraken_closed_cursor_sec,
 --       recon_start_at, bot:<id>:startup_at, bot:<id>:start_at, bot:<id>:max_closed_trades
CREATE TABLE source_state (source TEXT PRIMARY KEY, last_ok_at INTEGER, last_attempt_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, payload_json TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE bot_orders_seen (bot_id TEXT NOT NULL, order_id TEXT NOT NULL, trade_id INTEGER NOT NULL,
  pair TEXT NOT NULL, side TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, order_id));
CREATE INDEX ix_bos_order ON bot_orders_seen(order_id);
CREATE TABLE bot_events (id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL,
  source TEXT NOT NULL, order_id TEXT, pair TEXT, price REAL, stake_usd REAL, message TEXT,
  fingerprint TEXT NOT NULL UNIQUE);
CREATE INDEX ix_be_bot_at ON bot_events(bot_id, at); CREATE INDEX ix_be_type_at ON bot_events(type, at);
CREATE INDEX ix_be_order ON bot_events(order_id);
CREATE TABLE log_cursors (bot_id TEXT PRIMARY KEY, file TEXT NOT NULL, head_hash TEXT NOT NULL,
  offset INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE kraken_orders (txid TEXT PRIMARY KEY, pair TEXT, kraken_pair TEXT NOT NULL, side TEXT NOT NULL,
  order_type TEXT NOT NULL, status TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER,
  vol REAL NOT NULL, vol_exec REAL NOT NULL, cost_usd REAL NOT NULL, fee_usd REAL NOT NULL,
  avg_price REAL, limit_price REAL, userref INTEGER, cl_ord_id TEXT, reason TEXT,
  first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, raw_json TEXT NOT NULL);
CREATE INDEX ix_ko_opened ON kraken_orders(opened_at); CREATE INDEX ix_ko_pair ON kraken_orders(pair, opened_at);
CREATE TABLE kraken_flows (ledger_id TEXT PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, asset TEXT NOT NULL,
  amount REAL NOT NULL, fee REAL NOT NULL, refid TEXT, raw_json TEXT NOT NULL);
CREATE TABLE equity_snapshots (at INTEGER PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('kraken','bot-wallet')),
  total_usd REAL NOT NULL, usd_cash REAL NOT NULL, bot_positions_usd REAL, untracked_usd REAL,
  holdings_json TEXT NOT NULL, unpriced_json TEXT NOT NULL DEFAULT '[]');     -- at floored to 5 min
CREATE TABLE signal_history (bot_id TEXT NOT NULL, pair TEXT NOT NULL, timeframe TEXT NOT NULL, candle_at INTEGER NOT NULL,
  enter INTEGER NOT NULL, exit INTEGER NOT NULL, enter_tag TEXT, exit_tag TEXT, first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, pair, timeframe, candle_at));
CREATE TABLE findings (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, rule TEXT NOT NULL,
  severity TEXT NOT NULL, max_severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','resolved')),
  title TEXT NOT NULL, detail TEXT NOT NULL, subject_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  evidence_keys_json TEXT NOT NULL DEFAULT '[]',
  min_duration_ms INTEGER NOT NULL DEFAULT 0, clear_after_ms INTEGER NOT NULL DEFAULT 30000,
  escalate_after_ms INTEGER, escalate_to TEXT,
  first_seen_at INTEGER NOT NULL, episode_start_at INTEGER NOT NULL, active_since INTEGER,
  last_seen_at INTEGER NOT NULL, cleared_at INTEGER, resolved_at INTEGER,
  occurrences INTEGER NOT NULL DEFAULT 1, flap_count INTEGER NOT NULL DEFAULT 0,
  silenced_at INTEGER, silenced_by TEXT, silenced_note TEXT, silenced_severity TEXT, silenced_evidence_count INTEGER,
  notified_at INTEGER, notified_severity TEXT, notified_evidence_count INTEGER);
CREATE UNIQUE INDEX ux_findings_open ON findings(fingerprint) WHERE status IN ('pending','active');
CREATE INDEX ix_findings_status ON findings(status, severity);
CREATE TABLE acknowledgements (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('asset','kraken_order')),
  subject TEXT NOT NULL, label TEXT NOT NULL CHECK (label IN ('manual','ignored')), note TEXT, qty_baseline REAL,
  created_at INTEGER NOT NULL, created_by TEXT, expires_at INTEGER, revoked_at INTEGER, revoked_by TEXT);
CREATE UNIQUE INDEX ux_acks_active ON acknowledgements(kind, subject) WHERE revoked_at IS NULL;
CREATE TABLE notifications_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, channel TEXT NOT NULL,
  fingerprint TEXT, kind TEXT NOT NULL, severity TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);
```

Retention (maintenance job every 6 h):
* `bot_events`: `order_created`/`order_canceled` kept 365 days; everything else 90 days. DEBUG records are never stored.
* Resolved findings: 90 days. `notifications_log`: 30 days.
* Equity snapshots and Kraken orders: kept forever.
* `VACUUM` runs weekly.

### 5.2 Shared TypeScript contracts (WP0a writes these verbatim; later WPs must not change them without the integrator)

```ts
// src/shared/types/domain.ts
export type Ms = number;                 // epoch ms UTC, used everywhere
export type BotId = string;              // /^[a-z0-9-]{1,32}$/
export type Pair = string;               // 'BTC/USD'
export type Asset = string;              // 'BTC','ETH','USD','SHIB'
export type Severity = 'info' | 'warning' | 'critical';
export type Side = 'buy' | 'sell';
export type SourceKey = string;          // 'bot:votemax:status' | 'kraken:balance' | 'logtail:dca' | 'market:ticker'
export type FreshnessState = 'fresh' | 'aging' | 'stale' | 'error' | 'disabled';
export interface Freshness { source: SourceKey; label: string; cadenceMs: number; lastOkAt: Ms | null;
  lastAttemptAt: Ms | null; consecutiveFailures: number; error: string | null; state: FreshnessState; }
  // state (computed at response time): disabled if not configured; fresh if age<=2*cadence;
  // aging if <=5*cadence; stale otherwise; error if last attempt failed and age>2*cadence.

export interface BotConfigInfo { botId: BotId; botName: string; strategy: string; timeframe: string; timeframeMs: number;
  stakeCurrency: string; maxOpenTrades: number; dryRun: boolean; tradingMode: string; state: string;
  runmode: string; version: string; positionAdjustment: boolean; exchange: string; }
export interface BotHealth { reachable: boolean; authFailed: boolean; lastProcessAt: Ms | null;
  botStartAt: Ms | null; botStartupAt: Ms | null; unreachableSince: Ms | null; }
export interface BotOrder { botId: BotId; tradeId: number; orderId: string; pair: Pair; side: Side; isEntry: boolean;
  tag: string | null; status: string; orderType: string; amount: number; filled: number; remaining: number;
  price: number | null; cost: number | null; placedAt: Ms | null; filledAt: Ms | null; isOpen: boolean; }
export interface TradePnl { entryQty: number; exitQty: number; openQty: number; entryCostUsd: number;
  exitProceedsUsd: number; feesUsd: number; costBasisUsd: number; realizedUsd: number;
  unrealizedUsd: number | null; totalUsd: number | null; roiOnStake: number | null;
  markPrice: number | null; markSource: 'kraken' | 'bot' | null; }
export interface BotTradeBase { botId: BotId; tradeId: number; key: string; pair: Pair; base: Asset; quote: Asset;
  isOpen: boolean; strategy: string; enterTag: string | null; exitReason: string | null;
  amount: number; stakeAmount: number; maxStakeAmount: number; openRate: number; closeRate: number | null;
  botCurrentRate: number | null; openedAt: Ms; openFilledAt: Ms | null; closedAt: Ms | null;
  feeOpenRate: number | null; feeOpenCost: number | null; feeCloseRate: number | null; feeCloseCost: number | null;
  entries: number; exits: number; hasOpenOrders: boolean; orders: BotOrder[];
  ftProfitAbs: number | null; }        // cross-check only, never displayed as ROI
export interface BotTrade extends BotTradeBase { pnl: TradePnl; }
export interface FtWalletCurrency { currency: Asset; balance: number; free: number; used: number;
  botOwned: number | null; estStakeUsd: number | null; isBotManaged: boolean; }
export interface FtWalletView { botId: BotId; fetchedAt: Ms; lastWalletSyncAt: Ms | null;
  currencies: FtWalletCurrency[]; totalUsd: number; }
export interface BotStats { closedTrades: number; wins: number; losses: number; winRate: number | null;
  realizedUsd: number; unrealizedUsd: number; totalUsd: number; closedCostBasisUsd: number; roiOnStake: number | null;
  openTrades: number; openCostBasisUsd: number; openMarketValueUsd: number | null;
  peakConcurrentStakeUsd: number; returnOnPeakStake: number | null; feesUsd: number;
  firstTradeAt: Ms | null; lastTradeAt: Ms | null; }
export type BotEventType = 'startup' | 'fatal' | 'process_died' | 'order_created' | 'order_failed' | 'order_canceled'
  | 'error' | 'identity_changed' | 'unreachable' | 'recovered';
export interface BotEvent { botId: BotId; at: Ms; type: BotEventType; source: 'logfile' | 'api-logs' | 'health' | 'poller';
  orderId?: string; pair?: Pair; price?: number; stakeUsd?: number; message?: string; fingerprint: string; }

export type KrakenWallet = 'spot' | 'earn' | 'staked' | 'other';
export interface KrakenBalanceEntry { asset: Asset; krakenAsset: string; wallet: KrakenWallet; total: number;
  hold: number; available: number; priceUsd: number | null; valueUsd: number | null; }
export type KrakenOrderStatus = 'pending' | 'open' | 'closed' | 'canceled' | 'expired';
export interface KrakenOrder { txid: string; pair: Pair | null; krakenPair: string; side: Side; orderType: string;
  status: KrakenOrderStatus; openedAt: Ms; closedAt: Ms | null; vol: number; volExec: number; costUsd: number;
  feeUsd: number; avgPrice: number | null; limitPrice: number | null; userref: number | null;
  clOrdId: string | null; reason: string | null; }
export interface KrakenFlow { ledgerId: string; at: Ms; type: 'deposit' | 'withdrawal' | 'transfer' | 'other';
  asset: Asset; amount: number; fee: number; }
export interface AccountSnapshot { source: 'kraken' | 'bot-wallet'; estimatedFromBot: BotId | null; asOf: Ms;
  totalUsd: number; usdCash: number; usdAvailable: number | null; holdings: KrakenBalanceEntry[]; unpricedAssets: Asset[]; }
export interface HoldingAttribution { asset: Asset; total: number; valueUsd: number | null;
  byBot: { botId: BotId; qty: number }[]; acknowledgedQty: number | null; ackId: number | null;
  untrackedQty: number; untrackedUsd: number | null; status: 'cash' | 'bot' | 'manual' | 'untracked' | 'dust'; }
export interface Allocation { totalUsd: number; usdCash: number; botPositions: { botId: BotId; valueUsd: number }[];
  acknowledgedUsd: number; untrackedUsd: number; dustUsd: number; holdings: HoldingAttribution[]; }
export interface Acknowledgement { id: number; kind: 'asset' | 'kraken_order'; subject: string; label: 'manual' | 'ignored';
  note: string | null; qtyBaseline: number | null; createdAt: Ms; createdBy: string | null;
  expiresAt: Ms | null; revokedAt: Ms | null; }

// chart
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; live?: boolean } // UTC seconds, open time
export interface SeriesPoint { time: number; value: number }
export interface IndicatorSeries { key: string; label: string; placement: 'main' | 'pane'; pane: string | null;
  kind: 'line' | 'step' | 'histogram' | 'threshold'; color: string; lineWidth: number; defaultVisible: boolean;
  points: SeriesPoint[]; }
export interface SignalMarker { time: number; kind: 'enter' | 'exit'; tag: string | null; source: 'dataframe' | 'recorded' }
export interface FillMarker { time: number; at: Ms; botId: BotId | null; tradeId: number | null; orderId: string; side: Side;
  isEntry: boolean; price: number; qty: number; costUsd: number; tag: string | null; origin: 'bot' | 'kraken-orphan' }
export interface ChartData { botId: BotId; pair: Pair; timeframe: string; source: 'freqtrade' | 'kraken';
  strategy: string | null; candles: Candle[]; indicators: IndicatorSeries[]; signals: SignalMarker[]; fills: FillMarker[];
  positions: { botId: BotId; tradeId: number; avgPrice: number; qty: number }[];
  meta: { lastAnalyzedAt: Ms | null; dataStopAt: Ms | null; liveCandle: boolean; signalsNote: string | null };
  freshness: Freshness[]; }
```

```ts
// src/shared/types/findings.ts
export type RuleId = 'BOT_UNREACHABLE' | 'BOT_AUTH_FAILED' | 'BOT_STALE_PROCESS' | 'BOT_NOT_RUNNING' | 'BOT_RESTARTED'
  | 'BOT_RESTART_LOOP' | 'BOT_IDENTITY_CHANGED' | 'BOT_FATAL_LOG' | 'BOT_ERROR_LOG' | 'UNPERSISTED_ORDER'
  | 'ORPHAN_KRAKEN_ORDER' | 'BOT_ORDER_MISSING_ON_KRAKEN' | 'ORDER_MISMATCH' | 'ORDER_STORM' | 'FEE_ANOMALY'
  | 'UNTRACKED_HOLDING' | 'BOT_OVERCLAIMS_HOLDING' | 'USD_VIEW_DRIFT' | 'KRAKEN_ERROR' | 'CLOCK_SKEW'
  | 'LOG_TAIL_UNAVAILABLE' | 'NOTIFIER_FAILING';
export interface FindingSubject { botId?: BotId; pair?: Pair; asset?: Asset; orderId?: string; tradeId?: number; kind?: string }
export interface RawFinding { rule: RuleId; fingerprint: string; severity: Severity; title: string; detail: string;
  subject: FindingSubject; evidence: Record<string, unknown>; evidenceKeys?: string[];
  minDurationMs?: number; clearAfterMs?: number; escalateAfterMs?: number; escalateTo?: Severity; }
export type FindingStatus = 'pending' | 'active' | 'resolved';
export interface Finding extends RawFinding { id: number; status: FindingStatus; maxSeverity: Severity;
  firstSeenAt: Ms; episodeStartAt: Ms; activeSince: Ms | null; lastSeenAt: Ms; clearedAt: Ms | null; resolvedAt: Ms | null;
  occurrences: number; flapCount: number;
  silenced: { at: Ms; by: string | null; note: string | null; severity: Severity; evidenceCount: number } | null;
  notifiedAt: Ms | null; notifiedSeverity: Severity | null; notifiedEvidenceCount: number | null; }
export interface NotificationIntent { fingerprint: string; findingId: number | null;
  kind: 'opened' | 'escalated' | 'grew' | 'resolved'; severity: Severity; title: string; detail: string; }
```

```ts
// src/shared/types/state.ts  (+ src/server/state/store.ts: getStore() on globalThis, FROZEN after WP0a)
export interface SourceStatus { key: SourceKey; label: string; cadenceMs: number; lastOkAt: Ms | null; lastAttemptAt: Ms | null;
  consecutiveFailures: number; error: string | null; disabled: boolean; }
export interface BotRuntime { botId: BotId; name: string; color: string; config: BotConfigInfo | null; health: BotHealth | null;
  firstFailureAt: Ms | null; lastStatusOkAt: Ms | null; lastTradesOkAt: Ms | null;
  openTrades: BotTrade[]; closedTrades: BotTrade[]; wallet: FtWalletView | null; whitelist: Pair[];
  plotConfig: unknown | null; locks: { pair: Pair; until: Ms; reason: string | null }[]; stats: BotStats | null;
  logTail: { configured: boolean; file: string | null; available: boolean; lastLineAt: Ms | null;
             lastWalletSyncAt: Ms | null; lastHeartbeatAt: Ms | null; error: string | null }; }
export interface KrakenRuntime { status: 'disabled' | 'ok' | 'degraded' | 'error'; statusReason: string | null;
  balances: KrakenBalanceEntry[] | null; balancesAt: Ms | null; openOrders: KrakenOrder[] | null; openOrdersAt: Ms | null;
  feeTier: Record<Pair, { taker: number; maker: number }> | null; permissionDenied: string[];
  backfillComplete: boolean; errors: { kind: string; endpoint: string; since: Ms; message: string }[]; }
export interface AppState { bots: Record<BotId, BotRuntime>; kraken: KrakenRuntime;
  market: { prices: Record<Asset, { usd: number; at: Ms }>; clockSkewMs: number | null };
  account: AccountSnapshot | null; allocation: Allocation | null; sources: Record<SourceKey, SourceStatus>;
  monitor: { startedAt: Ms | null; lastCycleAt: Ms | null; lastEvalAt: Ms | null; rulesEvaluated: number; lastEvalError: string | null };
  notifier: { discord: boolean; lastSentAt: Ms | null; lastError: string | null; consecutiveFailures: number }; }
export interface StateStore { get(): Readonly<AppState>; update(mutator: (draft: AppState) => void): void;
  requestRecheck(): void; onRecheck(cb: () => void): () => void; }
```

```ts
// src/server/checks/types.ts  (WP0a, frozen)
export interface BotCheckView { botId: BotId; name: string; health: BotHealth | null; firstFailureAt: Ms | null;
  lastStatusOkAt: Ms | null; lastTradesOkAt: Ms | null; config: BotConfigInfo | null;
  openTrades: BotTrade[]; closedTrades: BotTrade[]; wallet: FtWalletView | null; whitelist: Pair[];
  logTail: BotRuntime['logTail']; }
export interface KrakenCheckView { balances: KrakenBalanceEntry[]; balancesAt: Ms; openOrders: KrakenOrder[]; openOrdersAt: Ms;
  orders: KrakenOrder[] /* persisted, openedAt >= reconStartAt, merged with openOrders */; backfillComplete: boolean;
  feeTier: Record<Pair, { taker: number; maker: number }> | null; errors: KrakenRuntime['errors']; permissionDenied: string[]; }
export interface CheckInput { now: Ms; cfg: CheckConfig; reconStartAt: Ms; bots: BotCheckView[];
  kraken: KrakenCheckView | null;                    // null => freqtrade-only mode
  prices: Record<Asset, number>;                     // USD, USD=1
  knownOrders: Record<string, { botId: BotId; tradeId: number }>;   // live API orders UNION bot_orders_seen
  events: BotEvent[];        // last 2 h all types + order_created/order_canceled for last 30 d
  acks: Acknowledgement[];   // active only
  clockSkewMs: number | null; notifierFailures: number; }
export type CheckConfig = typeof import('./config').DEFAULT_CHECK_CONFIG;   // numbers only
```

### 5.3 HTTP API contracts (`src/shared/types/api.ts`)

All `/api/v1/*` routes require a session, return `Cache-Control: no-store`, and send errors as `{ error: 'unauthorized'|'forbidden'|'bad_request'|'not_found'|'rate_limited'|'unavailable'|'internal', message?, retryAfterSec? }`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/health` (public) | none | `{ ok: true, version }` |
| POST | `/api/auth/login` (public, same-origin, rate-limited) | `{ username, password, captchaId?, captchaAnswer? }` | 200 `{ mustChangePassword }` + cookie / 401 (`captcha?`) / 429 |
| GET | `/api/auth/captcha` (public, throttled) | none | `{ id, image, expiresAt }` |
| POST | `/api/auth/password` (mutating) | `{ currentPassword, newPassword }` | 204 + new cookie / 400 / 429 |
| POST | `/api/auth/logout` (mutating) | none | 204 |
| GET | `/api/auth/session` | none | `{ name: string\|null, expiresAt: Ms, mustChangePassword }` |
| GET | `/api/v1/sessions` (users only) | none | `SessionsResponse` (the user's live sessions, `current` marked) |
| DELETE | `/api/v1/sessions` (mutating) | none | `{ ended }`: ends every other session of the user |
| DELETE | `/api/v1/sessions/:id` (mutating, owner only) | none | 204 (clears the cookie when it is the current session) |
| GET | `/api/v1/push` (users only) | none | `PushStatusResponse` (VAPID public key, the user's devices) |
| POST | `/api/v1/push/subscriptions` (mutating) | `PushSubscribeBody` | `{ device }` |
| PUT / DELETE | `/api/v1/push/subscriptions/:id` (mutating, owner only) | `{ prefs }` / none | `{ device }` / 204 |
| POST | `/api/v1/push/subscriptions/:id/test` (mutating, owner only) | none | `{ ok, error? }` |
| GET | `/api/v1/summary` | none | `SummaryResponse` (shell: banner, badges, title) |
| GET | `/api/v1/overview` | none | `OverviewResponse` |
| GET | `/api/v1/bots/:botId` | none | `BotDetailResponse` |
| GET | `/api/v1/trades` | `bot?, pair?, status?=open\|closed\|all, since?, limit?=200, offset?` | `TradesResponse` |
| GET | `/api/v1/kraken/orders` | `since?, pair?, match?=all\|unmatched\|matched\|acked, limit?=200` | `KrakenOrdersResponse` |
| GET | `/api/v1/findings` | `status?=active\|silenced\|resolved\|all, severity?, limit?=200` | `FindingsResponse` |
| POST | `/api/v1/findings/:id/silence` (mutating) | `{ note? }` | `{ finding }` |
| POST | `/api/v1/findings/:id/unsilence` (mutating) | none | `{ finding }` |
| GET | `/api/v1/acks` | none | `{ acks: Acknowledgement[] }` |
| POST | `/api/v1/acks` (mutating; triggers `requestRecheck`) | `{ kind, subjects: string[], label, note?, qtyBaseline?: number\|null, expiresAt?: Ms\|null }` | `{ acks }` |
| DELETE | `/api/v1/acks/:id` (mutating) | none | 204 |
| GET | `/api/v1/equity` | `range=24h\|7d\|30d\|90d\|all` | `EquityResponse` (downsampled to <=500 points) |
| GET | `/api/v1/chart` | `bot, pair, tf, limit?=500` | `ChartData` |
| GET | `/api/v1/status` | none | `StatusResponse` |
| POST | `/api/v1/notify/test` (mutating) | none | `{ ok, error? }` |

```ts
export type BotStatusPill = 'running' | 'stale' | 'down' | 'restarting' | 'stopped' | 'auth_error' | 'unknown';
 // auth_error > down(unreachable>=30s) > restarting(startup<2min or loop active) > stale(lastProcess>120s) > stopped(state!=running) > running
export interface FindingLite { id: number; rule: RuleId; severity: Severity; title: string; subject: FindingSubject; activeSince: Ms | null }
export interface SummaryResponse { generatedAt: Ms; mode: 'kraken' | 'freqtrade-only'; modeReason: string | null;
  monitor: { startedAt: Ms | null; lastCycleAt: Ms | null; lastEvalAt: Ms | null; stalled: boolean /* lastCycleAt older than 60s */ };
  findings: { critical: number; warning: number; info: number; silenced: number; top: FindingLite | null };
  accountTotalUsd: number | null; accountFreshness: Freshness | null;
  bots: { botId: BotId; name: string; color: string; status: BotStatusPill }[]; }
export interface BotCard { botId: BotId; name: string; color: string; status: BotStatusPill; config: BotConfigInfo | null;
  health: BotHealth | null; stats: BotStats | null; uptimeSince: Ms | null; restarts24h: number; sources: SourceKey[] }
export interface OverviewResponse { generatedAt: Ms; mode: SummaryResponse['mode']; modeReason: string | null;
  account: AccountSnapshot | null; allocation: Allocation | null;
  change24h: { usd: number; pct: number; netFlowsUsd: number | null } | null;
  walletViews: { botId: BotId; usd: number | null; totalUsd: number | null; syncedAt: Ms | null }[];
  bots: BotCard[]; openPositions: BotTrade[];
  combined: { realizedUsd: number; unrealizedUsd: number; totalUsd: number; openCostBasisUsd: number; feesUsd: number; roiOnStake: number | null };
  findings: { counts: { critical: number; warning: number; info: number }; top: FindingLite[] }; sources: Freshness[]; }
export interface BotDetailResponse { generatedAt: Ms; bot: BotCard; openTrades: BotTrade[]; recentClosed: BotTrade[];
  perPair: { pair: Pair; closedTrades: number; realizedUsd: number; roiOnStake: number | null; openQty: number }[];
  events: BotEvent[]; whitelist: Pair[]; locks: BotRuntime['locks']; wallet: FtWalletView | null; sources: Freshness[] }
export type OrderMatch = 'matched' | 'missing' | 'mismatch' | 'unknown';   // 'unknown' in freqtrade-only mode
export interface TradesResponse { generatedAt: Ms; trades: (BotTrade & { krakenMatch: Record<string, OrderMatch> })[];
  total: number; totals: { realizedUsd: number; unrealizedUsd: number; feesUsd: number }; sources: Freshness[] }
export interface KrakenOrdersResponse { generatedAt: Ms; enabled: boolean; orders: (KrakenOrder & {
  match: { botId: BotId; tradeId: number } | null; ack: Acknowledgement | null; createdByBotLog: BotId | null })[]; sources: Freshness[] }
export interface FindingsResponse { generatedAt: Ms; findings: Finding[];
  counts: { critical: number; warning: number; info: number; silenced: number; resolved24h: number };
  engine: { lastEvalAt: Ms | null; rules: number; mode: SummaryResponse['mode'] } }
export interface EquityResponse { generatedAt: Ms; points: { t: Ms; totalUsd: number; usdCash: number; source: 'kraken' | 'bot-wallet' }[];
  flows: KrakenFlow[] | null; flowsAvailable: boolean; change: { usd: number; pct: number; netFlowsUsd: number | null } | null }
export interface StatusResponse { generatedAt: Ms; version: string; startedAt: Ms; mode: SummaryResponse['mode']; modeReason: string | null;
  kraken: { configured: boolean; status: KrakenRuntime['status']; reason: string | null; permissionDenied: string[];
            backfillComplete: boolean; reconStartAt: Ms | null; tier: string };
  sources: Freshness[]; logTails: { botId: BotId; file: string | null; configured: boolean; available: boolean; lastLineAt: Ms | null; error: string | null }[];
  notifier: AppState['notifier']; db: { sizeBytes: number; findings: number; krakenOrders: number; equityPoints: number };
  clockSkewMs: number | null }
```

---

## 6. Upstream adapters

### 6.1 Freqtrade (GET-only allowlist)
Allowlisted paths: `health, ping, show_config, status, trades, balance, whitelist, locks, logs, plot_config, pair_candles` (all under `/api/v1/`). Every request has a timeout via `AbortSignal.timeout(8000)`. Error kinds are `network|timeout|auth(401/403)|http|parse`.

### 6.2 Log ingestion
* **Parser regex:** `^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3}) - (\S+) - (DEBUG|INFO|WARNING|ERROR|CRITICAL) - (.*)$`. Parse with `Date.UTC`. Non-matching lines are continuations of the previous record. Keep a partial trailing line as `carry`.
* **Event extraction** (DEBUG records are skipped first; every message goes through `redactSecrets`):

| Event | Match |
|---|---|
| `startup` | logger `freqtrade.loggers` and message `Logfile configured` |
| `fatal` | logger `freqtrade`, ERROR, `^Fatal exception`. `message` = last continuation line (e.g. `ValueError: ...`) |
| `process_died` | `Sending rpc message: .*'process died'` |
| `order_created` | `^Order (O[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}) was created for (\S+) and status is (\w+)`. Enriched with price/stake from the last `Long signal found: about create a new trade for (\S+) with stake_amount: ([\d.]+) and price: ([\d.]+)` seen for the same pair within 5 s |
| `order_failed` | WARNING/ERROR `^Unable to create trade for (\S+): (.*)` |
| `order_canceled` | INFO/WARNING containing a txid and matching `/cancel|timeout/i` |
| `error` | any other ERROR/CRITICAL |

  The parser also tracks, in state only: `Wallets synced.` gives `lastWalletSyncAt`, and `^Bot heartbeat\. PID=\d+, version='([^']+)', state='(\w+)'` gives `lastHeartbeatAt`.
* **Tailer:** polls every 5 s with `fs.stat` + positional reads (no inotify on Docker Desktop bind mounts). Cursor = `{file, headHash: sha1(first 256 bytes), offset}`. Rotation is detected when the head hash changes or size < offset. On rotation, finish `<file>.1` from the old offset, then read the new file from 0. First run (no cursor): read rotated files `.N..1` whose mtime is within `LOG_BACKFILL_HOURS`, plus the current file. Events are persisted with an idempotent `fingerprint`. Reads are capped at 4 MB per poll.
* **Fallback:** if no logfile is configured or it is unreadable, poll `/logs?limit=1000` every 20 s and emit a `LOG_TAIL_UNAVAILABLE` warning.

### 6.3 Kraken
* **Signing:**
  ```ts
  sign(path, body, nonce, secretB64) = base64(
    HMAC_SHA512(key = base64decode(secret),
                msg = Buffer.concat([utf8(path), sha256(utf8(nonce + body))])))
  ```
  Requests are POSTs with `application/x-www-form-urlencoded`. The body string sent must be byte-identical to the signed string. Headers: `API-Key`, `API-Sign`. The unit test uses the docs' published test vector (path `/0/private/AddOrder`, nonce `1616492376594`, expected `4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==`). Only `sign()` is tested with that path; the client itself still refuses AddOrder.
* **Allowlist:** `Balance, BalanceEx, OpenOrders, ClosedOrders, QueryOrders, TradeVolume, Ledgers`. Any other method throws at both type level and runtime.
* **Nonce:** `max(Date.now(), last+1)`, persisted in `meta.kraken_nonce` before each send. All private calls go through **one serial queue**, so nonces reach Kraken in order.
* **Rate limiter:** mirrors Kraken's per-key counter. Starter: max 15, decay 0.33/s. Intermediate: 20 / 0.5. Pro: 20 / 1. Ledgers costs 2, everything else 1. Keep a 3-point reserve. On `EAPI:Rate limit exceeded` or `EService:Throttled`, back off 30 s, doubling up to 5 min.
* **Error classes:** `EAPI:Invalid key` and `EAPI:Invalid signature` are `auth`. `EGeneral:Permission denied` is `permission`. `EAPI:Invalid nonce` is `nonce` (bump the nonce and retry once). Rate-limit errors are `ratelimit`. `EService:Unavailable|Busy` are `unavailable`. Fetch errors are `network`.
* **Cadence and budget:**

| Call | Cadence | Cost |
|---|---|---|
| OpenOrders | 15 s | 1 |
| BalanceEx | 30 s (fall back to Balance if denied) | 1 |
| ClosedOrders incremental: `closetime=close`, `start=cursor-600`, `ofs` pages of 50 | 30 s | 1/page |
| QueryOrders (<=50 txids: log-created unknown ids, missing bot ids) | on demand, at most 1/min | 1 |
| TradeVolume (`pair=XBTUSD,ETHUSD`, percent to fraction) | 6 h | 1 |
| Ledgers `type=deposit` and `type=withdrawal` | 30 min | 2 each |

  That is about 8.3 cost/min = 0.14/s, roughly 40% of Starter decay. The key is separate, so the bots' limits are unaffected.
* **Backfill:** on the first run, page `ClosedOrders start=reconStart` until `count` is reached, then set `meta.kraken_backfill_complete`.
* **Asset catalog** (public `Assets` + `AssetPairs`, refreshed every 24 h): strip suffixes `.F`→earn, `.S/.M/.B`→staked, `.T/.HOLD`→other. Static aliases `XXBT|XBT→BTC, XETH→ETH, ZUSD→USD, XXDG|XDG→DOGE, ZEUR→EUR`. The pair map covers key, altname and wsname (e.g. `XBTUSD`→`BTC/USD`).
* **Prices:** public `Ticker` (`c[0]`) every 20 s for every held asset that has a `<ASSET>/USD` pair. This works without a key.
* **Clock:** public `Time` every 10 min gives `clockSkewMs`.

### 6.4 Poller job table (`src/shared/constants.ts`)

| Job | Cadence | Notes |
|---|---|---|
| ft.health (per bot) | 10 s | reachability, restart diff (emits `startup`), `bot_start_ts` change (emits `identity_changed`) |
| ft.status | 15 s | open trades; upsert `bot_orders_seen` |
| ft.trades | 60 s, plus immediately when a trade leaves `/status` or a new `order_created` event arrives | paginate `limit=500` |
| ft.balance | 60 s | bot wallet view |
| ft.config / whitelist / plot_config / locks | 5 / 10 / 10 / 5 min, plus on startup change | |
| logtail | 5 s | new unknown `order_created` triggers ft.status + QueryOrders |
| market.ticker / time / catalog | 20 s / 10 min / 24 h | public |
| checks.evaluate | debounced 2 s after any state change, at least every 10 s | writes findings, dispatches notifications |
| equity.snapshot | 5 min | Kraken source, else bot-wallet estimate |
| signals.record | 5 min per bot x pair | `pair_candles?limit=3`; upsert last closed row's signals into `signal_history` |
| maintenance | 6 h | pruning |

Every job is single-flight, uses a setTimeout chain with ±10% jitter, and backs off on failure (`cadence * 2^n`, capped at 5 min). Each job updates its `SourceStatus`.

---

## 7. Accounting (pure, `src/server/accounting`)

For a trade, count only orders with `filled > 0`:
* `entryQty = Σ entry filled`, `entryCost = Σ entry filled*price`, `exitQty` and `exitProceeds` likewise for exits.
* `feeOpen = feeOpenCost ?? entryCost*feeOpenRate ?? 0`. `feeClose = feeCloseCost ?? exitProceeds*feeCloseRate ?? 0`.
* `costBasis = entryCost + feeOpen`.
* `realized = exitProceeds - costBasis*(exitQty/entryQty) - feeClose`.
* `openQty = entryQty - exitQty`.
* `unrealized = openQty*mark*(1 - (feeCloseRate ?? feeOpenRate ?? 0.004)) - costBasis*(openQty/entryQty)`. Mark price is the Kraken ticker, else the bot's `current_rate`.
* `total = realized + unrealized`. `roiOnStake = total / costBasis`.

Freqtrade's `profit_*_percent`, `starting_capital*` and `/profit` ratios are never used. These values match freqtrade's `profit_abs` (the tests must assert ±0.0001): votemax trade 1 = +2.60846, dca trade 2 = −0.50966, votemax open trade 8 at 83414.5 = −0.31006.

Bot stats:
* `roiOnStake = Σ realized / Σ closed costBasis` (return per dollar deployed).
* `peakConcurrentStake` comes from a sweep over per-order events: an entry fill adds its cost at `filledAt`, an exit removes it proportionally.
* `returnOnPeakStake = (realized + unrealized) / peak`.
* `winRate = wins / closed`, where a win is `realized > 0`.

Account figures:
* **Account total (Kraken mode)** = Σ over holdings (all wallets) of qty × USD price; USD counts at 1. Unpriced assets are listed and excluded.
* **Freqtrade-only mode:** use quantities from the bot wallet with the latest `lastWalletSyncAt` (from log tail), else the latest `fetchedAt`, valued at fresh public prices. Label it "estimated from <bot> wallet (synced X ago)".
* **Allocation:** usdCash + Σ bot positions (openQty × price) + acknowledged holdings + untracked + dust = total, within ±$0.01 (invariant test).
* **Equity history:** 5-min snapshots.
* **24h change:** the snapshot nearest now−24h (±10 min). Net flows come from Ledgers when available; otherwise flows are null and the UI adds a caveat.

---

## 8. Checks engine (pure: `evaluate(input): RawFinding[]`, then `applyLifecycle(prev, raw, now, cfg)`)

### 8.1 Rules (defaults in `src/server/checks/config.ts`, owned by WP3)

| Rule | Needs | Condition (exact) | Severity | Timing | Fingerprint / grouping |
|---|---|---|---|---|---|
| BOT_UNREACHABLE | ft | health failing (network/timeout/5xx) since `firstFailureAt`, with `now-firstFailureAt >= 30s` | warning; critical once >= 180 s | clear 30 s | `:{bot}` |
| BOT_AUTH_FAILED | ft | `health.authFailed` | critical | clear 60 s | `:{bot}` |
| BOT_STALE_PROCESS | ft | reachable and `now-lastProcessAt > 120s` | warning; critical > 600 s | clear 30 s | `:{bot}` |
| BOT_NOT_RUNNING | ft | `config.state !== 'running'` | warning | min 60 s | `:{bot}` |
| BOT_RESTARTED | ft/logs | >= 1 distinct startup in last 30 min (startup events clustered within 10 s) | info | window | `:{bot}` |
| BOT_RESTART_LOOP | ft/logs | >= 3 distinct startups in last 15 min | critical | window (15 min quiet clears it) | `:{bot}` |
| BOT_IDENTITY_CHANGED | ft | `identity_changed` event in last 24 h (bot_start_ts changed, or closed-trade count decreased) | critical | window | `:{bot}` |
| BOT_FATAL_LOG | logs | `fatal` or `process_died` event in last 60 min | critical | window | `:{bot}`, evidence count and last message |
| BOT_ERROR_LOG | logs | `error` or `order_failed` events in last 30 min, grouped by signature (digits/hex/txids stripped, first 120 chars) | warning | window | `:{bot}:{sigHash}` |
| UNPERSISTED_ORDER | logs | `order_created` event with txid not in `knownOrders`, not acked, `now-at >= 60s`, and **the bot's `lastStatusOkAt` and `lastTradesOkAt` are both > at + 5 s** | critical if any order < 24 h old and not zero-fill-canceled (per Kraken or an `order_canceled` event); warning if all older; info if all zero-fill-canceled | clears when all ids are known or acked | `:{bot}:{pair}`, evidenceKeys = txids, evidence `{orders:[{orderId,at,price,stakeUsd,krakenStatus?,volExec?}],count,totalStakeUsd}` |
| ORPHAN_KRAKEN_ORDER | kraken | Kraken order with `openedAt >= reconStartAt`, txid not in `knownOrders` and not acked, `now-openedAt >= 60s`, (`open`/`pending` **or** `volExec > 0`), and every reachable bot has `lastStatusOkAt > openedAt + 5s` (bots down > 5 min are ignored for this gate) | critical if any open or opened < 7 d ago; else warning | clears when all known/acked | `:{pair}`, evidenceKeys = txids, evidence includes `createdByBot` from matching log events |
| BOT_ORDER_MISSING_ON_KRAKEN | kraken | backfill complete; bot order with `filled > 0`, `reconStart + 1h <= placedAt <= now - 10 min`, not in Kraken orders even after QueryOrders | warning | none | `:{bot}:{orderId}` |
| ORDER_MISMATCH | kraken | matched order with `abs(bot.filled - volExec) > max(1e-7, 0.002*vol)`, or bot says open while Kraken says closed/canceled | warning | min 120 s | `:{orderId}` |
| ORDER_STORM | ft/logs/kraken | distinct order attempts per pair in last 10 min (union of Kraken `openedAt`, `order_created`, `order_failed` and bot `placedAt`) >= 4 | warning (>= 4), critical (>= 6) | window | `:{pair}` |
| FEE_ANOMALY | kraken or ft | Per filled order. (a) Kraken rate `fee/cost > expectedTaker*1.25 + 0.0005` (expected from TradeVolume, else 0.004). (b) Bot fee rate for that side is null. (c) `abs(botRate - krakenRate) > 0.0010`. (d) Freqtrade-only: bot rate > 0.006 or < 0. | warning; **info** when filled > 30 d ago | none | `:{bot}:{tradeId}:{side}` |
| UNTRACKED_HOLDING | kraken (or bot-wallet estimate) | per asset other than USD, summing all wallets: `untracked = total - Σ openQty(open trades with base==asset) - ackBaseline` (ack with null baseline covers any amount); value = untracked × price; ignored below $1 | critical if the asset is traded by a bot (base of any whitelist pair), value >= $25 and source is Kraken; warning if value >= max($5, 0.5% equity); bot-wallet source is capped at warning; unpriced gives info | min 90 s, clear 90 s | `:{asset}` |
| BOT_OVERCLAIMS_HOLDING | kraken | `Σ openQty - total > max(1e-7, 0.002*Σ openQty)` | critical | min 90 s, clear 90 s | `:{asset}` |
| USD_VIEW_DRIFT | kraken ref (ft-only: compare bots pairwise) | `abs(botWalletUSD - refUSD) > max($2, 1%)` | info, escalating to warning after 75 min | clear 5 min | `:{bot}` |
| KRAKEN_ERROR | kraken | auth gives critical; permission denied on a required endpoint (Balance/BalanceEx/OpenOrders/ClosedOrders) gives warning, on an optional one (Ledgers/TradeVolume) gives info; nonce/ratelimit/unavailable/network continuing >= 2 min gives warning | as stated | clear 60 s | `:{kind}:{endpoint}` |
| CLOCK_SKEW | public | `abs(skew) > 5s` | warning; critical > 30 s | clear 10 min | `CLOCK_SKEW` |
| LOG_TAIL_UNAVAILABLE | logs cfg | configured but unavailable, or bot reachable with no new line for > 5 min (a heartbeat arrives every 60 s) | warning | min 60 s | `:{bot}` |
| NOTIFIER_FAILING | notify | >= 3 consecutive failures | warning (in-app only) | none | `NOTIFIER_FAILING` |

"Monitoring stalled" is not a rule. `/api/v1/summary` sets `monitor.stalled` when the last cycle is older than 60 s, and the UI shows a red banner.

### 8.2 Lifecycle (dedup / flapping / silence / notify), pure

1. Match raw findings to existing `pending`/`active` rows by fingerprint. If none exists, reopen a `resolved` row with the same fingerprint when `resolvedAt >= now - 30 min` (`flapCount += 1`, `occurrences += 1`, `episodeStartAt = now`). Otherwise create a new row. Status becomes `pending` when `minDurationMs > 0`, else `active`.
2. For matched rows: set `lastSeenAt = now`, `clearedAt = null`, and update severity, title, detail and evidence. Set `maxSeverity = max`. Promote pending to active when `now - episodeStartAt >= minDurationMs`. If `escalateAfterMs` is set and `now - activeSince >= escalateAfterMs`, severity becomes `max(severity, escalateTo)`.
3. For rows absent from raw: set `clearedAt` if unset. Pending rows resolve immediately and are never shown or notified. Active rows resolve when `now - clearedAt >= clearAfterMs`.
4. Silence: set by a user action. It is **auto-lifted** if severity rises above `silenced.severity`, or if `evidenceKeys.length > silenced.evidenceCount`.
5. Notifications (active, not silenced, severity >= `NOTIFY_MIN_SEVERITY`):
   * `opened`: critical immediately. Warning only once active for 5 min. A reopen within 30 min of the last notification of the same fingerprint does not notify again.
   * `escalated`: severity rose above `notifiedSeverity`.
   * `grew`: `evidenceKeys` grew and the last notification is more than 10 min old (coalesced, e.g. "25 orders (was 3)").
   * `resolved`: only for findings that were notified at critical.
6. **Dispatcher:** max 5 messages/min per channel. Multiple intents are batched into one Discord message (up to 10 embeds). Messages are prefixed `[freqdash]`. It is recommended to use a separate Discord channel from the bots' own webhook. A `freqdash started` message is sent on boot.
   **Web Push** (VAPID, `src/server/push/`) is a third channel: RFC 8291 `aes128gcm` encryption and RFC 8292 VAPID JWTs with `node:crypto`, sent only to the browsers' push services (FCM, Mozilla, Apple, WNS; any other endpoint is refused). Each device (`push_subscriptions`) has its own preferences: buys, sells, findings from a chosen severity, resolved findings, system messages. Killswitch alerts go to every device. Buys are filled bot entry orders and sells are closed trades, detected from the trades the poller already fetches and announced once (`push_trade_events`), never replaying history from before the first start or older than 6 h. Gone subscriptions (404/410) are deleted; at most 30 messages/min per device.

**Detection latency budget (incident class):**

| Signal | Latency |
|---|---|
| Fatal log | <= 10 s |
| Restart loop | ≈ 40 s after the first crash |
| Unpersisted order | <= 70 s |
| Orphan Kraken order | <= 80 s |
| Order storm | ≈ 90 s |
| Untracked ETH | <= 2.5 min |

### 8.3 Flagship regression test: `src/server/checks/incident.regression.test.ts`

**Fixture (WP0b):**
* `test/fixtures/raw/incident/timeline.json`: events parsed from the real log. 26 `entry_signal` (with price and stake), 25 `order_created` (real txids, first `OX2D7A-ROVIF-A3YVZW` at 1790568007965, last `OJ6DEM-PMOHZ-XDLFQB` at 05:14:12.349), 1 `order_failed` (InvalidNonce at 04:03:59.96), plus about 25 each of `process_died`, `fatal` and `startup`.
* `kraken/private` incident files: `ClosedOrders.incident.json` has the 25 logged orders (`vol = stake/price`, 8 dp, `status=closed`, `vol_exec = vol`, `cost = vol*price`, `fee = cost*0.004`, `opentm` = log time, `closetm = opentm + 30s`). It also has one Kraken-only order **`OWDY2Z-TVWRN-IJBALL`** (no log line; its vol makes Σ = 0.1130240889 − 8.9e-9), plus all sample bot orders, plus the acked manual SHIB order `OYYVFI-FJISQ-5N6DW5` and a zero-fill canceled unknown order `O5GCGD-X5FJN-JFUFDO`. `BalanceEx.after.json` has XETH 0.1130240889.

**Scenario builder (WP3, `test/fixtures/incident/scenario.ts`):** takes `{withKraken, withLogs}` and yields `CheckInput` every 5 s from 03:59:00 to 06:20:00 UTC:
* The bot is unreachable within [fatal − 0.3 s, startup + 2 s]. `botStartupAt` follows startups; health is sampled at 10 s.
* The bot never knows the orphan txids.
* Kraken open orders include each order from creation until its `closetm`. Balances accumulate fills.
* SHIB is acked; BABY is dust.

Each step runs `evaluate` then `applyLifecycle` (with an in-memory prev). The test collects findings and notifications.

**Variant A (Kraken + logs + health):**
1. Before 04:00:07.965 there are no warning/critical findings.
2. `BOT_FATAL_LOG:votemax` is critical by 04:00:15.
3. `BOT_RESTART_LOOP:votemax` is critical by 04:00:50.
4. `UNPERSISTED_ORDER:votemax:ETH/USD` is critical by 04:01:10. Its final evidence count is 25, and **exactly one row** exists for that fingerprint over the whole run.
5. `ORPHAN_KRAKEN_ORDER:ETH/USD` is critical by 04:01:15. Its final evidence count is **26** (proves the Kraken check catches the order with no log line), and `createdByBot === 'votemax'` for 25 of them.
6. `ORDER_STORM:ETH/USD` is critical by 04:01:45.
7. `UNTRACKED_HOLDING:ETH` is critical by 04:03:30.
8. Across the run there are **<= 12 notifications**, <= 3 per fingerprint, and none at info level.
9. At 05:31, RESTART_LOOP is resolved. At 06:16, FATAL_LOG is resolved. UNPERSISTED, ORPHAN and UNTRACKED stay active (sticky). After adding acks for all 26 txids and an ETH asset ack (baseline = current qty), all three resolve within 90 s.

**Variant B (freqtrade-only):** checks 2, 3, 4 and 6 hold. No Kraken rules fire. `UNTRACKED_HOLDING:ETH` comes from the bot-wallet source (dca view) and is capped at warning.

**Variant C (health only):** RESTART_LOOP is critical by 04:01:10, and **no** BOT_UNREACHABLE (outages < 30 s).

**Variant D (flapping):** health alternating every 10 s for 10 min produces no BOT_UNREACHABLE. Six 45-second outages spaced 5 min apart produce one row with `flapCount >= 2` and <= 2 notifications.

---

## 9. UI spec

**Global.**
* **Theme:** dark tokens in Tailwind v4 `@theme`: bg `#0B0D12`, surface `#12151C`, surface-2 `#181C25`, border `#232838`, text `#E6E8EE`, muted `#8A93A6`, accent `#4F8CFF`, positive `#2EBD85`, negative `#F6465D`, warning `#F5A524`, critical `#E5484D`, info `#3E63DD`. Bot colors come from env.
* **Type:** system-ui font stack. All numbers use `tabular-nums`. USD shows 2 dp; crypto quantities up to 8 dp, trimmed. Signs are colored. Severity is always shown as icon + text, never color alone.
* **Freshness:** every number from a bot or Kraken is rendered via `<Metric value sources={[...]}>`, which shows a `FreshnessDot`. The worst state wins: green = fresh, amber = aging/stale, red = error, grey = disabled. Hover (desktop) or tap (mobile) shows a popover with "Kraken balance · 12 s ago" and any error. Stale values stay visible but muted, with an "as of 14:32" label.
* **Top bar:** a monitor indicator ("Live · checked 4s ago", or red "Monitoring stalled"), a mode badge (Kraken, or amber Freqtrade-only), and a user menu (name, logout).
* **Tab title:** `(2) freqdash` counts critical + warning findings.
* **PWA:** manifest (standalone, dark theme-color) and an apple-touch-icon, so it can be added to the phone home screen. No service worker in v1.

**Shell.**
* **Desktop (lg and up):** 240 px left sidebar (Overview, Chart, Trades, Findings + badge, Bots: VoteMax/DCA with status dots, Status). Sticky findings banner below the top bar.
* **Mobile:** top app bar (title, monitor dot, refresh button). **Bottom tab bar** with Overview, Chart, Trades, Alerts (badge) and More (sheet: Bots, Status, Logout). Respect `env(safe-area-inset-bottom)`; tap targets at least 44 px. The findings banner is a slim bar under the app bar that opens `/findings` on tap.
* **Banners:** critical is red and sticky: "2 critical: Orphan Kraken orders on ETH/USD (26 · $293.70)". Warnings are amber. The freqtrade-only banner is amber-outline: "No Kraken key: totals are estimated from bot wallet caches (may be ≤1h stale); Kraken order reconciliation disabled. Status → Kraken setup". It can be dismissed for 24 h via localStorage; the badge stays.

**Pages.**

| Page | Desktop | Mobile |
|---|---|---|
| Overview `/` | Row 1: Account card (hero total, 24h change, mode/source label, a "wallet views" popover showing Kraken USD vs each bot's cached USD with sync age) [4 cols] + Allocation stacked bar (USD cash, VoteMax, DCA, Manual, **Untracked striped red**, dust) [8]. Row 2: Equity chart (lightweight-charts area; 24h/7d/30d/All; deposit/withdraw markers; dashed where source is bot-wallet) [8] + findings summary with "all clear: checks ran 8 s ago · 22 rules" [4]. Row 3: two bot cards (status pill, uptime, last process age, open x/max, realized/unrealized/total, ROI on stake, return on peak stake, fees, restarts 24h). Row 4: open positions table (bot, pair, qty, avg entry, mark, value, uPnL $/%, age, entries). Row 5: holdings table (asset, qty, price, value, attributed to, status chip, "Label…" action). | Stack: hero total card, findings card (if any), compact allocation bar with a 2-column legend, bot cards, open positions as cards, holdings list, equity chart (180 px, range chips). |
| Bot `/bots/[botId]` | Header (name, strategy, tf, state pill, version, uptime, restarts, "Open chart"). Stats grid. Open trades with expandable orders (Kraken match icons). Recent closed (20). Per-pair table. Events timeline (startup, fatal, order_created, errors). Data-source freshness. | In-page tabs: Summary / Trades / Events. |
| Chart `/chart?bot&pair&tf&o&p&focus` | Toolbar: bot select, pair select (whitelist), tf segmented control (strategy tf "4h · signals" plus Kraken price-only 15m/1h/1d), range 1W/1M/3M/All, "Layers" popover (overlays from plot_config main_plot; panes from subplots + Volume; toggles for Signals, Fills, Other bot's fills, Orphans). Main pane uses `calc(100vh - header - toolbar)`, subpanes are 120 px. Top-left legend shows OHLC + visible indicator values at the crosshair. Click a candle to open a right side panel with that candle's signals, fills (order id, qty, price, fee, trade link) and trades. | Compact toolbar (bot and pair chips, tf segmented, Layers button opening a bottom sheet). Main pane 52vh (min 260 px). Subpanes 96 px, **max 2 enabled** (a toast explains). One-line OHLC legend. Tap a candle to open a bottom sheet. |
| Trades `/trades` | Filters (bot, pair, status, date, tag). Tabs "Bot trades" (expandable orders with Kraken match status) and "Kraken orders" (all, unmatched, acked; with the bot/trade matched or the log attribution). Row link "Show on chart" (`focus=`). | Filter chips in a sheet. Card list. Detail in a bottom sheet. |
| Findings `/findings` | Tabs Active / Silenced / Resolved. Rows show severity, title, subject chips, first/last seen, duration, occurrences and flap count. The right drawer shows detail, evidence table (orders with Kraken data), and a per-rule "what to do" runbook text (`src/shared/runbook.ts`). Actions: Silence (note), Unsilence, **Mark orders manual/ignored** (bulk, pre-filled from evidenceKeys), **Mark holding manual** (qty baseline pre-filled). Footer shows engine health. | Full-screen sheet for detail. Sticky action bar. |
| Status `/status` | Data sources table (freshness, failures, redacted last error). Kraken panel (mode, permission probe results, backfill, recon start, **setup guide**: exact permissions, "never reuse the bots' key"). Log tails. Notifier (configured, last sent, test button). Acknowledgements list with revoke. App info (version, uptime, DB size, clock skew). Prefs (times in UTC toggle). Logout. | Stacked sections. |

**Chart implementation details.**
* **Setup:** lightweight-charts is loaded via `dynamic(() => import('./PriceChart'), { ssr: false })` inside a client component. `createChart(el, { autoSize: true, layout: { background: { color: 'transparent' }, textColor, panes: { separatorColor } }, timeScale: { timeVisible: true, rightOffset: 3 }, crosshair: { mode: Normal }, localization: { timeFormatter: local-or-UTC }, handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }, handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: true }, kineticScroll: { touch: true }, trackingMode: { exitMode: OnNextTap } })`.
* **Series:** candles in pane 0. Overlays are `LineSeries` (support/resistance use `lineType: WithSteps`, dashed). Each subplot is one pane, with constant threshold columns drawn as `createPriceLine` (dashed). Volume is a histogram in its own pane, off by default on mobile. The live forming candle (from Kraken OHLC) uses muted per-bar colors.
* **Markers:** created via `createSeriesMarkers(candles, sortedMarkers)`.
  * Enter signal: `circle` `belowBar` green.
  * Exit signal: `circle` `aboveBar` red.
  * Entry fill: `arrowUp` `atPriceBottom` at the fill price, bot color.
  * Exit fill: `arrowDown` `atPriceTop`, bot color; text shows realized % (desktop only).
  * Kraken orphan fill: `square` `atPriceMiddle` `#E5484D`, text `?`.
  * Marker time = `floor(sec / tfSec) * tfSec`. Fills beyond the last candle attach to the live candle.
* **Server-side chart builder:** caches `pair_candles?limit=1000` per bot/pair with single-flight. It refetches when `now >= dataStop + 2*tf + 30 s`, with a 5 min TTL, and never more than once per minute. Signals come from dataframe signals unioned with `signal_history`. `signalsNote` is set for DcaBot: "DcaBot marks signals only on the latest candle; earlier markers are those recorded live by freqdash since <date>". Indicator placement comes from `plot_config`. Fallback registry: ema* → main line; support*/resistance* → main step (only `_4h` visible by default); rsi → RSI pane; *score → Score pane; *threshold/rsi_ob/rsi_os → threshold; volume → Volume pane; other numeric → "Other" pane, hidden; booleans become 0/1; `rsi_prev`, `__date_ts` and `_*_signal_close` are dropped.
* **Test hook:** `data-testid="price-chart" data-candles data-fills data-signals` on the container.

**States.**
* Loading: skeletons on first load only, with `placeholderData: keepPreviousData` afterwards.
* API error: an inline error card with retry, keeping last data visible and marked "offline since HH:MM".
* Empty: "No open positions", "No findings: all 22 checks passing, last run 5 s ago", and for Kraken orders "Kraken key not configured → setup".

---

## 10. Work packages

**Rules for all WPs.**
* Only the listed files may be edited.
* `package.json`/lockfile are edited by WP0a and WP14 only. The exception is WP6, which may add UI deps in Phase 1. Anyone else lists needed deps in their handoff.
* Tests are colocated (`*.test.ts`).
* Each WP ends with `npm run verify` on the host (Node 22). Before handoff it also runs `docker compose -f compose.dev.yaml run --rm tools sh -c "npm ci && npm run verify"`.
* Suggested: WP0a runs `git init`, and each WP makes one local commit `WPn: …` (no remote).

**Parallelism.**

| Phase | WPs (run in parallel within a phase) | Gate to next phase |
|---|---|---|
| 0 | **WP0a** Scaffold & contracts · **WP0b** Fixture capture (URGENT) | both merged |
| 1 | WP1 Freqtrade + logs · WP2 Kraken · WP3 Checks + accounting · WP4 SQLite · WP5 Auth · WP6 UI foundation · WP7 Mock upstreams | all merged |
| 2 | WP8 Poller + notify · WP9 Views + API routes · WP10 Overview + Bot pages · WP11 Trades/Findings/Status pages · WP12 Chart | all merged |
| 3 | WP13 E2E (Playwright), then WP14 Deploy, hardening & live smoke (integrator, may touch any file) | done |

---

### WP0a: Scaffold and shared contracts
* **Goal:** a buildable Next 16 skeleton with every shared contract, config, logging/redaction, the state store, mock API routes, tooling and Docker.
* **Owns:** `package.json`, `package-lock.json`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`), `next.config.ts`, `eslint.config.mjs`, `.prettierrc`, `vitest.config.ts` (node env; coverage thresholds 90% for `src/server/checks/**` and `src/server/accounting/**`), `postcss.config.mjs`, `.gitignore`, `.dockerignore`, `.env.example`, `.env.dev.example` (points to mock upstreams at `http://localhost:9999`, `POLLER_ENABLED=false`, dev password/secret), `Dockerfile`, `compose.yaml`, `compose.dev.yaml`, `README.md`, `src/shared/types/{domain,findings,api,state}.ts` (verbatim from §5), `src/shared/constants.ts` (§6.4 cadences, freshness multipliers), `src/server/checks/types.ts`, `src/server/config.ts`, `src/server/log.ts`, `src/server/state/store.ts`, `src/server/mock/responses.ts`, minimal `src/app/layout.tsx` + `globals.css`, placeholder pages for all `(app)` routes, `src/app/api/health/route.ts`, and mock handlers for every `/api/v1/*` route in §5.3 (no auth yet).
* **Dependencies to install:** `next@16 react@19 react-dom@19 typescript @types/node @types/react @types/react-dom tailwindcss@4 @tailwindcss/postcss zod better-sqlite3 @types/better-sqlite3 server-only @tanstack/react-query lightweight-charts@5 lucide-react clsx tailwind-merge class-variance-authority vaul vitest @vitest/coverage-v8 happy-dom @playwright/test eslint eslint-config-next typescript-eslint eslint-config-prettier prettier`.
* **Scripts:** `dev, build, start, typecheck (tsc --noEmit), lint (eslint .), format, test (vitest run), coverage, verify (typecheck && lint && test), mock (node test/mock-upstreams/server.mjs), e2e (playwright test), shot (node scripts/shot.mjs)`.
* **`config.ts`:** zod-parses env into `AppConfig`, scanning `FT_BOT_1..10`. It fails with a list of missing or invalid variable names and never prints values. Kraken key and secret must be both set or both empty, and the secret must base64-decode to 64 bytes. Enforces `DASHBOARD_PASSWORD` >= 12 and `SESSION_SECRET` >= 32. Warns if `KRAKEN_API_BASE_URL` is not the default.
* **`log.ts`:** JSON-line logger plus `redactSecrets(text)`. Patterns: `/api/webhooks/\d+/[\w-]+`, `eyJ[\w-]+\.[\w-]+\.[\w-]+`, `token=[^&\s"']+`, `(Authorization|API-Sign|API-Key):\s*\S+`, plus the exact values of all configured secrets.
* **Acceptance:**
  * `npm run verify` is green. A `redactSecrets` test covers each pattern. A config test covers valid, missing and weak-password cases.
  * `docker build -t freqdash:dev .` succeeds. Running it with dummy env and `POLLER_ENABLED=false` gives a JSON response from `curl -s localhost:8043/api/health`.
  * `grep -r "NEXT_PUBLIC_" src` is empty.
* **Verify:** `npm ci && npm run verify`; `docker build -t freqdash:dev .`; `docker run --rm -d --name fdtest -p 8043:3000 --env-file .env.dev.example -e POLLER_ENABLED=false freqdash:dev && curl -s localhost:8043/api/health && docker rm -f fdtest`.

### WP0b: Fixture capture (URGENT, parallel with WP0a)
* **Goal:** fixtures that are real where possible and documented-synthetic where needed, sanitized.
* **Owns:** `test/fixtures/raw/**`, `test/fixtures/README.md`, `test/fixtures/raw/fixtures.test.ts`, `scripts/fixtures/*.mjs`.
* **Steps:**
  1. Copy the 32 files from `a directory of captured API samples` into `raw/freqtrade/`.
  2. Find the `<freqtrade>/logs/votemax.log*` file containing `2026-09-28 04:00:07,965`. Extract 03:59:00–04:08:00 and 05:13:00–05:16:00. **Drop every `urllib3.connectionpool` line** and all other DEBUG lines, keeping continuation lines. Redact, and write `raw/logs/votemax-incident-2026-09-28.log`. Also capture a sanitized 2-minute DEBUG-inclusive excerpt from the current `votemax.log` into `raw/logs/votemax-normal-vv.log`.
  3. Generate `raw/incident/timeline.json` with `scripts/fixtures/extract-incident.mjs` (ms UTC).
  4. Capture live Kraken **public** responses into `raw/kraken/public/`: `Time`, `Assets?asset=XBT,ETH,USD,SHIB,BABY`, `AssetPairs?pair=XBTUSD,ETHUSD,SHIBUSD,BABYUSD`, `Ticker`, `OHLC XBTUSD/ETHUSD 240`, `OHLC XBTUSD 60`.
  5. Build synthetic private fixtures with `build-kraken-fixtures.mjs`, using the documented shapes (numbers as strings, times as float seconds, `descr.pair` altname). Files: `Balance.json`, `BalanceEx.json` (ZUSD, XXBT 0.00046744, XETH 0.1130240889, SHIB 1901628.18, BABY 0.21895, holds), `OpenOrders.empty.json`, `ClosedOrders.normal.json` (every sample bot order: txid = order_id, vol = amount, vol_exec = filled, price = safe_price, cost = filled*price, fee = cost × the trade's fee_open/fee_close, opentm/closetm from the order timestamps), `TradeVolume.json` (fee "0.4000", maker "0.2500"), `errors/{invalid_key,permission_denied,rate_limit,invalid_nonce}.json`, and the `incident/*` files per §8.3.
  6. Write the README: provenance, which data is synthetic and why (the 0.0043 ETH gap).
* **Acceptance:**
  * The fixture test passes: JSON parses; txids match `^O[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{6}$`; timeline counts are 26/25/1; incident Σvol equals 0.1130240889 − 8.9e-9 ± 1e-8.
  * `grep -rEn "webhooks/[0-9]+/|eyJ[A-Za-z0-9_-]{10,}|token=|Authorization|password" test/fixtures` returns nothing.
* **Verify:** `npx vitest run test/fixtures`.

### WP1: Freqtrade adapter and log ingestion
* **Owns:** `src/server/freqtrade/{client,schemas,normalize,candles}.ts` + tests, `src/server/logs/{parser,events,tailer}.ts` + tests.
* **Provides:**
  * `class FreqtradeClient(conn, fetchImpl?)` with methods `health() showConfig() status() trades() /* paginates */ balance() whitelist() locks() logs(limit) plotConfig() pairCandles(pair, tf, limit)`. Each returns `FtResult<T> = {ok:true,data,fetchedAt,latencyMs} | {ok:false,error:{kind,status?,message},fetchedAt}`.
  * Pure `normalizeHealth / normalizeConfig / normalizeTrades(botId, raw, {isOpen}): BotTradeBase[] / normalizeWallet / normalizeLocks / parsePairCandles(raw) → {columns, rows: Record<string,unknown>[], candles: Candle[], lastAnalyzedAt, dataStopAt, strategy}`.
  * `parseLogChunk(text, carry)`, `parseApiLogs(raw)`, `extractEvents(botId, records, source, parserState)` → `{events, lastWalletSyncAt, lastHeartbeatAt, lastLineAt}`.
  * `class LogTailer({botId, path, backfillHours, maxBytesPerPoll})` with `.poll(cursor)` → `{records, cursor, rotated, error?}`.
* **Acceptance:**
  * The client only issues GET to the §6.1 allowlist, with a Basic header and no credentials in the URL (test on the mocked fetch).
  * Normalizer expectations: votemax_status gives 1 open BTC/USD trade, order `O6ROFS-APVH7-255LCC`, `isEntry` true, `placedAt` 1790628707021; health `lastProcessAt` = 1790630988000; empty-string tags become null; votemax BTC candles have enter signals on the 12:00 and 16:00 rows; booleans and nulls are preserved.
  * The log parser on the incident excerpt produces events that equal `timeline.json` (types, times and txids). Traceback → the fatal message is `ValueError: invalid literal for int() with base 10: ''`. A synthetic webhook or JWT line gets redacted.
  * Tailer (temp dir): append, partial line, rotation without loss, head-hash change, backfill window, missing file → error with no throw.
* **Verify:** `npx vitest run src/server/freqtrade src/server/logs`; `npm run typecheck`; `npm run lint`.

### WP2: Kraken adapter
* **Owns:** `src/server/kraken/{sign,nonce,ratelimit,private,public,errors,assets,normalize,sync}.ts` + tests.
* **Provides:**
  * `signRequest`, `createNonceSource(load, save, clock)`, `KrakenRateLimiter({tier})` with `.acquire(cost)` and `.penalize()`.
  * `KrakenPrivateClient({apiKey, apiSecret, baseUrl, nonce, limiter, fetchImpl})` with `.call(method: KrakenPrivateMethod, params)`, serialized.
  * `KrakenPublicClient` with `time, assets, assetPairs, ticker(pairs), ohlc(pair, intervalMin)`.
  * `classifyKrakenError`, `buildAssetCatalog(rawAssets, rawPairs): AssetCatalog`.
  * Normalizers: `normalizeBalanceEx/normalizeBalance/normalizeOrders/normalizeTicker/normalizeOhlc/normalizeTradeVolume/normalizeLedgers`.
  * `syncClosedOrders(client, {reconStartSec, cursorSec, backfillComplete})` → `{orders, cursorSec, complete}`.
* **Acceptance:**
  * The docs test vector reproduces exactly.
  * Non-allowlisted methods (`AddOrder`, `CancelOrder`, `Withdraw`, `WalletTransfer`) throw.
  * 5 concurrent calls produce strictly increasing nonces in send order. Nonces never decrease with a backwards clock and a persisted value.
  * The limiter never exceeds max − reserve under a burst (fake clock). Rate-limit errors back off 30 s → 60 s → … → 300 s.
  * Catalog: `XXBT→BTC`, `ETH.F→ETH/earn`, `XBTUSD|XXBTZUSD|XBT/USD→BTC/USD`, unknown → null.
  * OHLC: the last row is `live:true`; times in seconds, ascending, unique.
  * Sync: backfill of 120 orders takes 3 pages; incremental overlap dedupes; the `complete` flag is set.
* **Verify:** `npx vitest run src/server/kraken`.

### WP3: Accounting and checks engine (pure) plus the incident regression
* **Owns:** `src/server/accounting/**`, `src/server/checks/{config,engine,lifecycle,util}.ts`, `src/server/checks/rules/*.ts` (one file per rule), all their tests, `src/server/checks/incident.regression.test.ts`, `test/fixtures/incident/**`, `src/shared/runbook.ts`.
* **Provides:** `computeTradePnl`, `withPnl(trade, mark)`, `computeBotStats`, `buildAccountSnapshot`, `buildAllocation`, `equityChange`, `DEFAULT_CHECK_CONFIG`, `evaluate(input)`, `applyLifecycle(prev, raw, now, cfg) → {next: Finding-like drafts (id null for new), notifications}`, and `RUNBOOK: Record<RuleId, {summary, steps: string[]}>`.
* **Acceptance:**
  * The P&L values in §7 match freqtrade `profit_abs` within ±0.0001. The allocation invariant holds.
  * Every rule has positive, negative and boundary tests.
  * Incident variants A–D all pass (§8.3). Coverage is >= 90% on checks and accounting.
  * No imports of `fs`, `db`, `fetch` or `Date.now()` in `checks/` or `accounting/`; time comes in as `now`. An ESLint `no-restricted-imports` rule or a test enforces this.
* **Verify:** `npx vitest run src/server/checks src/server/accounting --coverage`.

### WP4: Persistence
* **Owns:** `src/server/db/{client,migrations,index}.ts`, `src/server/db/repos/{meta,sourceState,botOrders,botEvents,logCursors,krakenOrders,krakenFlows,equity,signals,findings,acks,notifications}.ts` + tests.
* **Provides:**
  * `getDb()` (globalThis singleton; creates `DATA_DIR`, applies pragmas, runs migrations once).
  * Repo functions: `getMeta/setMeta`, `saveSourceState/loadSourceStates`, `markOrdersSeen/getKnownOrders`, `insertEvents` (idempotent)/`listEvents({botId?, since?, types?, limit?})`, `getCursor/saveCursor`, `upsertKrakenOrders/listKrakenOrders({since?, pair?, statuses?})/getOrdersByTxids`, `upsertFlows/listFlows`, `insertEquitySnapshot/listEquity(since, maxPoints)`, `upsertSignals/listSignals`, `listFindings({status?, severity?, limit?})/getFinding/saveLifecycle(drafts)` (transactional; returns ids for new rows)/`silence/unsilence`, `listAcks/createAcks` (bulk; revokes the existing active ack per subject in the same txn)/`revokeAck`, `logNotification`, and `prune(now)`.
* **Acceptance:**
  * Migrations are idempotent. The unique-open-finding and unique-active-ack constraints are enforced.
  * `saveLifecycle` is atomic (a failure mid-way leaves no partial write).
  * Equity downsampling returns <= maxPoints. Pruning honors retention.
  * Tests run on a temp-file DB with WAL.
* **Verify:** `npx vitest run src/server/db`.

### WP5: Auth and security
* **Owns:** `src/server/auth/{session,password,ratelimit,guard,origin}.ts` + tests, `src/proxy.ts`, `src/app/login/{page,LoginForm}.tsx`, `src/app/api/auth/{login,logout,session}/route.ts`.
* **Provides:** `signSession/verifySession`, `checkPassword`, `LoginRateLimiter`, `requireSession(req)`, `withAuth(handler, {mutating?})`, `assertSameOrigin(req)`.
* **Acceptance:**
  * Everything in §3 is covered by tests: tamper and expiry rejection; cookie flags including Secure auto; 5 failures/IP give 429 with Retry-After; the global lock; the fixed delay on failure.
  * Mutating guard: 415 for non-JSON, 403 for cross-origin or a missing Origin with `Sec-Fetch-Site: cross-site`.
  * Proxy: unauthenticated page gives 307 to `/login?next=` (an absolute `next` is rejected); unauthenticated `/api/v1/*` gives 401 JSON; public paths pass; the security headers are present.
  * The login page works at 390 px (autocomplete, optional name field, rate-limit message).
* **Verify:** `npx vitest run src/server/auth src/app/api/auth`; `npm run dev` then `curl -i localhost:3000/` (307) and `curl -i localhost:3000/api/v1/summary` (401).

### WP6: UI foundation
* **Owns:** `src/app/layout.tsx`, `src/app/globals.css` (tokens), `src/app/(app)/layout.tsx`, `src/app/(app)/ui-kit/page.tsx`, `components.json`, `src/components/ui/**` (shadcn: button, card, badge, tabs, dialog, sheet, drawer (vaul), popover, tooltip, select, switch, toggle-group, dropdown-menu, skeleton, table, separator, sonner), `src/components/shell/**` (Sidebar, BottomTabs, TopBar, MoreSheet, ModeBanner, FindingsBanner, MonitorIndicator), `src/components/data/**` (FreshnessDot, Metric, Money, Qty, Pct, TimeAgo, SeverityBadge, BotBadge, StatusPill, EmptyState, ErrorState, ResponsiveTable/CardList), `src/lib/client/{api,queries,format,useMediaQuery,prefs}.ts`, `public/manifest.webmanifest`, `public/icons/*`, `scripts/shot.mjs`. May add UI deps to `package.json`.
* **Provides:** typed hooks `useSummary, useOverview, useBot, useTrades, useKrakenOrders, useFindings, useAcks, useEquity, useChart, useStatus`; mutations `useSilence, useUnsilence, useCreateAcks, useRevokeAck, useNotifyTest, useLogout` (they send `Content-Type: application/json` and invalidate related queries); `FreshnessProvider` plus `<Metric sources>`; formatters.
* **`scripts/shot.mjs`:** `--base http://localhost:3000 --routes / /findings --out shots/<wp>`. Logs in with `DASHBOARD_PASSWORD` from `.env.local` and saves PNGs at 1440x900 and 390x844 (iPhone 14 profile).
* **Acceptance:** `/ui-kit` shows every primitive and freshness state. The shell shows the sidebar at 1440 and bottom tabs at 390 with no horizontal scroll at 390. Banners render against mock data. Keyboard focus rings are visible.
* **Verify:** `npm run dev` (with `.env.local` from `.env.dev.example`), then `npm run shot -- --routes /ui-kit / --out shots/wp6`, then inspect the PNGs.

### WP7: Mock upstreams (test harness)
* **Owns:** `test/mock-upstreams/{server.mjs,scenarios.mjs,README.md}` (zero dependencies, Node http).
* **Serves:**
  * `/votemax/api/v1/*` and `/dca/api/v1/*` from fixtures, with a Basic auth check using the test creds.
  * `/kraken/0/public/*` and `/kraken/0/private/*`. Private requests must carry a valid signature under the test secret in `.env.dev.example`.
  * `/discord/webhook`, which records posts, readable via `GET /__received`.
  * A log writer that appends scenario log lines to `test/mock-upstreams/.run/{votemax,dca}.log`.
* **Scenario control:** `POST /__scenario {"name":"normal|incident|bot-down|kraken-auth-error|no-kraken"}`, time-compressed (incident orders every 3 s).
* **Acceptance:** `npm run mock` works; curl examples in the README succeed; a bad signature gets `EAPI:Invalid signature`.
* **Verify:** `npm run mock` and `curl -u user:pass localhost:9999/votemax/api/v1/health`.

### WP8: Poller, orchestration and notifications
* **Owns:** `src/instrumentation.ts`, `src/server/boot.ts`, `src/server/poller/{scheduler,context}.ts`, `src/server/poller/jobs/{freqtrade,logs,kraken,market,checks,equity,signals,maintenance}.ts`, `src/server/notify/{dispatcher,discord}.ts` + tests.
* **Depends on:** WP1, WP2, WP3, WP4, and the WP0a store.
* **Behavior:**
  * `boot()`: hydrate state from `source_state`; build clients from config; start the scheduler.
  * Compute derived state (`withPnl`, stats, account, allocation) after each relevant job.
  * The checks job builds `CheckInput` from store + DB, then runs evaluate → lifecycle → `saveLifecycle` → dispatcher. It honors `store.onRecheck`.
  * Health diff emits `startup`/`identity_changed` events. A new unknown `order_created` triggers an immediate status/trades refresh plus QueryOrders.
  * Kraken status: `disabled` with no key; `error` on auth failure; `degraded` when any required endpoint is failing.
  * Mode = `kraken` iff balances are fresh (age <= 3× cadence).
* **Acceptance:**
  * Fake-timer tests: no overlapping runs; backoff; jitter bounds; `register()` called twice starts one poller; nothing starts when `NEXT_PHASE=phase-production-build`.
  * Dispatcher: batching, 5/min cap, and URL never logged (spy on the logger).
  * Integration with WP7: `npm run mock`, then `npm run dev` with `POLLER_ENABLED=true` → state populated within 30 s. The incident scenario produces critical findings in the DB within 90 s and `GET localhost:9999/__received` shows <= 8 Discord posts.
* **Verify:** `npx vitest run src/server/poller src/server/notify`, plus the integration run above (inspect via `sqlite3`, or add a temporary console dump that is removed before commit).

### WP9: Server views and API routes
* **Owns:** `src/server/views/{summary,overview,bots,trades,krakenOrders,findings,acks,equity,status}.ts` + tests, and every `src/app/api/v1/**/route.ts` **except `chart`**. It replaces the WP0a mock handlers but leaves `src/server/mock` in place.
* **Depends on:** WP3, WP4, WP5, and the store contract.
* **Rules:** every handler is wrapped in `withAuth` (`mutating` for POST/DELETE), zod-validates query and body, and exports `dynamic='force-dynamic'`. Freshness `state` is computed at response time. Acks and silence call `store.requestRecheck()`.
* **Acceptance:** each route matches its §5.3 type (tests with a seeded store + temp DB); 401 without a session; 403/415 on bad mutating requests; `Cache-Control: no-store`.
* **Verify:** `npx vitest run src/server/views src/app/api/v1`.

### WP10: Overview and Bot detail pages
* **Owns:** `src/app/(app)/page.tsx`, `src/app/(app)/bots/[botId]/page.tsx`, `src/components/{overview,bots,equity}/**`.
* **Acceptance:** matches §9 on both viewports; every bot/Kraken number is wrapped in `Metric`; loading, empty, error and stale states are shown in `/ui-kit`-style stories or via mock scenarios; screenshots are reviewed.
* **Verify:** `npm run shot -- --routes / /bots/votemax --out shots/wp10`.

### WP11: Trades, Findings and Status pages
* **Owns:** `src/app/(app)/{trades,findings,status}/page.tsx`, `src/components/{trades,findings,status}/**`.
* **Acceptance:** Findings detail shows evidence, the runbook text and all actions. Bulk "mark orders manual" sends one `POST /api/v1/acks` with all txids. The asset ack pre-fills the baseline. The Status page has the Kraken setup guide, the notify test button and ack revoke. Both viewports are covered.
* **Verify:** `npm run shot -- --routes /trades /findings /status --out shots/wp11`.

### WP12: Chart (server builder, route and UI)
* **Owns:** `src/server/chart/{builder,indicators,markers,cache}.ts` + tests, `src/app/api/v1/chart/route.ts`, `src/app/(app)/chart/page.tsx`, `src/components/chart/**`.
* **Depends on:** WP1 (`parsePairCandles`, client), WP2 (`ohlc`), WP4 (`signals`, `krakenOrders`, `acks`), WP5, WP6.
* **Acceptance:**
  * Builder tests on the fixtures: votemax BTC indicators follow `plot_config` (RSI, Score and Touches panes; ema20/50 visible). Signal times are 1790596800 and 1790611200. The fill for trade 8 (filled 1790628758621) snaps to 1790625600 on the live Kraken candle. Markers are sorted. DCA gets the `signalsNote`. Non-strategy timeframes use `source:'kraken'` with no indicators.
  * The cache is single-flight and refetches at most once per minute.
  * UI: layer toggles persist in the URL; at most 2 panes on mobile; the candle detail sheet works; pinch and drag work (manual check); `data-*` counts are present.
* **Verify:** `npx vitest run src/server/chart`; `npm run shot -- --routes "/chart?bot=votemax&pair=BTC/USD&tf=4h" --out shots/wp12`.

### WP13: End-to-end tests
* **Owns:** `e2e/*.spec.ts`, `playwright.config.ts`, `compose.test.yaml` (services `mock`, `app` (built image, env pointing to the mock, `FT_BOT_n_LOGFILE` mounted from the mock's `.run`), `e2e` (`mcr.microsoft.com/playwright:<matching version>-noble`)).
* **Specs:**
  1. Login, logout and rate limit.
  2. Overview desktop and mobile render with freshness dots and no console errors.
  3. The `no-kraken` scenario shows the freqtrade-only banner.
  4. The `incident` scenario shows the critical banner within 90 s; the Findings detail lists 25 and 26 orders; bulk ack resolves it.
  5. The chart renders a canvas and `data-fills > 0`.
  6. The `bot-down` scenario shows a Down pill.
  7. No `/api/v1/*` responses without a cookie.
  8. The client bundle contains none of the `.env.dev.example` secret values (`grep -r` over `.next/static`).
* **Verify:** `docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from e2e`.

### WP14: Deployment, hardening and live smoke (integrator; may edit any file)
* **Owns:** `docs/RUNBOOK.md`, final `README.md`, and any fixes.
* **Steps:**
  1. The user creates `.env` (password, secret, freqtrade creds, no Kraken key yet).
  2. `docker compose build && docker compose up -d && docker compose ps` shows the container healthy.
  3. `curl -s localhost:8043/api/health`.
  4. Log in via curl (cookie jar, `Origin: http://localhost:8043`), then `curl -b jar localhost:8043/api/v1/summary`.
  5. **Expected live state today:** mode `freqtrade-only`; both bots `running`; votemax has 1 open BTC/USD trade; closed trades 7 and 3. Findings: `UNTRACKED_HOLDING:ETH` (warning, bot-wallet source), `UNTRACKED_HOLDING:SHIB` (warning, to be acked as manual), `UNPERSISTED_ORDER:votemax:ETH/USD` from the log backfill (warning once > 24 h old, 25 orders), and a `FEE_ANOMALY` info for votemax trade 3.
  6. `docker exec freqdash id` shows uid 1001. The root filesystem is read-only. `docker logs freqdash 2>&1 | grep -Eic "webhooks/|eyJ|password|secret"` returns 0.
  7. Playwright screenshots against the live instance at 390 and 1440.
  8. Optionally add a cloudflared route to `http://freqdash:3000`.
  9. After the Kraken key is added: the mode switches, the backfill completes, `ORPHAN_KRAKEN_ORDER:ETH/USD` appears for the Sep-28 orders, and the account total becomes the real one.
* **Acceptance:** everything above is documented in the RUNBOOK (setup, Kraken key creation, ack workflow, backup via `docker run --rm -v freqdash-data:/d -v %cd%:/b busybox cp /d/freqdash.sqlite /b/`).

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Log rotation erases incident evidence (about 3.3 days at `-vv`) | WP0b first. `LOG_BACKFILL_HOURS=96` on the first deploy. |
| Secrets in bot logs (webhook token, JWT) | Store no DEBUG lines. `redactSecrets` everywhere. Recommend `-v` and rotating the webhook. |
| Kraken rate limits | Separate key counter. Limiter mirrors the tier (default Starter). About 40% budget use. Backoff on errors. |
| Nonce errors or clock skew | One serial queue. Persisted monotonic ms nonce. Never share the key. CLOCK_SKEW rule. `EAPI:Invalid nonce` bumps the nonce and retries once. |
| ClosedOrders pagination (50/page, offsets shift as new orders arrive) | Incremental `start = cursor − 600 s` overlap. Upsert by txid. QueryOrders to confirm specific ids. `backfillComplete` gates the "missing on Kraken" rule. |
| Kraken naming and wallet suffixes | Catalog built from `Assets`/`AssetPairs` plus static aliases. Suffix map. Unknown pair → `pair: null`, still reconciled by txid. |
| Mixed timestamp units, TZ-less date strings | Adapters normalize to ms. Unit tests per endpoint. Never parse the date strings. |
| Candle alignment (forming candle missing from pair_candles; markers must hit bar times and be sorted) | Append the Kraken OHLC live candle. Snap marker times. Sort before `createSeriesMarkers`. Tests. |
| Freqtrade `/trades` is closed-only; zero-fill canceled orders vanish | Union with `/status`. `bot_orders_seen`. Zero-fill downgrade in UNPERSISTED_ORDER. Fresh-fetch gating before flagging. |
| Freqtrade auth changes | Basic works today. A 401 gives BOT_AUTH_FAILED. If JWT is ever required: login, 15-min access token, `/token/refresh`. |
| pair_candles cost | Cache + single-flight, at most 1 fetch/min per key. The recorder uses `limit=3`. |
| Next.js lifecycle pitfalls | Covered in §2. The poller is framework-agnostic for a later worker split. |
| better-sqlite3 missing from standalone output | Explicit `serverExternalPackages` + `outputFileTracingIncludes`. Glibc base image. WP14 verifies. |
| SQLite on a Windows bind mount | Named volume. |
| Memory | Bounded caches. 4 MB/poll log reads. `mem_limit 512m`, heap 384 MB. |
| freqdash itself down means silent failure | Restart policy + healthcheck. `freqdash started` notification. Recommend an external uptime check (Beszel or Uptime Kuma) on `/api/health`. |
| Proxy bypass class of bugs | `withAuth` in every handler. |
| Cloudflare caching of private data | `no-store` on API and HTML. |
| Freqtrade creds allow bot control | GET-only allowlist with a test. |
| First-run noise (real historical issues surface) | Expected. The ack UX handles it. The RUNBOOK explains. |
| `read_only` rootfs breaks Next | tmpfs for `/app/.next/cache` and `/tmp`. WP14 may drop `read_only` if Next needs other write paths. |

---

## 12. Open questions (with recommendations)

1. **Kraken key permissions.** Also enable *Query Ledger Entries* (read-only) so the equity chart can separate deposits and withdrawals from P&L? **Recommend yes.** Without it, the app still works and shows an "unadjusted" caveat.
2. **Mount the freqtrade logs read-only into freqdash** (`../freqtrade/logs:/ftlogs:ro`)? This is the only way to see crashes ("Fatal exception" never reaches `/logs`) and to detect unpersisted orders without a Kraken key. **Recommend yes** (the default in compose).
3. **Bot verbosity.** Switch both bots from `-vv` to `-v`? Every event freqdash needs is INFO or above. It removes the webhook-token lines and cuts log churn roughly 10×. **Recommend yes, and rotate the Discord webhook now**, since its token is in the logs.
4. **Push channel.** **Decided:** native Web Push from freqdash for phone alerts (ntfy was dropped), plus an optional Discord webhook (a separate channel from the bots' webhook) for warning and above.
5. **Auth model.** **Recommend** one shared password plus an optional name at login (for ack attribution). If the tunnel is enabled, also put Cloudflare Access or another identity proxy in front as a second layer. The app's own auth stays mandatory regardless.
6. **The Sep-28 orphans.** After the Kraken backfill confirms them (25 logged + possibly 1 more; about 0.108–0.113 ETH), treat that ETH as a manual holding (ack with a note), or sell it manually? **Recommend** ack as "manual: 2026-09-28 incident" until you decide. freqdash only needs the ack to stop alerting.

---

### Critical Files for Implementation
- src/shared/types/domain.ts (plus findings.ts, api.ts, state.ts): the frozen contracts every WP depends on
- src/server/checks/engine.ts (plus lifecycle.ts, rules\*.ts, incident.regression.test.ts): reconciliation and alerting core
- src/server/kraken/private.ts (plus sign.ts, nonce.ts, ratelimit.ts): allowlisted signed read-only client
- src/server/logs/tailer.ts (plus parser.ts): crash and unpersisted-order detection from the bots' log files
- src/server/poller/scheduler.ts (plus src\instrumentation.ts, src\server\boot.ts): single-process polling orchestration

Reference inputs: a directory of captured API samples (32 samples), <freqtrade>/logs/votemax.log.2 (incident, rotating out soon), <freqtrade>/compose.yaml, <freqtrade>/user_data/strategies/VoteMaxMulti.py and DcaBot.py (plot_config, last-row signals).

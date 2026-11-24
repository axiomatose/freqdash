# freqdash runbook

freqdash is a **read-only** monitor for the freqtrade bots and the Kraken account. It never places, cancels or
changes an order, and it only sends `GET` requests to the bots.

## 1. First deploy

1. Copy `.env.example` to `.env` next to `compose.yaml` and fill in at least:
   * `BOT_NETWORK`, the existing Docker network the bots are on (`docker network ls`); compose attaches freqdash to it;
   * `SESSION_SECRET` (32+ random characters, e.g. `openssl rand -base64 48`; it encrypts the secrets stored in the database);
   * one block per bot: `FT_BOT_n_ID`, `_NAME`, `_URL` (e.g. `http://freqtrade-bot1:8080`), `_USERNAME`, `_PASSWORD`, `_LOGFILE`
     (e.g. `/ftlogs/bot1.log`, the bots' log directory is mounted read-only at `/ftlogs`);
   * `APP_ORIGINS` with every URL you open the dashboard from.
   Leave the Kraken key empty for now: freqdash then runs in **freqtrade-only mode**.
2. `docker compose build && docker compose up -d && docker compose ps` (the container must become `healthy`).
3. `curl -s localhost:8043/api/health` returns `{"ok":true,"version":...}`.
4. Log in in the browser at `http://localhost:8043` as `admin`. On a new database freqdash creates that account with a
   random temporary password and prints it once: `docker logs freqdash 2>&1 | grep temporaryPassword`. The first
   sign-in asks for a new one (12+ characters) before anything else is shown. To check from a shell instead (with a password that is no longer temporary):
   ```
   curl -s -c jar -X POST localhost:8043/api/auth/login -H 'Content-Type: application/json' \
     -H 'Origin: http://localhost:8043' -d '{"username":"admin","password":"<your password>"}'
   curl -s -b jar localhost:8043/api/v1/summary
   ```
5. Set `LOG_BACKFILL_HOURS=96` on the first start so the rotated bot logs (about 3.3 days at `-vv`) are read once.

### What you should see on day one (freqtrade-only mode)

* Mode badge "Freqtrade-only" and the amber banner; both bots `Running`; the account total is an estimate from the freshest bot wallet.
* Findings you can expect from the current state: `UNTRACKED_HOLDING` for coins that no bot trade explains (warning, capped
  at warning because the source is a bot wallet), `UNPERSISTED_ORDER` for orders that are in a bot log but never showed up in its
  API (from the log backfill), and `FEE_ANOMALY` (info) for old trades with unusual fees.
* `docker exec freqdash id` shows uid 1001, the root filesystem is read-only, and
  `docker logs freqdash 2>&1 | grep -v temporaryPassword | grep -Eic "webhooks/|eyJ|password|secret"` prints `0` (the
  one first-start line holds the admin's temporary password on purpose).

If Next.js needs a write path that the read-only root filesystem forbids, drop `read_only: true` from `compose.yaml` and note it here.

## 2. Adding the Kraken key (reconciliation mode)

Create a **new** key, never reuse the bots' key (a shared key shares the nonce counter and rate limit and causes
`EAPI:Invalid nonce` errors in the bots).

* Kraken → Security → API → Create key. Permissions, and nothing else: **Query funds**, **Query open orders & trades**,
  **Query closed orders & trades**, **Query ledger entries**. No trading, no deposit or withdrawal permissions.
* Put `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` into `.env` (never in chat, tickets or screenshots), set `KRAKEN_TIER`
  (`starter`, `intermediate`, `pro`) and restart: `docker compose up -d`.
* The Status page shows the mode, permission probe results and the backfill. `RECON_START` (a date) limits how far back
  orders are reconciled; it defaults to the first start.
* After the backfill: mode switches to "Kraken", the account total is the real one, and `ORPHAN_KRAKEN_ORDER` shows any order
  on Kraken that no bot knows about.

## 3. Working with findings

Open a finding to see the evidence, the "what to do" steps and the actions:

| Situation | Action |
| --- | --- |
| Orders that you placed yourself, or old known history | **Mark orders manual** (bulk, one click for every order in the finding) or **Ignore orders** |
| A coin you hold on purpose | **Mark holding manual**: the quantity is pre-filled with what is currently unexplained; more than that is flagged again |
| Noise you understand | **Silence** with a note. It comes back by itself if the finding gets worse (higher severity or more evidence) |
| Wrong label | Status → Acknowledgements → **Revoke** |

Acknowledgements and silences trigger an immediate re-check.

Findings are sent as **Web Push notifications** to every device that enabled them, and to Discord if it is
configured. Test everything with Status → **Send test notification**.

### Notifications on your phone (Web Push)

Each user turns notifications on per device: user menu (or More on a phone) → **Notifications** → **Enable on this
device**, then allow notifications when the browser asks. Every device has its own switches: **Buys** (filled entry
orders, including DCA adds), **Sells** (closed trades, P&L after fees), **Problems** (findings, from critical only up to
everything), **When problems clear**, and **System messages** (freqdash restarted, Status-page tests). Killswitch alerts
always go to every device. **Send test** next to a device checks the whole path.

* It needs https, so open freqdash through an HTTPS address (a tunnel or reverse proxy, section 5), not `http://192.168…`.
* iPhone/iPad (iOS 16.4+): open the dashboard in Safari, Share → **Add to Home Screen**, open freqdash from the Home Screen
  and enable notifications there. Safari tabs cannot receive web push.
* The VAPID key pair is generated on first start and stored encrypted in the database (`VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` in `.env` override it). Changing the keys, or rotating `SESSION_SECRET` with generated keys, removes
  every device; enable notifications again on each.
* Findings below `NOTIFY_MIN_SEVERITY` (default `warning`) are never sent on any channel.
* With push working, `DISCORD_WEBHOOK_URL` can stay empty.

## 3b. Killswitch

A runaway buyer is stopped automatically: freqdash watches the **Kraken** order stream (not the bots' own records) and,
when it trips, stops the bots' Docker containers and sends a critical alert (Web Push to every device, plus Discord if
configured).

**Trigger** (per pair, so two bots opening different pairs together do not trip it): more than **2** buys within **30 s**
(`KILLSWITCH_MAX_BUYS_30S`), or more than **3** within **10 min** (`KILLSWITCH_MAX_BUYS_10M`). The second rule matters: the
2026-09-28 incident was about one buy every 2 to 3 minutes and would never have tripped a 30-second rule. Buys that count are
filled or still-open ones; sells, cancelled zero-fill orders and orders you acknowledged as manual do not.
It needs fresh Kraken data. If Kraken is unreachable it is blind, and the banner and the Kraken finding say so.

**How it stops**: freqdash never touches the Docker socket. A tiny separate container (`killswitch-agent`, `tools/killswitch-agent/agent.mjs`,
about 100 lines, no dependencies) holds the socket and can only `docker stop` the containers in `KILLSWITCH_ALLOWED`, for a
caller with the shared `KILLSWITCH_TOKEN`. It is not published on any host port. A stop is retried (5 attempts) if the agent fails.
Which bots: those whose whitelist or open trades include the pair, or every bot when that is unclear.

**Set up**
1. In `.env`: `FT_BOT_n_CONTAINER` for each bot, `KILLSWITCH_TOKEN` (24+ random characters), `KILLSWITCH_ALLOWED` (the same container
   names), `KILLSWITCH_AGENT_URL=http://freqdash-killswitch:9100`. Needs the Kraken key.
2. `docker compose up -d` starts the agent next to freqdash. `docker logs freqdash-killswitch` shows every stop and every rejected request.
3. Run `KILLSWITCH_MODE=dry-run` first for a few days: it alerts "would trip" and stops nothing. Then set `armed`.
4. Make sure the bot containers do not have `restart: always`: with `unless-stopped` a manually stopped container stays stopped
   (also across a Docker restart), with `always` it comes back when the Docker daemon restarts.

**After a trip** the killswitch latches: the red banner stays and nothing else happens automatically. Check Kraken (open
orders, holdings), find the cause, start the bots yourself (`docker start ...`), then Status → **Reset killswitch**. Only orders
opened after the reset count towards the next trip. freqdash never starts a container.

**Limits**: detection is bounded by the Kraken poll (open orders every 15 s), so a stop lands roughly 15 to 45 s after the third
buy; a bot that is buying much faster can place a few more orders in that time. The stop is `docker stop` (SIGTERM, then
SIGKILL after 10 s). The agent has the Docker socket, which is root on the host: keep its token secret, keep it off published
ports, and keep `KILLSWITCH_ALLOWED` short.

## 3c. Assistant (built-in chat)

A chat assistant that can answer questions about the bots, their strategies, fees, the Kraken account and findings, and can act in
freqdash. It runs on an OpenAI-compatible API that you configure **in the app**, not in `.env`.

**Set up**: user menu (top right) → **Settings** → Assistant: turn it on, set the API base URL (OpenAI is `https://api.openai.com/v1`, any
compatible endpoint works), paste the API key, pick a model from the list the provider returns (it reloads when the endpoint or key changes; there is no built-in default model, and changing the endpoint clears the old choice), **Test connection**, Save. The key is stored encrypted in the database
(AES-256-GCM, keyed from `SESSION_SECRET`), is never shown again and never sent to the browser. Rotating `SESSION_SECRET` makes the stored key
unreadable: enter it again. The assistant is a collapsible pane on the right: open and collapse it with the sparkle button in the top bar (full screen on phones). The conversation survives collapsing it and moving between pages; open/collapsed is remembered per browser.

**What it can do**: read everything the dashboard shows (summary, overview, bots, trades, Kraken orders, findings and their runbooks, equity
history, data-source status, killswitch state, acknowledgements, strategies with the fee-impact replay, a compact chart, bot events). It can
also change freqdash's own state: silence or unsilence findings, acknowledge or un-acknowledge orders and holdings, send a test notification,
reset the killswitch, and save or delete memories. It cannot place or cancel orders, and it cannot start, stop or reconfigure a bot.

**Approvals**: every action except saving a memory waits for you (Approve / Decline on the card, with the exact arguments one click away).
The setting "Run actions without asking" lets routine actions run straight away; **resetting the killswitch always asks**, whatever the setting.
A new message while an action waits drops that action instead of running it later.

**Memories**: the assistant saves durable facts (your preferences, decisions and why, conclusions of an investigation) and sees them in every
chat. Review, add and delete them under Settings → Memories. **Notes for the assistant** (Settings → Assistant) is free text it always sees:
strategy notes, house rules. Do not put secrets there.

**Safety**: text from bot logs, order data and findings can contain anything, so the assistant is told to treat tool output as data, never as
instructions; only your chat messages instruct it. The read-only agent token (`AGENT_API_TOKEN`) cannot reach the settings, chats or memories,
and the chat route is POST-only.

**Privacy**: to answer, the assistant reads your live data and that data is sent to the API you configured (balances, trades, findings, bot
config and strategy source). Use an endpoint you trust. Conversations are stored in the local database (Settings → Memories lists memories;
chats can be deleted from the Chats panel).

**Cost/limits**: one answer is a few model calls (max steps per answer is a setting, default 8). Tool results are capped, and only the last 40
messages of a chat are sent to the model.

## 4. Operations

* **Backup**: `docker run --rm -v freqdash-data:/d -v "$PWD":/b busybox cp /d/freqdash.db /b/` (the database file is `freqdash.db`).
  It is safe to copy while running (WAL); also copy `freqdash.db-wal` if it exists, or stop the container first.
* **Update**: `git pull && docker compose build && docker compose up -d`. Migrations run at start.
* **Logs**: `docker logs freqdash`. Logs are JSON lines; secrets, webhook URLs and JWTs are redacted.
* **Sessions**: every sign-in is a session stored in the database (the cookie holds a random token; only its hash is
  stored). User menu → **Account and sessions** lists your sessions (device, address, last activity) and can end any of
  them, or all but the current one. A session ends after `SESSION_MAX_AGE_DAYS` (default 30) without use, after 90 days
  in any case, at sign-out, and when the password changes.
* **Change a password**: user menu → **Account and sessions** → **Change password**. It ends every session of that user
  (this browser gets a new one).
* **Add an account** (a partner): set `AUTH_RESET_USER=<new username>` and `AUTH_RESET_PASSWORD=<temporary, 12+
  characters>` in `.env`, `docker compose up -d`, then remove both lines. A name that does not exist yet is created with
  that temporary password, which the person changes at the first sign-in. Every account has the same access.
* **Forgotten password**: set `AUTH_RESET_USER=<username>` and `AUTH_RESET_PASSWORD=<temporary, 12+ characters>` in
  `.env`, `docker compose up -d`, sign in with it (a new password is required right away), then remove both lines. Each
  pair is applied once, so leaving them in by mistake does not undo the new password.
* **Rotate `SESSION_SECRET`** (only if it leaked): edit `.env`, `docker compose up -d`. Nobody is signed out, but the
  assistant's API key must be entered again and, with generated VAPID keys, every device must re-enable notifications.
  To sign someone out, end their sessions instead (or change their password).
* **Login protection**: after two wrong passwords for the same address or username, the sign-in form also asks for a
  captcha (five characters, self-hosted). Five failures per address lock it for 15 minutes; 20 across all addresses lock
  everyone for 15 minutes.
* **Retention**: order events 365 days, other events 90 days, resolved findings 90 days, notification log 30 days; equity
  snapshots and Kraken orders are kept.
* **Monitoring stalled** (red banner): the poller has not completed a cycle for 60 s. Check `docker logs freqdash`; the
  container restarts itself if it is unhealthy.
* **Recommendation for the bots**: run at `-v` instead of `-vv` (the DEBUG lines contain secrets) and rotate the bots' Discord webhook.

## 5. Optional: expose through cloudflared

Point a tunnel route at `http://freqdash:3000`, set `TRUST_PROXY=cloudflare`, add the public URL to `APP_ORIGINS` and set
`APP_PUBLIC_URL`. Keep the account passwords strong: the login is rate limited (5 failures per address) and asks for a
captcha after two, but it is still the only gate until passkeys or another second factor are added.

## 6. Testing

* `npm run verify`: typecheck, lint, unit tests.
* `npm run build && npm run e2e`: Playwright against a production build and the mock upstreams (`PW_CHROMIUM=<path>` to use an installed Chromium).
* `docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from e2e`: the same in containers.
* `npm run mock` + `npm run dev` (with `.env.local` from `.env.dev.example` and `POLLER_ENABLED=true`) for manual work;
  `npm run shot -- --routes / /findings --out shots/x` takes screenshots at 1440 and 390 px.

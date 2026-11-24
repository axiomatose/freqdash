# freqdash

freqdash is a self-hosted, read-only dashboard for [freqtrade](https://www.freqtrade.io) bots. It polls each bot's REST
API, tails the bots' log files and, if you give it a read-only Kraken API key, reads your Kraken account too. When those
sources disagree, it raises a finding, for example an order that exists on Kraken but that no bot recorded.

It was built for several spot bots that trade on one shared Kraken account, where each bot's own view of the wallet goes
wrong. It works with one bot as well, and with up to ten.

What it does:

- Shows the account total, per-bot positions, open and closed trades, P&L after the fees Kraken actually charged, an equity
  history and a candle chart with each strategy's indicators and fills.
- Reconciles every bot order against Kraken and flags orphan orders, orders a bot logged but never saved, crash and
  restart loops, fee anomalies and holdings no bot explains.
- Sends alerts to phones and desktops (Web Push) and, optionally, to Discord.
- Can stop the bot containers when Kraken shows a runaway buyer (an optional killswitch, off by default).
- Lists each strategy's parameters and source, and replays closed trades under a different fee assumption.

freqdash never places, cancels or changes an order, and it sends the bots nothing but `GET` requests. The killswitch is
the only part that can affect a bot, and it can only stop containers you list.

freqdash is built with Next.js 16, React 19, TypeScript and SQLite, and ships as one Docker container.

## Contents

1. [Requirements](#1-requirements)
2. [How freqdash connects to your bots](#2-how-freqdash-connects-to-your-bots)
3. [Prepare your freqtrade bots](#3-prepare-your-freqtrade-bots)
4. [Install and start freqdash](#4-install-and-start-freqdash)
5. [Sign in for the first time](#5-sign-in-for-the-first-time)
6. [Add a read-only Kraken key](#6-add-a-read-only-kraken-key)
7. [Optional: notifications, killswitch, assistant, API token, remote access](#7-optional-notifications-killswitch-assistant-api-token-remote-access)
8. [Configuration reference](#8-configuration-reference)
9. [Day to day: findings, updates, backups, accounts, logs](#9-day-to-day-findings-updates-backups-accounts-logs)
10. [Troubleshooting](#10-troubleshooting)
11. [Development](#11-development)

## 1. Requirements

- **Docker** with Compose v2 (`docker compose`), ideally on the host that runs your bots.
- **freqtrade bots** with the REST API enabled (section 3). freqdash uses HTTP basic auth, which freqtrade's API supports
  on every endpoint. Bots in Docker on the same host get every feature; log tailing and the killswitch need that.
- **Spot trading.** Shorts and futures are not modelled.
- **Kraken** for the reconciliation features. Without a Kraken key freqdash runs in _freqtrade-only mode_: bots, trades,
  logs, charts and strategies all work, but the account total is an estimate from the bots' wallet caches and nothing is
  checked against the exchange. Bots on other exchanges can use freqtrade-only mode, but that setup is untested.
- About 512 MB of RAM for the container.

To build or develop outside Docker you need Node.js 22.12 or newer.

## 2. How freqdash connects to your bots

```
                     ┌────────────────────── Docker network ──────────────────────┐
  browser ──:8043──▶ │ freqdash ──GET /api/v1/* (basic auth)──▶ freqtrade bot 1..10 │
                     │    │                                                       │
                     │    ├── reads bot log files (read-only bind mount)          │
                     │    └── POST /stop ──▶ killswitch-agent (optional)          │
                     └────┼───────────────────────────────────────────────────────┘
                          └──HTTPS──▶ api.kraken.com (read-only key, optional)
```

freqdash needs three things from each bot:

1. **Its API URL**, reachable from the freqdash container. The simplest way is a Docker network shared by freqdash and
   the bots, so freqdash can use the bot's container name, for example `http://freqtrade-bot1:8080`. A published port or
   a reverse proxy works too (3.3).
2. **An API username and password.** freqtrade has no read-only API role, so these credentials could control the bot.
   freqdash only ever sends `GET` requests to an allowlisted set of paths, and it keeps the password out of its logs.
3. **Its log file** (recommended). The bot's `/logs` endpoint only holds a few minutes of history and loses fatal errors
   that happen after the API stops, so freqdash reads the log file directly. Without a log file it falls back to the API
   and raises a `LOG_TAIL_UNAVAILABLE` warning.

## 3. Prepare your freqtrade bots

### 3.1 Enable the REST API

In each bot's config file, enable `api_server` and give each bot its own long random password:

```json
"api_server": {
  "enabled": true,
  "listen_ip_address": "0.0.0.0",
  "listen_port": 8080,
  "verbosity": "error",
  "enable_openapi": false,
  "jwt_secret_key": "<random string>",
  "CORS_origins": [],
  "username": "freqdash",
  "password": "<long random password>"
}
```

`listen_ip_address` must be `0.0.0.0` so other containers can reach the API. On a shared Docker network (3.3) the bot
does not need to publish port 8080 on the host.

### 3.2 Write a log file freqdash can read

Start each bot with `--logfile` pointing at a directory that is bind-mounted from the host, one file per bot. freqtrade
rotates the file to `<name>.log.1`, `<name>.log.2` and so on, and freqdash reads those too.

A bot service in your freqtrade `docker-compose.yml` might look like this:

```yaml
services:
  freqtrade-bot1:
    image: freqtradeorg/freqtrade:stable
    container_name: freqtrade-bot1
    restart: unless-stopped
    volumes:
      - ./user_data:/freqtrade/user_data
      - ./logs:/freqtrade/logs
    command: >
      trade
      --config /freqtrade/user_data/config_bot1.json
      --strategy MyStrategy
      --logfile /freqtrade/logs/bot1.log
      -v
```

Notes:

- **Keep the bots' timezone at UTC** (the image default). freqdash reads log timestamps as UTC; a bot with a different
  `TZ` produces events at the wrong times.
- **Run at `-v`, not `-vv`.** At `-vv` freqtrade logs DEBUG lines that contain secrets such as Discord webhook URLs.
  freqdash redacts them and never stores DEBUG lines, but the log files on disk still hold them.
- **Use `restart: unless-stopped`, not `always`,** if you plan to use the killswitch. With `always`, a bot the killswitch
  stopped comes back when the Docker daemon restarts.

### 3.3 Let freqdash reach the bots

**Shared Docker network (recommended).** freqdash joins the network your bots are on and calls each bot by container
name. Docker Compose puts a project's containers on a network called `<project>_default`, where the project is the
directory name; with freqtrade's usual `ft_userdata` directory that is `ft_userdata_default`. To see which networks a bot
is on:

```bash
docker inspect freqtrade-bot1 --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

You will put that name in `BOT_NETWORK` in `.env` (4.2). If your bots are spread over several networks, or you prefer a
dedicated one, create a network and connect each bot to it:

```bash
docker network create freqdash
```

```bash
docker network connect freqdash freqtrade-bot1
```

A container connected by hand leaves the network when it is recreated; to make it permanent, add the network to the
bot's compose file as an `external` network.

**By URL, through a published port or a proxy.** If a bot cannot join the network (it runs on another machine, or outside
Docker), publish its API port or put it behind a reverse proxy, and set `FT_BOT_n_URL` to that address. For a port
published on the same host use `http://host.docker.internal:<port>`, which freqdash's `compose.yaml` maps to the host.
freqdash still needs a network to start on: create one with `docker network create freqdash` and use it as
`BOT_NETWORK`. The API password travels with every request, so use HTTPS for a bot on another machine. Log tailing and
the killswitch only work for bots on the same host as freqdash.

## 4. Install and start freqdash

### 4.1 Get the code

The default `compose.yaml` mounts the bot logs from `../freqtrade/logs`, so the simplest layout is to clone freqdash next
to your freqtrade directory:

```
docker/
├── freqtrade/          your bots: compose file, user_data/, logs/
└── freqdash/           this repository
```

```bash
git clone https://github.com/axiomatose/freqdash.git
```

If your logs live elsewhere, change the `../freqtrade/logs:/ftlogs:ro` line in `compose.yaml` to your host path. Keep
`:ro`: freqdash only needs to read them.

### 4.2 Create `.env`

```bash
cd freqdash
```

```bash
cp .env.example .env
```

Fill in at least the following. Section 8 lists every variable.

```ini
# The Docker network your bots are on (3.3).
BOT_NETWORK=ft_userdata_default

# 32+ characters. Encrypts the secrets freqdash stores in its database.
SESSION_SECRET=<output of: openssl rand -base64 48>

# Every URL you open the dashboard from, if it differs from the address the browser sends as Host.
APP_ORIGINS=http://localhost:8043,http://192.168.1.50:8043

# none, unless freqdash sits behind Cloudflare (see 7.5).
TRUST_PROXY=none

# One block per bot, numbered 1 to 10.
FT_BOT_1_ID=bot1
FT_BOT_1_NAME=Bot1
FT_BOT_1_URL=http://freqtrade-bot1:8080
FT_BOT_1_USERNAME=freqdash
FT_BOT_1_PASSWORD=<the api_server password from 3.1>
FT_BOT_1_LOGFILE=/ftlogs/bot1.log
FT_BOT_1_CONTAINER=freqtrade-bot1
```

Things that trip people up:

- `FT_BOT_n_ID` is a short slug (`a-z`, `0-9`, `-`). It appears in URLs and in the database, so choose it once and
  keep it.
- `FT_BOT_n_LOGFILE` is the path **inside the freqdash container**. The host log directory is mounted at `/ftlogs`, so a
  host file `../freqtrade/logs/bot1.log` is `/ftlogs/bot1.log`.
- `.env.example` ships with two example bots (`bot1`, `bot2`). Delete any block you do not use: a block with a URL but no
  password fails validation.
- Keep comments on their own lines, and wrap any value that contains `$` in single quotes; Compose interpolates `$`.

`.env` holds credentials. It is ignored by git; keep it that way.

### 4.3 Build and start

```bash
docker compose up -d --build
```

```bash
docker compose ps
```

Wait until the `freqdash` container shows `healthy` (about 40 seconds), then check it answers:

```bash
curl -s localhost:8043/api/health
```

It should print `{"ok":true,"version":"..."}`.

If the container keeps restarting, read its log. A configuration error names each bad variable and the problem, never the
value:

```bash
docker logs freqdash
```

The `killswitch-agent` service starts too. While `KILLSWITCH_TOKEN` and `KILLSWITCH_ALLOWED` are both empty it idles and
does nothing (7.2 sets it up). If you never plan to use it, you can delete that service from `compose.yaml`; it is the
only container with access to the Docker socket.

On the first start, freqdash reads `LOG_BACKFILL_HOURS` (default 96) of past log history so it can report problems that
happened before it was installed.

## 5. Sign in for the first time

Open `http://<host>:8043`.

On the first start freqdash creates one account, `admin`, with a random temporary password, and prints the password
once in its log:

```bash
docker logs freqdash 2>&1 | grep temporaryPassword
```

Sign in as `admin` with that password. You must choose a new one (12 or more characters) before anything else is
shown. To choose the first account's name and password yourself instead, set `AUTH_RESET_USER` and
`AUTH_RESET_PASSWORD` in `.env` before the first start; freqdash then creates that account and no `admin`. To give a
partner their own sign-in later, see 9.3.

What you should see on day one, without a Kraken key:

- The mode badge **Freqtrade-only** and an amber banner explaining it.
- Each bot shown as **Running**.
- An account total estimated from the freshest bot wallet.
- Possibly some findings from history: `UNTRACKED_HOLDING` for coins no bot trade explains, `UNPERSISTED_ORDER` for orders
  found in a bot log that never reached its API, and `FEE_ANOMALY` (info) for unusual fees on old trades.

The **Status** page shows how fresh each data source is, whether each bot answered, and the log tail per bot. Check it
first when a number looks wrong.

## 6. Add a read-only Kraken key

This turns on reconciliation: the real account balance, the fees Kraken charged, and the orphan-order and runaway-buyer
checks.

1. On Kraken, create a **new** API key. Do not reuse the bots' trading key: a shared key shares its nonce counter and rate
   limit with the bots, which causes `EAPI:Invalid nonce` errors in the bots.
2. Give it these permissions and nothing else: **Query funds**, **Query open orders & trades**, **Query closed orders &
   trades**, **Query ledger entries**. Never enable trading, deposit or withdrawal permissions.
3. Add it to `.env`:

   ```ini
   KRAKEN_API_KEY=<key>
   KRAKEN_API_SECRET=<private key>
   # starter | intermediate | pro, your account's verification tier (sets the rate limit)
   KRAKEN_TIER=starter
   # ISO 8601: how far back to reconcile. If empty, freqdash uses the time of its own first start and
   # ignores older Kraken orders. Set it to before your bots' first trade to check their whole history.
   RECON_START=
   ```

4. Apply it:

   ```bash
   docker compose up -d
   ```

The Status page shows the key's permission check and the order backfill. When the backfill finishes, the mode badge
switches to **Kraken**, the account total becomes the real one, and any Kraken order that no bot knows about appears as an
`ORPHAN_KRAKEN_ORDER` finding. Orders you placed by hand are expected there: open the finding and choose **Mark orders
manual** (section 9.1).

## 7. Optional: notifications, killswitch, assistant, API token, remote access

### 7.1 Notifications

**Web Push** works with no configuration: freqdash generates its keys on first start. Each user enables it per device
from the user menu (or **More** on a phone) → **Notifications** → **Enable on this device**. Each device chooses what it
receives: buys, sells, problems (by severity), problems clearing, and system messages.

- The page must be served over HTTPS (a plain `http://192.168…` address cannot receive push). See 7.5.
- On iPhone or iPad (iOS 16.4+), open freqdash in Safari, use Share → **Add to Home Screen**, then open it from the Home
  Screen and enable notifications there.

**Discord**: set `DISCORD_WEBHOOK_URL`. Findings below `NOTIFY_MIN_SEVERITY` (default `warning`) are not sent on any
channel. Test the whole path from Status → **Send test notification**.

### 7.2 Killswitch

When Kraken shows a runaway buyer, the killswitch stops the bots' containers and sends a critical alert. It trips per
pair, on more than `KILLSWITCH_MAX_BUYS_30S` (default 2) buys in 30 seconds or more than `KILLSWITCH_MAX_BUYS_10M`
(default 3) in 10 minutes. It watches Kraken's order stream, not the bots' records, so it needs the Kraken key.

freqdash never touches the Docker socket. The separate `killswitch-agent` container
([`tools/killswitch-agent/agent.mjs`](tools/killswitch-agent/agent.mjs), about 120 lines with no dependencies) holds the
socket and can only `docker stop` the containers you allow, for a caller with the shared token. It publishes no host
port.

1. Set in `.env`:

   ```ini
   FT_BOT_1_CONTAINER=freqtrade-bot1
   KILLSWITCH_TOKEN=<24+ random characters>
   KILLSWITCH_ALLOWED=freqtrade-bot1
   KILLSWITCH_AGENT_URL=http://freqdash-killswitch:9100
   KILLSWITCH_MODE=dry-run
   ```

   `KILLSWITCH_ALLOWED` must list the same container names as the `FT_BOT_n_CONTAINER` values.

2. Run `docker compose up -d`. `docker logs freqdash-killswitch` shows every stop and every rejected request.
3. Leave it in `dry-run` for a few days. It alerts "would trip" and stops nothing. When you trust it, set
   `KILLSWITCH_MODE=armed` and run `docker compose up -d` again.

After a trip the killswitch latches: the red banner stays, and freqdash never starts a container. Check Kraken, find the
cause, start the bots yourself with `docker start <container>`, then press Status → **Reset killswitch**.

Kraken open orders are polled every 15 seconds, so a stop lands roughly 15 to 45 seconds after the tripping buy. A
bot buying faster than that can place a few more orders first. The agent's Docker socket is root on the host: keep its
token secret and `KILLSWITCH_ALLOWED` short.

### 7.3 Built-in assistant

freqdash has a chat assistant in a pane on the right of the app. It answers questions about your bots, trades, fees,
findings and strategies from the same live data the dashboard shows, and it can act inside freqdash: silence or
unsilence findings, acknowledge orders and holdings, send a test notification and reset the killswitch. It cannot place
or cancel orders, and it cannot start, stop or reconfigure a bot.

It runs on any API that speaks the OpenAI Chat Completions format with streaming and tool (function) calling: OpenAI
itself, a gateway such as OpenRouter, or a local server such as Ollama or LM Studio. You configure it in the app, not
in `.env`.

**Set it up**

1. Open the user menu (top right) → **Settings** → **Assistant**.
2. Turn on **Enable the assistant**.
3. **API base URL**: the endpoint up to and including `/v1`, for example `https://api.openai.com/v1`. For a local server
   on the same host, use `http://host.docker.internal:<port>/v1` (for Ollama, port 11434).
4. **API key**: paste your key. It is stored encrypted with `SESSION_SECRET`, never shown again and never sent to the
   browser. A local server that ignores keys still needs a placeholder of 8 or more characters.
5. **Model**: pick one from the list, which freqdash loads from the provider's `/models` endpoint once the URL and key
   are filled in. There is no default model. Choose one that supports tool calling; a model without it can chat but
   cannot read your data.
6. Press **Test connection**, then **Save**.

Open the pane with the **Assistant** (sparkle) button in the top bar; on a phone it opens full screen. The conversation
survives collapsing the pane and moving between pages.

**Approvals.** Every action waits for you to press Approve or Decline on its card, with the exact arguments one click
away. **Run actions without asking** lets routine actions run straight away, but resetting the killswitch always asks.
Sending a new message while an action waits drops that action.

**Other settings on the same tab**

- **Notes for the assistant**: free text it sees in every chat, such as strategy notes or house rules. Do not put
  secrets there.
- **Max steps per answer** (default 8): how many model calls one answer may use. Each tool lookup is a step, so this
  caps the cost of a single question.
- **Memories** (its own tab): durable facts the assistant saved, such as your preferences and the conclusions of an
  investigation. It sees them in every chat; you can review, add and delete them there.

**Privacy and cost.** To answer, the assistant sends your live data to the API you configured: balances, trades,
findings, bot configuration and strategy source. Use an endpoint you trust, or a local model. Text from bot logs and
order data is passed to the model as data, never as instructions. Tool results are capped, and only the last 40
messages of a chat are sent, but every answer is billed by your provider.

The assistant is separate from the read-only API token in 7.4. That token is for scripts and outside AI agents, and it
cannot reach the assistant's settings, chats or memories.

### 7.4 Read-only API token for scripts and AI agents

Set `AGENT_API_TOKEN` to 32 or more random characters to allow `GET` requests under `/api/v1/` with a bearer token:

```bash
curl -s -H "Authorization: Bearer $AGENT_API_TOKEN" http://localhost:8043/api/v1/summary
```

The token cannot reach anything that changes state, nor the assistant's settings, chats or push subscriptions. The
endpoints and response shapes are documented in [AGENTS.md](AGENTS.md); the types are in `src/shared/types/`. Leave the
variable empty to turn the token off.

### 7.5 Reaching it from outside your network

freqdash listens on plain HTTP on port 8043. For HTTPS (required for Web Push) and remote access, put it behind a reverse
proxy or a Cloudflare Tunnel that points at `http://freqdash:3000` on the Docker network, then:

- add the public URL to `APP_ORIGINS` and set `APP_PUBLIC_URL` to it (used in notification links);
- set `TRUST_PROXY=cloudflare` if the proxy is Cloudflare, so login rate limiting sees the real client address;
- leave `COOKIE_SECURE=auto`, which marks the session cookie secure when the proxy forwards HTTPS.

The login is rate limited and asks for a captcha after two failed attempts, but a password is the only factor. Use strong
passwords before exposing it.

## 8. Configuration reference

All configuration is in `.env`. `.env.example` has a comment on every variable. Changes take effect after
`docker compose up -d`.

**Docker**

| Variable      | Default  | Meaning                                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `BOT_NETWORK` | required | Existing Docker network freqdash joins to reach the bots (3.3). Read by Compose, not by the app. |

**Access**

| Variable                                 | Default  | Meaning                                                                                                                                                                                                 |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                         | required | 32+ characters. Encrypts the secrets stored in the database. Rotating it signs no one out, but you must re-enter the assistant key, and devices using generated push keys must re-enable notifications. |
| `APP_ORIGINS`                            | empty    | Comma-separated origins allowed to send changes, besides the request's own Host.                                                                                                                        |
| `APP_PUBLIC_URL`                         | empty    | Public URL, used in notification links.                                                                                                                                                                 |
| `TRUST_PROXY`                            | `none`   | `none` or `cloudflare` (trust `cf-connecting-ip`).                                                                                                                                                      |
| `COOKIE_SECURE`                          | `auto`   | `auto`, `true` or `false`.                                                                                                                                                                              |
| `SESSION_MAX_AGE_DAYS`                   | `30`     | Idle timeout of a sign-in, 1 to 365. A sign-in also ends after 90 days (or this, if longer).                                                                                                            |
| `AGENT_API_TOKEN`                        | empty    | Read-only bearer token, 32+ characters (7.4).                                                                                                                                                           |
| `AUTH_RESET_USER`, `AUTH_RESET_PASSWORD` | empty    | Add an account or reset its password (9.3).                                                                                                                                                             |

**Bots** (`n` is 1 to 10; at least one bot is required)

| Variable                                 | Default  | Meaning                                                      |
| ---------------------------------------- | -------- | ------------------------------------------------------------ |
| `FT_BOT_n_ID`                            | required | Slug, `a-z0-9-`, up to 32 characters, unique.                |
| `FT_BOT_n_NAME`                          | the ID   | Display name, up to 40 characters.                           |
| `FT_BOT_n_URL`                           | required | API base URL as seen from freqdash, without credentials.     |
| `FT_BOT_n_USERNAME`, `FT_BOT_n_PASSWORD` | required | The bot's `api_server` credentials.                          |
| `FT_BOT_n_LOGFILE`                       | empty    | Log file path inside the container, e.g. `/ftlogs/bot1.log`. |
| `FT_BOT_n_CONTAINER`                     | empty    | Docker container name, needed only for the killswitch.       |
| `FT_BOT_n_COLOR`                         | palette  | `#RRGGBB` used for the bot in charts.                        |

**Kraken**

| Variable                              | Default                  | Meaning                                                                                                  |
| ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `KRAKEN_API_KEY`, `KRAKEN_API_SECRET` | empty                    | Read-only key (section 6). Set both or neither.                                                          |
| `KRAKEN_TIER`                         | `starter`                | `starter`, `intermediate` or `pro`.                                                                      |
| `KRAKEN_API_BASE_URL`                 | `https://api.kraken.com` | Change only for testing.                                                                                 |
| `RECON_START`                         | freqdash's first start   | ISO 8601 start of reconciliation. Set it before your bots' first trade to reconcile their whole history. |

**Notifications**

| Variable                                | Default                   | Meaning                                                                  |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `DISCORD_WEBHOOK_URL`                   | empty                     | Discord webhook for findings.                                            |
| `NOTIFY_MIN_SEVERITY`                   | `warning`                 | `info`, `warning` or `critical`.                                         |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated                 | Web Push keys. Changing them makes every device re-enable notifications. |
| `VAPID_SUBJECT`                         | `APP_PUBLIC_URL` if HTTPS | `mailto:` or `https:` contact for push services.                         |

**Killswitch**

| Variable                  | Default | Meaning                                                               |
| ------------------------- | ------- | --------------------------------------------------------------------- |
| `KILLSWITCH_MODE`         | `off`   | `off`, `dry-run` or `armed`. Anything but `off` needs the Kraken key. |
| `KILLSWITCH_MAX_BUYS_30S` | `2`     | Trips on more buys than this of one pair in 30 s.                     |
| `KILLSWITCH_MAX_BUYS_10M` | `3`     | Trips on more buys than this of one pair in 10 min.                   |
| `KILLSWITCH_AGENT_URL`    | empty   | `http://freqdash-killswitch:9100`. Required when armed.               |
| `KILLSWITCH_TOKEN`        | empty   | Shared with the agent, 24+ characters. Required when armed.           |
| `KILLSWITCH_ALLOWED`      | empty   | Containers the agent may stop. Read by the agent.                     |

**Runtime**

| Variable             | Default            | Meaning                                              |
| -------------------- | ------------------ | ---------------------------------------------------- |
| `POLLER_ENABLED`     | `true`             | `false` serves the UI without polling anything.      |
| `LOG_BACKFILL_HOURS` | `96`               | Hours of past log read on the first start, 1 to 720. |
| `LOG_LEVEL`          | `info`             | `debug`, `info`, `warn` or `error`.                  |
| `DATA_DIR`           | `/data` in Compose | Where the SQLite database lives.                     |

## 9. Day to day: findings, updates, backups, accounts, logs

[docs/RUNBOOK.md](docs/RUNBOOK.md) covers each of these in more detail.

### 9.1 Label, silence or revoke a finding

Open a finding to see its evidence, what to do next and the actions available:

| Situation                                                 | Action                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Orders you placed yourself, or old history you know about | **Mark orders manual** or **Ignore orders**                                                  |
| A coin you hold on purpose                                | **Mark holding manual** (the quantity is prefilled; holding more than that is flagged again) |
| Noise you understand                                      | **Silence** with a note. It comes back by itself if the finding gets worse.                  |
| A label you set by mistake                                | Status → Acknowledgements → **Revoke**                                                       |

### 9.2 Update and back up

Update (database migrations run at start):

```bash
git pull
```

```bash
docker compose up -d --build
```

Back up the database from the `freqdash-data` volume. Copying while it runs is safe if you also copy `freqdash.db-wal`
when it exists; otherwise stop the container first.

```bash
docker run --rm -v freqdash_freqdash-data:/d -v "$PWD":/b busybox sh -c 'cp /d/freqdash.db* /b/'
```

Compose prefixes the volume with the project name, which is the directory name (`freqdash_` by default). Check the
actual name with `docker volume ls`.

### 9.3 Accounts, passwords and sessions

- Change a password: user menu → **Account and sessions** → **Change password**. This ends that user's other sessions.
- End a session on another device from the same page.
- **Add an account** (for a partner, say): set `AUTH_RESET_USER=<new username>` (letters, digits, `.`, `_`, `-`) and
  `AUTH_RESET_PASSWORD=<temporary, 12+ characters>` in `.env`, run `docker compose up -d`, then remove both lines. The
  account exists from that start; give the person the temporary password, and they choose their own at the first
  sign-in. Every account has the same access, including resetting the killswitch and the assistant settings. freqdash
  has no screen for removing or renaming accounts.
- **Forgotten password:** set `AUTH_RESET_USER=<username>` and `AUTH_RESET_PASSWORD=<temporary, 12+ characters>` in `.env`,
  run `docker compose up -d`, sign in with it, choose a new password, then remove both lines. Each pair is applied once.
- After two failed sign-ins the form asks for a captcha. Five failures from one address lock it out for 15 minutes.

### 9.4 Logs and data retention

`docker logs freqdash` prints JSON lines with secrets, webhook URLs and tokens redacted. freqdash keeps order events for
365 days, other events and resolved findings for 90 days, and the notification log for 30 days. Equity snapshots and Kraken
orders are kept indefinitely.

## 10. Troubleshooting

Each row pairs a symptom with its likely cause.

| Symptom                                                    | Likely cause                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container restarts; log says `Invalid configuration`       | A variable listed in the message is missing or malformed. Fix it in `.env` and run `docker compose up -d`.                                                                                                                                                                               |
| `required variable BOT_NETWORK is missing a value`         | Set `BOT_NETWORK` in `.env` (3.3).                                                                                                                                                                                                                                                       |
| `network ... declared as external, but could not be found` | `BOT_NETWORK` names a network that does not exist. Check `docker network ls` (3.3).                                                                                                                                                                                                      |
| Bot shows **Unreachable** (`BOT_UNREACHABLE`)              | freqdash and the bot are not on the same network, the URL uses the wrong container name or port, or `listen_ip_address` is `127.0.0.1`. Test from inside freqdash: `docker exec freqdash node -e "fetch('http://freqtrade-bot1:8080/api/v1/ping').then(r=>r.text()).then(console.log)"`. |
| `BOT_AUTH_FAILED`                                          | `FT_BOT_n_USERNAME` / `PASSWORD` do not match the bot's `api_server` block.                                                                                                                                                                                                              |
| `LOG_TAIL_UNAVAILABLE`                                     | `FT_BOT_n_LOGFILE` is not set, or the path is wrong inside the container. Check with `docker exec freqdash ls /ftlogs`.                                                                                                                                                                  |
| Bot events appear at the wrong time                        | The bot container is not on UTC (3.2).                                                                                                                                                                                                                                                   |
| No `temporaryPassword` line in `docker logs freqdash`      | The database already had an account (an earlier start, or `AUTH_RESET_USER` created one). Reset a password as in 9.3.                                                                                                                                                                    |
| Sign-in fails with a forbidden error behind a proxy        | Add the URL you use to `APP_ORIGINS`.                                                                                                                                                                                                                                                    |
| Mode stays **Freqtrade-only** with a key set               | Open Status: the permission check names any missing Kraken permission or key error.                                                                                                                                                                                                      |
| `EAPI:Invalid nonce` in a bot's log                        | freqdash and the bot share a Kraken key. Create a separate key for freqdash (section 6).                                                                                                                                                                                                 |
| Red "monitoring stalled" banner                            | The poller has not finished a cycle for 60 s. Check `docker logs freqdash`; the container restarts itself when unhealthy.                                                                                                                                                                |

## 11. Development

You can run the whole app against a mock of freqtrade, Kraken and Discord, with no real credentials:

```bash
npm ci
```

```bash
npm run mock
```

In a second terminal:

```bash
cp .env.dev.example .env.local
```

```bash
npm run dev
```

Set `POLLER_ENABLED=true` in `.env.local` so the app polls the mock, then open `http://localhost:3000`. The mock can replay
scenarios such as a crash loop or an unreachable bot:

```bash
curl -s -X POST localhost:9999/__scenario -H 'Content-Type: application/json' -d '{"name":"incident"}'
```

Other scenarios are `normal`, `bot-down`, `kraken-auth-error` and `no-kraken`. See
[test/mock-upstreams/README.md](test/mock-upstreams/README.md).

The npm scripts:

| Script                            | What it does                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `npm run dev` / `build` / `start` | Next.js                                                        |
| `npm run typecheck`               | `tsc --noEmit`                                                 |
| `npm run lint`                    | ESLint                                                         |
| `npm test` / `npm run coverage`   | Vitest (coverage gate of 90 % for `checks/` and `accounting/`) |
| `npm run verify`                  | Typecheck, lint and test                                       |
| `npm run format`                  | Prettier                                                       |
| `npm run mock` / `e2e` / `shot`   | Mock upstreams, Playwright end-to-end tests, screenshots       |

`docker build --target test .` runs `npm run verify` inside the image, and
`docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from e2e` runs the end-to-end tests
in containers.

### Source layout

```
src/app/            pages ((app)/*), api/health, api/v1/*, api/auth/*
src/components/     UI
src/server/         config, poller, freqtrade and Kraken clients, log tailer, checks, accounting, auth, notify, killswitch
src/shared/         types shared by server and client (frozen contracts), constants
tools/              killswitch agent
test/               fixtures and mock upstreams
docs/               PLAN.md (architecture), RUNBOOK.md (operations)
```

### Code conventions

- The shared contracts in `src/shared/types` and `src/server/checks/types.ts` are frozen; propose changes rather than
  editing them.
- Runtime state lives on `globalThis[Symbol.for('freqdash.*')]` and in SQLite, never in module singletons: Next bundles
  `instrumentation.ts` and each route separately.
- Every server module imports `server-only`. Tests alias it to a no-op (see `vitest.config.mts`).
- Configuration is read lazily through `getConfig()`, so `next build` needs no environment. Errors name variables, never
  values. `redactSecrets()` masks webhook URLs, JWTs, `token=`, auth headers and every configured secret.
- There are no `NEXT_PUBLIC_*` variables; secrets stay on the server.
- Next.js 16 differs from older versions (`proxy.ts` replaces `middleware.ts`, `params` is async, there is no `next lint`).
  Version-matched docs ship in `node_modules/next/dist/docs/`.
- `checks/` and `accounting/` are pure: ESLint forbids file system, database, network and `Date.now()` there, and time is
  passed in as `now`.
- After renaming or deleting a route, remove `.next` if `tsc` complains about a stale `.next/types/validator.ts`.

## License

MIT. See [LICENSE](LICENSE).

freqdash is not affiliated with freqtrade or Kraken. It only reads data, but it monitors live trading: you are
responsible for your bots, your keys and your money.

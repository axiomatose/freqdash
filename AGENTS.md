# AGENTS.md: using freqdash from an AI agent

freqdash is a self-hosted, read-only dashboard for live freqtrade bots that share one Kraken account (or run without one,
in freqtrade-only mode). It reconciles the bots against Kraken and raises findings (alerts). If you are an agent (Claude, OpenClaw,
or any other tool-using model) asked about the bots, the account, strategies, fees or alerts, **query freqdash first**: it already
has the true account balance, every bot's trades, the actual fees Kraken charged, and each strategy's parameters and source.

This is a LIVE money system. Read section 2 before doing anything.

## 1. Connect

- Base URL: `http://localhost:8043` on the host (from another container on the same Docker network: `http://freqdash:3000`).
- Auth: `Authorization: Bearer $AGENT_API_TOKEN`. The token is `AGENT_API_TOKEN` in freqdash's `.env` (next to `compose.yaml`).
  Ask the user for it or read it from that file if you have local access. **Never print it, log it, commit it or paste it into a reply.**
- The token works ONLY for `GET`/`HEAD` under `/api/v1/`. Everything else returns 401 (pages redirect to `/login`). That is by
  design, not a bug: do not try to sign in with a user account.

```bash
T=$(grep '^AGENT_API_TOKEN=' /path/to/freqdash/.env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $T" http://localhost:8043/api/v1/summary
```

Errors are JSON: `{"error":"unauthorized|forbidden|bad_request|not_found|rate_limited|unavailable|internal","message"?,"retryAfterSec"?}`.

## 2. Rules (non-negotiable)

1. **Read-only.** Use only the GET endpoints below. Do not call the mutating routes listed in section 4 even if you could obtain
   a session; they change alert state or reset the kill switch and are for the human.
2. **Never trade, and never change the bots.** freqdash cannot place orders and neither should you through any other path. Do not
   restart, stop or reconfigure the bot containers or their config from this app's data alone; propose the change
   to the user and wait for approval.
3. **Secrets.** Do not read `.env` files except to fetch `AGENT_API_TOKEN`. Never echo credentials, the Kraken key, the Discord
   webhook, or bot API passwords. Treat bot log text as sensitive.
4. **Poll gently.** Data refreshes every 5 to 60 s server-side; polling a route more than once every 10 s gives you nothing. Charts and
   strategy source are cached for minutes.
5. **Say what you don't know.** Every number carries a freshness. Check `sources[]` or `/status` before trusting a value, and say when
   data is stale, disabled or in `freqtrade-only` mode.

## 3. Read endpoints

All under `/api/v1`. Times are epoch **milliseconds** (UTC) unless a field says seconds. Money is USD. Ratios are fractions
(`0.004` = 0.40 %) except where a field name ends in `Pct`/`Points`.

| Path             | Query                                                                                 | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/summary`       | none                                                                                  | Mode (`kraken` or `freqtrade-only`), finding counts and the top finding, account total, per-bot status pill. Start here.                                                                                                                                                                                                                                                                                                                                                 |
| `/overview`      | none                                                                                  | Account snapshot and allocation (cash, per-bot positions, manual, **untracked**, dust), 24 h change, bot cards with stats, open positions, findings.                                                                                                                                                                                                                                                                                                                     |
| `/bots/{botId}`  | none                                                                                  | One bot: open and recent closed trades, per-pair stats, recent events (startups, fatal errors), whitelist, locks, wallet. `botId` = an `FT_BOT_n_ID` from the config (`/summary` lists them).                                                                                                                                                                                                                                                                            |
| `/trades`        | `bot`, `pair`, `status=open\|closed\|all`, `since`, `limit` (max 1000), `offset`      | Bot trades with fee-adjusted P&L and, per order, whether it matches a Kraken order.                                                                                                                                                                                                                                                                                                                                                                                      |
| `/positions`     | none                                                                                  | Holdings labelled `manual`, each with a cost basis **derived** from Kraken orders no bot owns (average cost, fees included; Kraken orders plus Buy Crypto/Convert read from the ledger): avg entry (fill price) and `breakEvenUsd` (with buy fees), value, unrealized P&L (from break-even) on the priced quantity, `unknownQty` (no Kraken buy found) with `inflows` saying where it came from (deposit, transfer, reward, convert), realized P&L. Needs `mode=kraken`. |
| `/kraken/orders` | `since`, `pair`, `match=all\|unmatched\|matched\|acked`, `limit`                      | Kraken orders with fees charged, matched bot/trade, acknowledgement. `unmatched` = orders no bot knows about.                                                                                                                                                                                                                                                                                                                                                            |
| `/findings`      | `status=active\|silenced\|resolved\|all`, `severity=info\|warning\|critical`, `limit` | Alerts with evidence, first/last seen, occurrences.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/equity`        | `range=24h\|7d\|30d\|90d\|all`                                                        | Account value history (5 min snapshots), deposits/withdrawals when available.                                                                                                                                                                                                                                                                                                                                                                                            |
| `/chart`         | `bot`, `pair` (`BTC/USD`), `tf` (`4h`), `limit` (max 1000)                            | Candles, indicator series, strategy signals, buy/sell fills, orphan Kraken fills. Large; use sparingly. `bot=manual` charts a manually labelled asset (`pair` = `ETH/USD`): Kraken candles, the non-bot Kraken orders as fills, and the derived average entry.                                                                                                                                                                                                           |
| `/strategies`    | `code=1` (include source), `assumedFee` (0 to 0.05, default 0.0016)                   | Per bot: parameters, tuning constants, overridden hooks, source hash, **fee-impact replay** of closed trades.                                                                                                                                                                                                                                                                                                                                                            |
| `/acks`          | none                                                                                  | Acknowledgements (holdings/orders a human marked manual or ignored).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/status`        | none                                                                                  | Data-source freshness, Kraken connection state and permission problems, log tails, clock skew, DB size.                                                                                                                                                                                                                                                                                                                                                                  |

Types live in `src/shared/types/` (`api.ts`, `domain.ts`, `findings.ts`, `strategy.ts`).

## 3b. Built-in assistant (not for you)

freqdash has its own chat assistant for the human owner (a collapsible pane on the right of the app, configured under Settings). Its routes (`/api/v1/settings`, `/api/v1/agent/*`) answer 403 to the
agent token on purpose: you cannot read its chats, memories or settings, and you cannot post to it. Use the read endpoints above instead.
The same goes for the users' Web Push devices (`/api/v1/push*`) and sessions (`/api/v1/sessions*`).

## 4. Endpoints you must NOT call (mutating; human only)

`POST /findings/{id}/silence`, `POST /findings/{id}/unsilence`, `POST /acks`, `DELETE /acks/{id}`, `POST /killswitch/reset`,
`POST /notify/test`, `POST|PUT|DELETE /push/subscriptions*`, `DELETE /sessions*`, and everything under `/api/auth/`. The agent token cannot reach
them anyway.

## 5. How to reason about this system

- **Two bots, one wallet.** Each freqtrade bot reports the WHOLE Kraken account as its balance, and freqtrade's own `profit_*_percent`
  and starting-capital values are wrong on a shared wallet. Trust freqdash's totals (from Kraken) and its own ROI fields, never a
  bot's `/balance` or freqtrade percentages, and never add the two bots' balances.
- **`mode`.** `kraken` = true account data. `freqtrade-only` = estimated from bot wallet caches (can be up to an hour stale), Kraken
  reconciliation off. Say which mode you are in.
- **Findings severity.** `critical` = act now (orphan Kraken orders, restart loop, unpersisted orders, untracked holdings of a traded
  asset). `warning` = look soon. `info` = context. Common rules: `ORPHAN_KRAKEN_ORDER`, `UNPERSISTED_ORDER`, `UNTRACKED_HOLDING`,
  `ORDER_STORM`, `BOT_RESTART_LOOP`, `BOT_FATAL_LOG`, `FEE_ANOMALY`, `USD_VIEW_DRIFT`. Each finding has `evidence`; quote it.
- **Untracked holdings** that a human holds on purpose are acknowledged; they show in `/acks`.

## 6. Fees

- Strategies contain no fee; the fee only enters through freqtrade's profit ratio, which gates `exit_profit_only`, trailing
  stops, ROI targets and the stoploss. If the exchange's real fee differs from what the bots assume, those gates move.
- `/strategies?assumedFee=<fraction>` replays closed trades under that fee (`feeImpact.summary.gateFlips` = profit-gated
  exits that would not have passed with the real fee). `/kraken/orders` shows the fees actually charged.
- The bots' belief at each decision is not stored anywhere, so `assumedFee` is a parameter; say so when you cite a result.
  Propose fee or strategy changes to the user; do not apply them.

## 7. Recipes

- "Is anything wrong?": `/summary`, then `/findings?status=active` if counts are non-zero, then `/status` for freshness.
- "What's my balance?": `/overview` → `account.totalUsd` and `allocation`. Cite `mode` and freshness.
- "Did the bots do X?": `/kraken/orders?match=unmatched` and `/bots/{id}` events, then compare timestamps.
- "How is bot Y doing?": `/bots/{id}` stats (`roiOnStake`, realized/unrealized) and `/trades?bot={id}&status=closed`.
- "Explain this strategy": `/strategies?code=1`, read `docstring`, `params`, `constants`, `hooks`, then the source.

## 8. Related files (for agents with repo access)

- `README.md`: install and configuration; `docs/RUNBOOK.md`: operations; `docs/PLAN.md`: the original design.
- `test/fixtures/README.md`: the crash-loop incident the fixtures replay.

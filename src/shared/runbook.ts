// Operator guidance shown next to every finding ("what to do", docs/PLAN.md section 9, Findings page).
// Rules for this text: only safe, reversible first steps; never ask for a secret to be pasted, posted or shared
// (API keys, passwords, webhook URLs, tokens stay in the environment files); freqdash itself is read-only, so every
// remedy is an action the operator takes on Kraken or on the bots.
import type { RuleId } from './types/findings';

export interface RunbookEntry {
  summary: string;
  steps: string[];
}

export const RUNBOOK: Record<RuleId, RunbookEntry> = {
  BOT_UNREACHABLE: {
    summary: "freqdash cannot reach the bot's API. The bot may be down, restarting, or the network path is broken.",
    steps: [
      'Open the bot page and check "last seen" and the recent events (restarts, fatal errors).',
      'Check the container: `docker ps` and `docker logs --tail 100 <bot container>` on the host.',
      'If it is restarting in a loop, see "Restart loop"; if it is stopped, start it again from your usual tooling.',
      'Once it answers, confirm in freqdash that its open trades and wallet look right before trusting it again.',
    ],
  },
  BOT_AUTH_FAILED: {
    summary: 'The bot rejected the API credentials freqdash uses (HTTP 401/403).',
    steps: [
      "Check whether the bot's API username or password changed in its own configuration.",
      "Update the matching value in freqdash's environment file on the host (never in chat, tickets or screenshots), then restart the freqdash container.",
      'Until this is fixed freqdash cannot see that bot, so treat every other alert for it as blind.',
    ],
  },
  BOT_STALE_PROCESS: {
    summary: "The bot's API answers but its trading loop has not run for minutes: the process is hung.",
    steps: [
      'Look at the bot log for the last lines before the silence (`docker logs --tail 200 <bot container>`).',
      'Check open trades on the bot page and on Kraken: a hung bot does not manage stops or exits.',
      'Restart the bot container when the log shows no progress; verify afterwards that the wallet and open trades match Kraken.',
    ],
  },
  BOT_NOT_RUNNING: {
    summary: 'The bot is up but its state is not "running" (stopped or paused), so it will not open or close trades.',
    steps: [
      'Find out who stopped it: check the bot log and your chat/notification history.',
      'If the stop was intended, silence this finding with a note. If not, start the bot again from its own UI or command line.',
      'Review open trades: a stopped bot still holds positions but no longer manages exits.',
    ],
  },
  BOT_RESTARTED: {
    summary: 'The bot restarted in the last 30 minutes. Informational unless it keeps happening.',
    steps: [
      'Check the events on the bot page: a clean restart (deploy, update) is fine.',
      'If it restarted without you doing it, look for a crash (fatal error) in the events and the bot log.',
    ],
  },
  BOT_RESTART_LOOP: {
    summary:
      'The bot restarted several times within minutes: it is crash-looping. A crash loop can place orders that the bot forgets (see "Unpersisted order").',
    steps: [
      'Stop the loop first: stop the bot container so it cannot place more orders.',
      'Read the last fatal error in the events and in `docker logs --tail 300 <bot container>`.',
      'Open Kraken order history for the affected pair and compare with the bot\'s trades; unrecorded orders show up here as "Unpersisted order" and "Orphan Kraken order" findings.',
      'Fix the cause (configuration, exchange access, version), start the bot, and watch that it stays up before leaving it.',
    ],
  },
  BOT_IDENTITY_CHANGED: {
    summary:
      "The bot's database identity changed: its first-start time moved or its closed-trade count went down. History may have been reset or swapped.",
    steps: [
      'Ask whether the bot database or container volume was replaced, restored from a backup or deleted.',
      'Compare open trades on the bot page with the coins on Kraken; a reset database no longer knows its positions.',
      'If positions are missing from the bot, decide per position whether to sell on Kraken or keep, and acknowledge the affected holdings in freqdash.',
    ],
  },
  BOT_FATAL_LOG: {
    summary: 'The bot logged a fatal error or "process died" in the last hour: it crashed.',
    steps: [
      'Read the message in the finding detail and the surrounding lines in the bot log.',
      'Check that the bot is running again and that its open trades match Kraken.',
      'Look for "Unpersisted order" and "Orphan Kraken order" findings: a crash right after placing an order can lose the order.',
    ],
  },
  BOT_ERROR_LOG: {
    summary: 'The bot logged the same error (or failed order attempt) repeatedly in the last 30 minutes.',
    steps: [
      'Read the sample message in the finding evidence; failed order attempts usually name the exchange error.',
      'Exchange errors such as service unavailable or nonce errors are often transient; watch whether the count keeps growing.',
      'If it persists, check Kraken status, the bot configuration and the freqdash Status page.',
    ],
  },
  UNPERSISTED_ORDER: {
    summary:
      "The bot's log says it created orders that the bot itself never recorded. They may be filled on Kraken without any bot managing them.",
    steps: [
      'Open Kraken order history for the pair and match the order ids from the finding evidence.',
      'For each order decide: sell the coins on Kraken, or keep them on purpose.',
      'Then acknowledge the orders in freqdash (mark as manual or ignored) so this finding clears; acknowledge the holding too if you keep the coins.',
      'Find out why the bot lost them (see "Restart loop" or "Crash"); do not restart it unattended until that is understood.',
    ],
  },
  ORPHAN_KRAKEN_ORDER: {
    summary:
      'Kraken shows orders that no bot knows about. Another program, a manual trade, or a bot that lost its record placed them.',
    steps: [
      'Open Kraken order history and check each order id from the evidence: who placed it, and is it still open?',
      'If an order is still open and unwanted, cancel it on Kraken yourself. freqdash never cancels or places orders.',
      'Decide whether to sell or keep any coins it bought, then acknowledge the orders in freqdash.',
      'If a bot log line matches ("created by" in the evidence) treat it like an unpersisted order and check that bot for crashes.',
    ],
  },
  BOT_ORDER_MISSING_ON_KRAKEN: {
    summary: "A filled order in a bot's records does not exist in Kraken's order history.",
    steps: [
      'Check that the bot uses the same Kraken account as the API key freqdash reads, and that it is not in dry-run mode.',
      'Look up the order id in Kraken order history (search may need a wider date range).',
      'If the bot is trading a different account or a simulated one, its numbers do not describe this account. Silence with a note only when that is intended.',
    ],
  },
  ORDER_MISMATCH: {
    summary:
      'A bot and Kraken disagree about how much of an order was filled, or the bot still thinks a finished order is open.',
    steps: [
      'Wait a couple of minutes: a fill that has just happened is reported by Kraken first.',
      "If it persists, compare the order on Kraken with the bot's trade (bot page, expand the trade).",
      'A bot that shows an order open after Kraken closed it needs a look at its log; restarting it usually makes it re-read the exchange state.',
    ],
  },
  ORDER_STORM: {
    summary: 'Many order attempts on one pair within minutes: a runaway loop is buying or selling repeatedly.',
    steps: [
      'Stop the bot that is placing the orders now (stop its container); every minute costs fees and exposure.',
      'Open Kraken order history for the pair to see what was really filled and cancel any open orders you do not want.',
      'Decide per position whether to sell or keep, and acknowledge the orders in freqdash once handled.',
      'Do not restart the bot before you know the cause.',
    ],
  },
  FEE_ANOMALY: {
    summary: "A fee is higher than Kraken's schedule, missing, or different between the bot and Kraken.",
    steps: [
      'Compare the fee rate in the evidence with your Kraken fee tier (Kraken: Settings, Fee schedule).',
      'A maker order that was filled as taker, or a changed tier, explains most cases; nothing to fix in freqdash.',
      'Findings about trades older than 30 days are informational history.',
    ],
  },
  UNTRACKED_HOLDING: {
    summary: 'The account holds more of an asset than the bots explain, and it is not acknowledged.',
    steps: [
      'Check whether you bought or kept these coins yourself. If so, mark the holding as manual in freqdash (set the current quantity as baseline).',
      'If a bot is meant to trade this asset, look for "Unpersisted order" and "Orphan Kraken order" findings: it may have lost track of an order.',
      'A finding based on a bot wallet estimate (no Kraken key) can be stale; give it a few minutes before acting.',
    ],
  },
  BOT_OVERCLAIMS_HOLDING: {
    summary: 'The bots record more of an asset in open trades than the Kraken account holds.',
    steps: [
      'Check Kraken for a sell or a withdrawal of that asset that the bots do not know about.',
      "Compare the open trades on the bot pages with Kraken's balance; one of the records is wrong.",
      'If a position was sold outside the bot, close or delete that trade in the bot itself (its own UI); freqdash cannot change bot state.',
    ],
  },
  USD_VIEW_DRIFT: {
    summary:
      "A bot's cached wallet shows a different USD balance than Kraken. A stale wallet makes the bot size orders wrongly.",
    steps: [
      'A short difference right after a trade is normal and clears by itself.',
      'If it lasts, restart that bot so it re-reads the exchange balance, then check that the finding clears.',
      'Persistent drift after a restart means the bot and Kraken use different accounts or the bot cannot read the balance; check its log.',
    ],
  },
  KRAKEN_ERROR: {
    summary:
      'freqdash has trouble reading from Kraken: rejected key, missing permission, or lasting connection errors.',
    steps: [
      'Open the Status page and read the error and endpoint in the finding.',
      'Rejected key: check in Kraken that the read-only API key still exists and was not rotated; put the new key only in the freqdash environment file on the host.',
      'Missing permission: enable exactly the read-only permission named (Query funds, Query open orders and trades, Query closed orders and trades, optionally Query ledger entries). Never enable trading or withdrawal permissions.',
      'Temporary errors (service unavailable, rate limit, nonce, network) resolve by themselves; if they last, check status.kraken.com and the host clock.',
    ],
  },
  CLOCK_SKEW: {
    summary:
      "The host clock differs from Kraken's by more than a few seconds. Signed requests can be rejected and time-based checks become unreliable.",
    steps: [
      'Enable or repair time synchronization on the host (NTP / Windows Time service) and restart the freqdash container afterwards.',
      'Check that the container is not running with a manually set clock.',
    ],
  },
  LOG_TAIL_UNAVAILABLE: {
    summary: "freqdash cannot read the bot's log file, so crashes and lost orders of that bot go unnoticed.",
    steps: [
      "Check that the bot's log directory is mounted read-only into the freqdash container and that the file name in the freqdash configuration matches.",
      'Check that the bot still writes to that file (`docker logs` shows output, the file grows).',
      'Fix the mount or the path and recreate the freqdash container; the finding clears when a new line is read.',
    ],
  },
  NOTIFIER_FAILING: {
    summary: 'Notifications to Discord or push keep failing, so alerts are visible in freqdash only.',
    steps: [
      'Open the Status page and use the notification test button to see the error.',
      'Check that the webhook or topic still exists and that the freqdash host can reach it. If you regenerate a webhook, update it only in the freqdash environment file on the host.',
      'Until it works, look at the Findings page regularly.',
    ],
  },
};

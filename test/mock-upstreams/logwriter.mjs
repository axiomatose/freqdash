// Appends scenario log lines to <runDir>/<botId>.log in the real freqtrade format and keeps the per-bot ring buffer
// behind `/api/v1/logs`. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { formatLogTs, periodicLines } from './scenarios.mjs';

const RING_SIZE = 1000;

export class LogWriter {
  /** @param {{runDir: string, bots: string[], version: string}} options */
  constructor({ runDir, bots, version }) {
    this.runDir = runDir;
    this.bots = bots;
    this.version = version;
    this.state = new Map(bots.map((id) => [id, { file: path.join(runDir, `${id}.log`), ring: [], lines: 0 }]));
    this.cursor = 0;
    this.emittedUpTo = 0;
    this.warned = false;
    fs.mkdirSync(runDir, { recursive: true });
  }

  /** Starts a fresh log for a new scenario (or keeps the files when `truncate` is false) and rewinds the schedule. */
  reset(scenario, truncate = true) {
    this.cursor = 0;
    this.emittedUpTo = scenario.startedAt - 1;
    for (const s of this.state.values()) {
      s.ring.length = 0;
      if (truncate) {
        s.lines = 0;
        this.#write(s, '');
      }
    }
  }

  /** Writes every line with virtual time <= now that has not been written yet. */
  flush(scenario, now) {
    for (const [botId, s] of this.state) {
      const lines = [];
      if (botId === 'votemax' && scenario.plan) {
        const scheduled = scenario.plan.logLines;
        while (this.cursor < scheduled.length && scheduled[this.cursor].t <= now) lines.push(scheduled[this.cursor++]);
      }
      lines.push(...periodicLines(botId, scenario, this.emittedUpTo, now, this.version));
      if (lines.length === 0) continue;
      lines.sort((a, b) => a.t - b.t);
      this.#write(
        s,
        lines.map((l) => `${formatLogTs(l.t)} - ${l.logger} - ${l.level} - ${l.message}\n`).join(''),
        true,
      );
      s.lines += lines.length;
      for (const l of lines) {
        if (l.logger === 'freqtrade.loggers' && l.message === 'Logfile configured') s.ring.length = 0; // the process restarted
        if (l.level === 'ERROR' && l.message.startsWith('Fatal exception')) continue; // never visible through /logs
        s.ring.push(l);
        if (s.ring.length > RING_SIZE) s.ring.shift();
      }
    }
    this.emittedUpTo = Math.max(this.emittedUpTo, now);
  }

  records(botId, limit) {
    const ring = this.state.get(botId)?.ring ?? [];
    return limit ? ring.slice(-limit) : [...ring];
  }

  summary() {
    return Object.fromEntries([...this.state].map(([id, s]) => [id, { file: s.file, lines: s.lines }]));
  }

  #write(s, text, append = false) {
    try {
      if (append) fs.appendFileSync(s.file, text);
      else fs.writeFileSync(s.file, text);
    } catch (err) {
      if (!this.warned) console.warn(`[mock] cannot write ${s.file}: ${err instanceof Error ? err.message : err}`);
      this.warned = true;
    }
  }
}

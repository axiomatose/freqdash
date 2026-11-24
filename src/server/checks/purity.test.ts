// checks/ and accounting/ must stay pure (docs/PLAN.md section 10, WP3): no I/O, no database, no network, no clock,
// no randomness. ESLint enforces the same rules (eslint.config.mjs); this test repeats them so that a lint bypass or a
// config change cannot silently let impurity in, and it is the check that the scanner itself is not vacuous.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DIRS = ['src/server/checks', 'src/server/accounting'];

const FORBIDDEN_MODULES = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'path',
  'node:path',
  'os',
  'node:os',
  'child_process',
  'node:child_process',
  'http',
  'node:http',
  'https',
  'node:https',
  'net',
  'node:net',
  'undici',
  'better-sqlite3',
  'server-only',
]);
const IMPURE_DIRS = 'db|poller|freqtrade|kraken|logs|notify|state|views|mock';
const FORBIDDEN_PATHS = [
  new RegExp(`(^|/)server/(${IMPURE_DIRS})(/|$)`),
  new RegExp(`^(\\.\\.?/)+(${IMPURE_DIRS})(/|$)`),
];
const FORBIDDEN_CALLS: [string, RegExp][] = [
  ['fetch(', /(^|[^.\w])fetch\s*\(/],
  ['Date.now(', /\bDate\s*\.\s*now\s*\(/],
  ['new Date() without arguments', /\bnew\s+Date\s*\(\s*\)/],
  ['performance.now(', /\bperformance\s*\.\s*now\s*\(/],
  ['Math.random(', /\bMath\s*\.\s*random\s*\(/],
  ['setTimeout(', /(^|[^.\w])setTimeout\s*\(/],
  ['setInterval(', /(^|[^.\w])setInterval\s*\(/],
  ['process.', /\bprocess\s*\./],
  ['XMLHttpRequest / WebSocket', /\b(XMLHttpRequest|WebSocket)\b/],
];
const IMPORT =
  /(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Removes comments (naively, which is enough to keep prose out of the scan). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export function violations(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const m of code.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    if (FORBIDDEN_MODULES.has(spec) || FORBIDDEN_PATHS.some((re) => re.test(spec))) found.push(`import of ${spec}`);
  }
  for (const [name, re] of FORBIDDEN_CALLS) if (re.test(code)) found.push(name);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe('purity scanner', () => {
  it('catches every kind of forbidden import and call', () => {
    const bad = [
      "import fs from 'fs';",
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'path';",
      "import Database from 'better-sqlite3';",
      "import { getDb } from '@/server/db';",
      "import { getDb } from '../db/client';",
      "import { x } from '@/server/kraken/private';",
      "import { y } from '@/server/freqtrade/client';",
      "import 'server-only';",
      "const m = await import('node:http');",
      "const f = require('undici');",
      "export { z } from '@/server/poller/scheduler';",
      'const r = await fetch(url);',
      'const t = Date.now();',
      'const d = new Date();',
      'const p = performance.now();',
      'const q = Math.random();',
      'setTimeout(() => 1, 5);',
      'const e = process.env.X;',
    ];
    for (const src of bad) expect(violations(src), src).not.toEqual([]);
  });

  it('accepts pure code, dated arguments, member calls named fetch, and mentions in comments', () => {
    const good = [
      "import { withPnl } from '@/server/accounting';",
      "import type { CheckInput } from './types';",
      'const d = new Date(1_790_000_000_000).toISOString();',
      'const t = input.now;',
      'client.fetch(x);',
      '// never call Date.now() or fetch( here',
      '/* import fs from "fs" */ const a = 1;',
      "const url = 'https://example.org/x'; const n = 1;",
    ];
    for (const src of good) expect(violations(src), src).toEqual([]);
  });
});

describe('src/server/checks and src/server/accounting are pure', () => {
  const files = DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));

  it('scans a meaningful set of files (every rule, the engine, the lifecycle, the accounting modules)', () => {
    const names = files.map((f) => f.replace(/\\/g, '/'));
    for (const must of [
      'checks/engine.ts',
      'checks/lifecycle.ts',
      'checks/util.ts',
      'checks/rules/unpersistedOrder.ts',
      'accounting/pnl.ts',
      'accounting/allocation.ts',
    ]) {
      expect(
        names.some((n) => n.endsWith(must)),
        must,
      ).toBe(true);
    }
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it.each(files.map((f) => [f.slice(ROOT.length + 1).replace(/\\/g, '/'), f] as const))(
    '%s has no forbidden import or call',
    (_name, file) => {
      expect(violations(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );
});

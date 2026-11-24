#!/usr/bin/env node
// Screenshot tool for the UI work packages.
//
//   npm run shot -- --base http://localhost:3100 --routes / /findings "/chart?bot=votemax" --out shots/wp6
//
// For every route it saves <out>/<slug>-desktop.png (1440x900) and <out>/<slug>-mobile.png (390x844, touch,
// deviceScaleFactor 2, iPhone-14-like), and reports horizontal overflow and console errors per shot.
// Login: reads SHOT_USERNAME (default admin) and SHOT_PASSWORD from --env (default .env.local) or the environment and
// POSTs them to /api/auth/login once; when that route answers 404 (auth not built yet) login is skipped. The account
// must already have a permanent password. The password is never printed.
//
// Options
//   --base <url>        app origin (default $SHOT_BASE or http://localhost:3000)
//   --routes <r...>     one or more paths (default /)
//   --out <dir>         output directory (default shots/manual)
//   --only <desktop|mobile>
//   --selector <css>    screenshot just this element instead of the page
//   --no-full           viewport-sized capture instead of the full scrollable page
//   --wait <ms>         settle time after load (default 700)
//   --env <file>        env file holding SHOT_USERNAME / SHOT_PASSWORD (default .env.local)
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
};

// ---- arguments --------------------------------------------------------------------------------------------------

/** Git Bash rewrites a bare "/x" argument into "C:/Program Files/Git/x"; undo that. */
function fixMsysPath(arg) {
  if (!/^[A-Za-z]:[\\/]/.test(arg)) return arg;
  const candidates = [process.env.EXEPATH, process.env.MSYS2_PREFIX, 'C:/Program Files/Git', 'C:/Program Files (x86)/Git']
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''));
  const normalized = arg.replace(/\\/g, '/');
  for (const c of candidates) {
    if (normalized.toLowerCase().startsWith(c.toLowerCase())) return normalized.slice(c.length) || '/';
  }
  return arg;
}

function parseArgs(argv) {
  const opts = { routes: [], full: true, wait: 700, base: process.env.SHOT_BASE ?? 'http://localhost:3000', out: 'shots/manual', env: '.env.local' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--routes') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.routes.push(fixMsysPath(argv[++i]));
    } else if (a === '--base') opts.base = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--only') opts.only = next();
    else if (a === '--selector') opts.selector = next();
    else if (a === '--no-full') opts.full = false;
    else if (a === '--wait') opts.wait = Number(next());
    else if (a === '--env') opts.env = next();
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.routes.length === 0) opts.routes.push('/');
  opts.base = opts.base.replace(/\/+$/, '');
  return opts;
}

function readEnvValue(envFile, key) {
  if (process.env[key]) return process.env[key];
  try {
    const text = readFileSync(resolve(root, envFile), 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch {
    return null;
  }
}

function slug(route) {
  const path = route.replace(/^https?:\/\/[^/]+/, '');
  const s = path
    .replace(/[?#].*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-');
  const rest = /[?#](.*)$/.exec(path)?.[1];
  const suffix = rest ? `-${rest.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}` : '';
  return `${s || 'home'}${suffix}`.replace(/-+$/, '');
}

// ---- login ------------------------------------------------------------------------------------------------------

async function login(browser, opts) {
  const probe = await fetch(`${opts.base}/api/auth/login`).catch(() => null);
  if (!probe) throw new Error(`Cannot reach ${opts.base}. Is the dev server running?`);
  if (probe.status === 404) {
    console.log('login: /api/auth/login is 404 (auth not built yet), skipping login');
    return undefined;
  }
  const username = readEnvValue(opts.env, 'SHOT_USERNAME') || 'admin';
  const password = readEnvValue(opts.env, 'SHOT_PASSWORD');
  if (!password) {
    console.log(`login: no SHOT_PASSWORD in ${opts.env} or the environment, continuing without a session`);
    return undefined;
  }
  const context = await browser.newContext();
  const res = await context.request.post(`${opts.base}/api/auth/login`, {
    headers: { 'Content-Type': 'application/json', Origin: new URL(opts.base).origin },
    data: { username, password },
  });
  if (!res.ok()) {
    console.log(`login: rejected with HTTP ${res.status()}, continuing without a session`);
    await context.close();
    return undefined;
  }
  console.log('login: ok');
  const state = await context.storageState();
  await context.close();
  return state;
}

// ---- capture ----------------------------------------------------------------------------------------------------

const MEASURE = () => {
  const vw = document.documentElement.clientWidth;
  const overflowX = document.documentElement.scrollWidth - vw;
  const offenders = [];
  if (overflowX > 1) {
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
        offenders.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} right=${Math.round(r.right)}`);
        if (offenders.length >= 5) break;
      }
    }
  }
  return { overflowX, offenders, scrollHeight: document.documentElement.scrollHeight };
};

async function capture(browser, state, opts, kind, route) {
  const context = await browser.newContext({
    ...VIEWPORTS[kind],
    storageState: state,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.message).slice(0, 160)}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });

  const url = route.startsWith('http') ? route : `${opts.base}${route.startsWith('/') ? '' : '/'}${route}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
  // The Next.js dev indicator floats over the bottom-left corner; keep it out of the pictures.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(opts.wait);

  const file = join(opts.out, `${slug(route)}-${kind}.png`);
  if (opts.selector) await page.locator(opts.selector).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: opts.full });

  const m = await page.evaluate(MEASURE);
  const flags = [];
  if (m.overflowX > 1) flags.push(`OVERFLOW ${m.overflowX}px (${m.offenders.join('; ')})`);
  if (new URL(page.url()).pathname === '/login' && !route.startsWith('/login')) flags.push('REDIRECTED TO /login');
  flags.push(...problems.slice(0, 5));
  console.log(`${kind.padEnd(7)} ${route.padEnd(28)} -> ${file}  ${flags.length ? flags.join(' | ') : 'ok'}`);
  await context.close();
  return flags.length === 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  opts.out = resolve(root, opts.out);
  mkdirSync(opts.out, { recursive: true });
  const kinds = opts.only ? [opts.only] : ['desktop', 'mobile'];
  for (const k of kinds) if (!VIEWPORTS[k]) throw new Error(`--only must be desktop or mobile, got ${k}`);

  const browser = await chromium.launch(process.env.SHOT_CHROMIUM ? { executablePath: process.env.SHOT_CHROMIUM } : {});
  let clean = true;
  try {
    const state = await login(browser, opts);
    for (const route of opts.routes) {
      for (const kind of kinds) {
        clean = (await capture(browser, state, opts, kind, route)) && clean;
      }
    }
  } finally {
    await browser.close();
  }
  console.log(clean ? 'done: no overflow or errors' : 'done: see flags above');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

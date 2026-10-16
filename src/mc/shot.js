/**
 * `mc shot` — the pieces: what memoro declares, the request mc hands its
 * capture script, and the one result line it hands back.
 *
 * mc owns the environment — the worktree, the server, the base URL, the token
 * and the session, and where the file goes. memoro owns the app: `.mc/shot.json`
 * names the script, the targets, the shells and the viewports, and the script
 * drives the browser. The two meet only through a request file and a result
 * line (docs/technical/mc-shot.md), so nothing here knows a selector.
 *
 * The request file is the only place a token or a cookie is ever written: mode
 * 0600, in a directory of its own, removed in a `finally` whatever the script
 * did. Its path reaches the script through `MEMORO_SHOT_REQUEST`, never argv.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import { callerWorktree, sharedWorktree } from './test-environment.js';

export const SHOT_FILE = join('.mc', 'shot.json');
export const SESSION_SECRET = 'MEMORO_SHOT_SESSION';
export const SHELLS = ['base', 'immersive', 'window'];
export const THEMES = ['light', 'dark'];
export const DEV_ACCOUNTS = ['seeded', 'new'];
export const CAPTURE_TIMEOUT_MS = 180_000;
export const OPEN_TIMEOUT_MS = 150_000;

/** `.mc/shot.json`, or the one line that says why there is none to read. */
export function readShotDeclaration(worktree) {
  const path = join(worktree, SHOT_FILE);
  if (!existsSync(path)) {
    return { ok: false, error: `memoro has no .mc/shot.json at ${worktree} — it comes with memoro's shot-capture project` };
  }
  let declaration = null;
  try {
    declaration = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, error: `${path}: ${error.message}` };
  }
  if (!Array.isArray(declaration?.argv) || !declaration.argv.length
    || declaration.argv.some((part) => typeof part !== 'string' || !part.trim())) {
    return { ok: false, error: `${path}: argv is a list of arguments, never a shell string` };
  }
  if (declaration.targets !== undefined && !Array.isArray(declaration.targets)) {
    return { ok: false, error: `${path}: targets is a list of { name, path }` };
  }
  return { ok: true, declaration: { targets: [], viewports: {}, ...declaration } };
}

/**
 * Which memoro worktree `mc shot` and `mc dev open` read: the one you stand in
 * when it has `.mc/shot.json`, else the shared checkout; `here` forces the
 * first. `{ worktree }`, or `{ error }` saying why there is none.
 */
export function shotWorktree({
  cwd = process.cwd(), env = process.env, here = false, deps = {},
} = {}) {
  const standing = (deps.callerWorktree || callerWorktree)(cwd);
  const standsInMemoro = Boolean(standing && (deps.existsSync || existsSync)(join(standing, SHOT_FILE)));
  const worktree = here || standsInMemoro ? standing : sharedWorktree(env);
  if (worktree) return { worktree };
  return {
    error: here ? '--here needs a git worktree, and this is not one' : 'no memoro checkout to read .mc/shot.json from',
  };
}

/** `/admin` and below: memoro's admin pages, served outside the app's router. */
export function isAdminPath(value) {
  return value === '/admin' || String(value).startsWith('/admin/');
}

/** A path under /app or /admin as given, or a declared target name; an unknown name lists the known ones. */
export function resolveTarget(word, declaration) {
  const value = String(word || '');
  if (value.startsWith('/app') || isAdminPath(value)) return { ok: true, target: { path: value }, label: slug(value) };
  const names = (declaration.targets || []).map((target) => target.name);
  if (names.includes(value)) return { ok: true, target: { name: value }, label: slug(value) };
  return {
    ok: false,
    error: `no target called ${value} — a path under /app or /admin, or one of: ${names.join(', ') || '(none declared)'}`,
  };
}

/**
 * `--viewport`: a name `viewports` declares, or `WxH[@dpr]` (dpr 2 unless
 * said, mobile below 600 px). Nothing given is the declared default.
 */
export function parseViewport(value, declaration = {}) {
  const viewports = declaration.viewports || {};
  const wanted = value ?? declaration.default_viewport ?? 'desktop';
  const sized = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/u.exec(wanted);
  if (sized) {
    const width = Number(sized[1]);
    const height = Number(sized[2]);
    const dpr = sized[3] ? Number(sized[3]) : 2;
    if (!width || !height || !dpr) return { ok: false, error: `--viewport ${wanted}: width, height and dpr are positive` };
    return { ok: true, viewport: { width, height, dpr, mobile: width < 600 }, label: `${width}x${height}` };
  }
  if (Object.hasOwn(viewports, wanted)) return { ok: true, viewport: wanted, label: wanted };
  const names = Object.keys(viewports);
  return {
    ok: false,
    error: `no viewport called ${wanted} — WxH[@dpr], or one of: ${names.join(', ') || '(none declared)'}`,
  };
}

/**
 * `--safe-area`: `top,right,bottom,left` in whole pixels, one number for all
 * four, or `0` for none. Nothing given is the viewport's own (a declared phone
 * carries its notch and home indicator), so this only overrides.
 */
export function parseSafeArea(value) {
  if (value === null || value === undefined) return { ok: true, safeArea: null };
  const parts = String(value).split(',').map((part) => part.trim());
  const numbers = parts.map((part) => (/^\d+$/u.test(part) ? Number(part) : NaN));
  if ((parts.length !== 1 && parts.length !== 4) || numbers.some(Number.isNaN)) {
    return { ok: false, error: `--safe-area is top,right,bottom,left in whole pixels (or one number), not ${value}` };
  }
  const [top, right = top, bottom = top, left = top] = numbers;
  return { ok: true, safeArea: { top, right, bottom, left } };
}

/**
 * `--scroll <css>[@end|@top|@<px>]`: which element to scroll before the
 * picture, and where to. `@end` when nothing is said — the question is
 * usually what the bottom of a scroller looks like. An empty selector before
 * the `@` (`@end`, `@top`, `@350`) means the surface's declared scroller, so
 * `selector` is null and memoro resolves it.
 */
export function parseScroll(value) {
  if (value === null || value === undefined) return { ok: true, scroll: null };
  const text = String(value);
  const at = text.lastIndexOf('@');
  const selector = (at >= 0 ? text.slice(0, at) : text).trim() || null;
  const where = at >= 0 ? text.slice(at + 1).trim() : 'end';
  if (!selector && at < 0) return { ok: false, error: `--scroll needs a selector, as <css>[@end|@top|@<px>]` };
  if (where === 'end' || where === 'top') return { ok: true, scroll: { selector, to: where } };
  if (/^\d+$/u.test(where)) return { ok: true, scroll: { selector, to: Number(where) } };
  return { ok: false, error: `--scroll ${text}: after @ comes end, top or a number of pixels` };
}

/**
 * The `accounts` table `.mc/shot.json` declares, or null for an older memoro
 * that declares none — then `DEV_ACCOUNTS` and the two sign-in paths stand.
 */
export function accountTable(declared) {
  const table = declared?.accounts;
  return table && typeof table === 'object' && !Array.isArray(table) ? table : null;
}

/**
 * `--account` and the onboarding state: which account a dev server signs in as,
 * and the `/dev/login` path that signs it in. `done` is onboarding finished,
 * which every picture wants; `fresh` is the account reseeded to its onboarding.
 * `--onboarding` asks for `fresh`, else a target's own `onboarding` says it.
 */
export function resolveAccount(declared, { account = null, onboarding = false, entry = null } = {}) {
  const table = accountTable(declared);
  const names = table ? Object.keys(table) : DEV_ACCOUNTS;
  const name = account ?? (table ? declared.default_account : null) ?? 'seeded';
  if (!names.includes(name)) return { ok: false, error: `--account is one of ${names.join(', ')}, not ${name}` };
  const state = onboarding ? 'fresh' : (entry?.onboarding ?? 'done');
  if (!table) {
    const flag = state === 'fresh' ? 'reseed=1' : 'ready=1';
    return { ok: true, account: name, state, path: `/dev/login?account=${name}&${flag}` };
  }
  const path = table[name]?.onboarding?.[state];
  if (!path) return { ok: false, error: `.mc/shot.json: account ${name} declares no onboarding state ${state}` };
  return { ok: true, account: name, state, path };
}

/**
 * The role a target requires of the account looking at it: its declared
 * `access.requires`, else admin for a path under /admin (memoro's capture
 * script holds the same rule), else null.
 */
export function targetRequires(entry, path = null) {
  if (typeof entry?.access?.requires === 'string') return entry.access.requires;
  return isAdminPath(entry?.path ?? path ?? '') ? 'admin' : null;
}

/** The role `.mc/shot.json` declares for an account, or null when it says none. */
export function accountRole(declared, account) {
  const role = accountTable(declared)?.[account]?.role;
  return typeof role === 'string' && role !== '' ? role : null;
}

/**
 * The access verdict memoro's capture script returns for a gated target, said
 * in one line, and whether it failed. `holds: false` — the account was let in
 * where its role should be refused, refused where it should be let in, or the
 * server's own answer disagreed — fails, and the verb exits 1. A refusal the
 * role expects is the picture asked for, not a failure.
 */
export function accessLine(access) {
  if (!access || typeof access !== 'object') return null;
  const who = `${access.account}${access.role ? ` (${access.role})` : ''}`;
  const status = access.status === null || access.status === undefined ? '' : ` ${access.status}`;
  const probe = access.probe ? `; the server answered ${access.probe.path} with ${access.probe.status ?? 'nothing'}` : '';
  if (access.holds === false) {
    return {
      failed: true,
      line: `the ${access.requires} gate did not hold: ${who} should be ${access.expected}, the page was ${access.page}${status}${probe}`,
    };
  }
  if (access.holds !== true) {
    return { failed: false, line: `access: requires ${access.requires}; ${who} declares no role, so nothing was held to it — the page was ${access.page}${status}${probe}` };
  }
  return { failed: false, line: `access: requires ${access.requires} — ${who} ${access.page}, as its role expects${probe}` };
}

/** `/app/people` → `app-people`, `/app/` → `app`. */
export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'app';
}

/** Local time, as `ls` shows it: YYYYMMDD-HHMMSS. */
function stamp(date) {
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
    + `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/** `<YYYYMMDD-HHMMSS>-<dev|prod>[-me]-<target>[-<shell>|-el]-<viewport>[-<theme>].png` under `dir`. */
export function outPath({
  dir, now = new Date(), where, me = false, target, shell = null, element = null, viewport, theme = null,
}) {
  const parts = [stamp(now), where];
  if (me) parts.push('me');
  parts.push(target);
  if (element) parts.push('el');
  else if (shell) parts.push(shell);
  parts.push(viewport);
  if (theme) parts.push(theme);
  return join(dir, `${parts.join('-')}.png`);
}

/** The capture request, in the shape the contract fixes. */
export function buildRequest({
  baseUrl, account, signIn, target, element = null, shell = null, full = false, viewport,
  theme = null, locale = null, out, safeArea = null, waitFor = null, scroll = null, measure = null,
  onboarding = false,
}) {
  return {
    mode: 'capture',
    base_url: baseUrl,
    account,
    sign_in: signIn,
    target,
    element,
    shell,
    full_page: Boolean(full),
    viewport,
    theme,
    locale,
    out,
    safe_area: safeArea,
    wait_for: waitFor,
    scroll,
    measure,
    onboarding: Boolean(onboarding),
  };
}

/** The login request: no sign-in, no target, a browser profile mc keeps. */
export function buildLoginRequest({ baseUrl, profileDir }) {
  return { mode: 'login', base_url: baseUrl, account: 'me', profile_dir: profileDir };
}

/** The script's last non-empty stdout line, as the one JSON object it must be. */
export function parseResult(stdout, { status = 0 } = {}) {
  const lines = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return { ok: false, error: `the capture script exited ${status} with no result line` };
  let result = null;
  try {
    result = JSON.parse(last);
  } catch {
    return { ok: false, error: `the capture script exited ${status} and its last line is not a result: ${last.slice(0, 200)}` };
  }
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    return { ok: false, error: `the capture script exited ${status} and its result has no ok` };
  }
  return { ok: true, result };
}

/**
 * Write the request, run the declared argv on it, read the result, and remove
 * the request whatever happened. The script's stderr is the terminal's, so a
 * person watches its progress; its stdout is read, never shown.
 */
export function runCapture({ worktree, declaration, request, env = process.env, deps = {} }) {
  const dir = (deps.mkdtemp || mkdtempSync)(join(deps.tmpdir || tmpdir(), 'mc-shot-'));
  const file = join(dir, 'request.json');
  try {
    writeFileSync(file, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    const [command, ...args] = declaration.argv;
    const ran = (deps.spawnSync || spawnSync)(command, args, {
      cwd: worktree,
      env: { ...env, MEMORO_SHOT_REQUEST: file },
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      timeout: deps.timeoutMs ?? CAPTURE_TIMEOUT_MS,
      maxBuffer: 16 << 20,
    });
    if (ran.error?.code === 'ETIMEDOUT') {
      return { ok: false, error: `the capture script did not finish within ${Math.round((deps.timeoutMs ?? CAPTURE_TIMEOUT_MS) / 1000)}s` };
    }
    if (ran.error) return { ok: false, error: `the capture script could not run: ${ran.error.message}` };
    const status = ran.status ?? 1;
    const parsed = parseResult(ran.stdout, { status });
    if (!parsed.ok) return parsed;
    return { ok: true, result: parsed.result, status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `runCapture`'s sibling for a script that outlives mc: a headed browser left
 * with a person. The request is written the same way; the script is spawned
 * detached, its stderr to a log under `~/.memoro/mc/shots/`, and mc reads its
 * stdout only until the first result line. Then mc lets go — the stream is
 * closed, the child unref'd — and the browser lives until its window is
 * closed. The request directory is removed in every case: the script has read
 * it by the time it answers, and one that never answers is killed.
 */
export function runOpen({ worktree, declaration, request, env = process.env, deps = {} }) {
  const dir = (deps.mkdtemp || mkdtempSync)(join(deps.tmpdir || tmpdir(), 'mc-shot-'));
  const file = join(dir, 'request.json');
  const logDir = deps.logDir || join(mcHome(env), 'shots');
  const log = join(logDir, `open-${stamp(deps.now ? deps.now() : new Date())}.log`);
  const timeoutMs = deps.timeoutMs ?? OPEN_TIMEOUT_MS;
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  let child = null;
  try {
    writeFileSync(file, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    mkdirSync(logDir, { recursive: true });
    const logFd = openSync(log, 'a');
    try {
      const [command, ...args] = declaration.argv;
      child = (deps.spawn || spawn)(command, args, {
        cwd: worktree,
        env: { ...env, MEMORO_SHOT_REQUEST: file },
        detached: true,
        stdio: ['ignore', 'pipe', logFd],
      });
    } finally {
      closeSync(logFd);
    }
  } catch (error) {
    cleanup();
    return Promise.resolve({ ok: false, error: `the browser script could not run: ${error.message} — ${log}` });
  }

  return new Promise((settle) => {
    let done = false;
    let buffered = '';
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      cleanup();
      settle(outcome);
    };
    const timer = setTimeout(() => {
      child.kill?.();
      finish({ ok: false, error: `the browser did not open within ${Math.round(timeoutMs / 1000)}s — ${log}` });
    }, timeoutMs);
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        const result = resultLine(line);
        if (!result) continue;
        child.unref?.();
        finish({ ok: true, result, log });
        return;
      }
    });
    child.on('error', (error) => finish({ ok: false, error: `the browser script could not run: ${error.message} — ${log}` }));
    // `close`, not `exit`: a line written just before exiting is read first.
    child.on('close', (code, signal) => finish({
      ok: false,
      error: `the browser script ${signal ? `was stopped by ${signal}` : `exited ${code}`} before the surface was open — ${log}`,
    }));
  });
}

function resultLine(line) {
  try {
    const value = JSON.parse(line.trim());
    return value && typeof value === 'object' && typeof value.ok === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

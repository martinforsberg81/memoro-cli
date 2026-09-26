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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SHOT_FILE = join('.mc', 'shot.json');
export const SESSION_SECRET = 'MEMORO_SHOT_SESSION';
export const SHELLS = ['base', 'immersive', 'window'];
export const THEMES = ['light', 'dark'];
export const CAPTURE_TIMEOUT_MS = 180_000;

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

/** A path under /app as given, or a declared target name; an unknown name lists the known ones. */
export function resolveTarget(word, declaration) {
  const value = String(word || '');
  if (value.startsWith('/app')) return { ok: true, target: { path: value }, label: slug(value) };
  const names = (declaration.targets || []).map((target) => target.name);
  if (names.includes(value)) return { ok: true, target: { name: value }, label: slug(value) };
  return {
    ok: false,
    error: `no target called ${value} — a path under /app, or one of: ${names.join(', ') || '(none declared)'}`,
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
  theme = null, locale = null, out,
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

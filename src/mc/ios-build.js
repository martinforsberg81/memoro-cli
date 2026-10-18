/**
 * Whether memoro needs a new iOS binary — answered from data, without building.
 *
 * memoro's iOS app is Capacitor with `server.url` pointing at production, so
 * the binary runs whatever web code production serves. Only the native layer
 * pairs with a commit: the app-local Swift plugins, the sync script, the
 * Capacitor config and the native packages built from `node_modules`. So the
 * question is one diff: between the commit of the last shipped binary
 * (`lastShipped`, ios-builds.js) and the commit production runs
 * (`/api/version`), restricted to what memoro declares native.
 *
 * memoro is read through its declaration alone — `.mc/ios.json` on
 * `origin/main` (memoro project `ios-build-declaration`) — and never through a
 * path, bundle id or team id written here. It is read from `origin/main` and
 * not the working tree, so a stale or dirty checkout cannot change the answer.
 *
 * Every process boundary is a parameter — git, the version fetch — so the
 * whole question runs in a test against a repository the test made.
 *
 * The build (`--device`) is here too: the preflights the asking process runs
 * (`devicePreflight`), and the builder (`buildIos`) that runs in its own
 * process (`ios-build-run.js`) the way the deployer does — holding the heavy
 * lane, in mc's own worktree of the exact commit, every external command
 * through one `step`, the built app read back against the declaration
 * (`readBack`) before `devicectl` installs it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stripAnsi } from '../lib/prompt.js';
import { IOS_BUILD_MODE } from './await-deploy.js';
import { defaultRepos } from './brief-collect.js';
import { holdHeavyLane } from './commands/deploy.js';
import { releaseGateLock } from './gate-lock.js';
import {
  FAILED, INSTALLED, lastShipped as lastShippedRow, recordEnd, recordStart, runningIosBuild, SEED, UPLOADED,
} from './ios-builds.js';
import { mcHome } from './paths.js';

/** The repository this is about, by its name in `defaultRepos`. */
export const REPO = 'memoro';

export const DECLARATION_PATH = '.mc/ios.json';

/** Every key memoro's plan declares, dotted where nested. */
export const DECLARATION_KEYS = [
  'project', 'scheme', 'bundle_id', 'team_id', 'server_url', 'setup', 'sync', 'export_options',
  'env.build_number', 'env.build_commit', 'info_plist_commit_key', 'list_builds', 'upload',
  'app_local_plugins', 'native_paths', 'native_dependency_prefixes',
];

const LIST_KEYS = new Set(['app_local_plugins', 'native_paths', 'native_dependency_prefixes']);

const short = (sha) => (sha ? String(sha).slice(0, 7) : '');

/**
 * git, returning its output or null. Its own rather than `tryGit` for the
 * buffer: `git show <rev>:package-lock.json` is megabytes, past spawnSync's
 * default, and a lockfile cut off would read as no packages at all.
 */
export function gitRead(cwd, args, { timeoutMs = 60_000 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim();
}

/** memoro's checkout, found the way `mc deploy` finds it; null when there is none. */
export function memoroRepo(env = process.env, repos = defaultRepos(env)) {
  return repos.find((repo) => repo.name === REPO)?.path || null;
}

function valueAt(object, dotted) {
  return dotted.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object);
}

/** `.mc/ios.json` from `origin/main`: `{ ok, declaration }` or `{ ok: false, reason }`. */
export function readIosDeclaration(repoPath, { git = gitRead } = {}) {
  const text = git(repoPath, ['show', `origin/main:${DECLARATION_PATH}`]);
  if (text === null || text === '') {
    return { ok: false, reason: `memoro has no ${DECLARATION_PATH} on origin/main yet (memoro project ios-build-declaration)` };
  }
  let declaration;
  try { declaration = JSON.parse(text); } catch (error) {
    return { ok: false, reason: `memoro's ${DECLARATION_PATH} on origin/main is not JSON (${error.message})` };
  }
  if (declaration?.schema_version !== 1) {
    return { ok: false, reason: `memoro's ${DECLARATION_PATH} on origin/main is schema_version ${declaration?.schema_version ?? 'none'}; mc reads 1` };
  }
  for (const key of DECLARATION_KEYS) {
    const value = valueAt(declaration, key);
    const missing = LIST_KEYS.has(key) ? !Array.isArray(value) : (value === undefined || value === null || value === '');
    if (missing) return { ok: false, reason: `memoro's ${DECLARATION_PATH} on origin/main has no ${key}` };
  }
  return { ok: true, declaration };
}

/** Whether `path` is one the declaration calls native: an entry ending in `/`
 * is a directory and matches by prefix, any other entry matches exactly. */
export function isNativePath(path, nativePaths = []) {
  return nativePaths.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

/** `{ <name>: <version> }` for every native package in the lockfile at `rev`. */
function nativePackages({ repoPath, rev, prefixes, git }) {
  const text = git(repoPath, ['show', `${rev}:package-lock.json`]);
  let lock = {};
  try { lock = text ? JSON.parse(text) : {}; } catch { lock = {}; }
  const found = {};
  for (const [key, entry] of Object.entries(lock?.packages || {})) {
    if (!key.startsWith('node_modules/')) continue;
    const name = key.slice('node_modules/'.length);
    // A package nested under another's node_modules is that package's, not the app's.
    if (name.includes('/node_modules/')) continue;
    if (prefixes.some((prefix) => name.startsWith(prefix))) found[name] = entry?.version || '';
  }
  return found;
}

/**
 * What native differs between `from` and `to`: `{ paths, packages }`, the
 * paths as git names them and the packages as `<name> <old>→<new>` (`none`
 * for a side that does not have it). A lockfile that changed only for web
 * packages is no native change.
 */
export function nativeChanges({ repoPath, from, to, declaration, git = gitRead }) {
  const diff = git(repoPath, ['diff', '--name-only', from, to]);
  const paths = String(diff || '').split('\n').map((line) => line.trim())
    .filter((path) => path && isNativePath(path, declaration.native_paths));
  const prefixes = declaration.native_dependency_prefixes || [];
  const before = nativePackages({ repoPath, rev: from, prefixes, git });
  const after = nativePackages({ repoPath, rev: to, prefixes, git });
  const packages = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter((name) => before[name] !== after[name])
    .map((name) => `${name} ${before[name] || 'none'}→${after[name] || 'none'}`);
  return { paths, packages };
}

/** `GET <server_url>/api/version`, or null when production does not answer. */
export async function fetchVersionDefault(serverUrl, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`${String(serverUrl).replace(/\/+$/u, '')}/api/version`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-store' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

function changeList({ paths, packages }) {
  return [...paths, ...packages].join(', ');
}

/**
 * `mc build ios` with no flag: the answer, printed. Exit 0 in every answered
 * case, 1 when it cannot be answered — no checkout, no declaration,
 * production silent, a commit this checkout does not have.
 */
export async function iosQuestion({
  env = process.env, repos, git = gitRead, fetchVersion = fetchVersionDefault, lastShipped = lastShippedRow,
  stdout = process.stdout, stderr = process.stderr, json = false,
} = {}) {
  const repoPath = memoroRepo(env, repos || defaultRepos(env));
  if (!repoPath) {
    stderr.write(`mc: no checkout of ${REPO} on this machine — mc build ios reads that repository\n`);
    return 1;
  }
  const warnings = [];
  if (git(repoPath, ['fetch', 'origin', '--quiet'], { timeoutMs: 30_000 }) === null) {
    warnings.push('could not fetch origin — this is what the checkout already had');
  }

  const read = readIosDeclaration(repoPath, { git });
  if (!read.ok) {
    stderr.write(`mc: ${read.reason}\n`);
    return 1;
  }
  const { declaration } = read;

  const version = await fetchVersion(declaration.server_url, { env });
  const live = version?.commit_full || null;
  if (!live) {
    stderr.write('mc: production did not answer /api/version — cannot say what the app would meet\n');
    return 1;
  }
  if (git(repoPath, ['rev-parse', '--verify', '--quiet', `${live}^{commit}`]) === null) {
    stderr.write(`mc: production runs ${short(live)}, a commit ${repoPath} does not have — cannot diff against it\n`);
    return 1;
  }

  const shipped = lastShipped(env);
  const known = shipped && git(repoPath, ['rev-parse', '--verify', '--quiet', `${shipped.sha}^{commit}`]) !== null;
  const changes = known
    ? nativeChanges({ repoPath, from: shipped.sha, to: live, declaration, git })
    : { paths: [...declaration.native_paths], packages: [] };
  const needed = changes.paths.length > 0 || changes.packages.length > 0;

  const main = git(repoPath, ['rev-parse', '--verify', '--quiet', 'origin/main']);
  const ahead = main && main !== live
    ? nativeChanges({ repoPath, from: live, to: main, declaration, git })
    : { paths: [], packages: [] };
  const aheadNative = ahead.paths.length > 0 || ahead.packages.length > 0;

  if (json) {
    stdout.write(`${JSON.stringify({
      last_shipped: shipped ? { build: shipped.build, sha: shipped.sha, at: shipped.ended || shipped.started, known } : null,
      live,
      origin_main: main || null,
      changes,
      new_binary_needed: needed,
      origin_main_native_ahead: ahead,
      warnings,
    }, null, 2)}\n`);
    return 0;
  }

  for (const warning of warnings) stdout.write(`mc: ${warning}\n`);
  if (!shipped) {
    stdout.write('mc: no shipped build is recorded — mc build ios --shipped <build> <sha> records the last one (memoro docs/releases/ios.md names it)\n');
  } else {
    const date = String(shipped.ended || shipped.started || '').slice(0, 10);
    stdout.write(`mc: last shipped: build ${shipped.build} from ${short(shipped.sha)} (${date})\n`);
    if (!known) stdout.write(`mc: ${short(shipped.sha)} is not a commit ${repoPath} has — every native path counts as changed\n`);
  }
  stdout.write(`mc: production runs: ${short(live)}\n`);
  if (needed) {
    if (changes.paths.length) stdout.write(`mc: native paths: ${changes.paths.join(', ')}\n`);
    if (changes.packages.length) stdout.write(`mc: native packages: ${changes.packages.join(', ')}\n`);
    stdout.write('mc: a new binary is needed — mc build ios --device to try it, --testflight to ship it\n');
  } else {
    stdout.write(`mc: no native change since build ${shipped.build} — mc deploy is enough\n`);
  }
  if (aheadNative) {
    stdout.write(`mc: origin/main has native changes production does not run yet (${changeList(ahead)}) — mc deploy first, then build\n`);
  }
  return 0;
}

/**
 * `mc build ios --shipped <build> <sha>`: a binary made before the verb
 * existed, written as a `seed` row so `lastShipped` has something to compare
 * against. The sha is stored whole, as the checkout resolves it.
 */
export function recordShipped({
  build, sha, env = process.env, repos, git = gitRead, stdout = process.stdout, stderr = process.stderr,
}) {
  if (!/^\d+$/u.test(String(build ?? ''))) {
    stderr.write(`mc: --shipped needs a build number of digits, not ${build ?? 'nothing'}\n`);
    return 2;
  }
  const repoPath = memoroRepo(env, repos || defaultRepos(env));
  if (!repoPath) {
    stderr.write(`mc: no checkout of ${REPO} on this machine — the sha cannot be checked\n`);
    return 1;
  }
  const full = sha ? git(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) : null;
  if (!full) {
    stderr.write(`mc: ${sha || 'no sha'} is not a commit in ${repoPath} — nothing was recorded\n`);
    return 1;
  }
  const at = new Date().toISOString();
  recordStart({
    started: at, ended: at, sha: full, kind: SEED, build: String(build), outcome: UPLOADED,
    note: 'recorded by mc build ios --shipped',
  }, env);
  stdout.write(`mc: recorded build ${build} from ${short(full)} as the last shipped binary\n`);
  return 0;
}

/* ------------------------------------------------------------ the device build */

const MIN = 60 * 1000;

/** How much of a step's output is kept for the failure note; the whole of it is in the log. */
export const OUTPUT_KEEP = 64 * 1024;

/** How long a step that timed out is given between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 10 * 1000;

/** Where the builder writes what it does: one build at a time, so one file. */
export function iosBuildLogPath(root) {
  return join(root, 'runner', 'log', 'ios-build.log');
}

/**
 * mc's own worktree of memoro that builds happen in, and the two directories
 * that stay between builds. Fixed paths: xcodebuild keys its SPM checkouts and
 * module caches by them, and a new path each time would be a cold build. Under
 * `mcHome()`, not `~/mc/`, for the reason `deployWorktreePath` gives.
 */
export function buildPaths(env = process.env) {
  const base = join(mcHome(env), 'build');
  return { worktree: join(base, REPO), derived: join(base, 'ios-derived'), spm: join(base, 'ios-spm') };
}

/** The app `xcodebuild build` leaves for a device. */
export function builtApp(derived) {
  return join(derived, 'Build', 'Products', 'Release-iphoneos', 'App.app');
}

/** A command, waited for: `{ code, stdout, stderr, error }`. */
export function runSync(argv, { cwd, env = process.env, timeoutMs = 60_000 } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message || null,
  };
}

function firstLine(r) {
  const text = String(r?.error || r?.stderr || r?.stdout || '').trim();
  return text.split('\n')[0].trim() || `exit ${r?.code}`;
}

/** `xcrun xcodebuild -version` answers: null, or the line that says it does not. Never `xcode-select --install`. */
export function checkXcode({ run = runSync, env = process.env } = {}) {
  const r = run(['xcrun', 'xcodebuild', '-version'], { env, timeoutMs: 30_000 });
  return r.code === 0 ? null : `Xcode command-line build tools are not usable here: ${firstLine(r)}`;
}

/** An `<identity>:` signing identity in the keychain: null, or the line that says there is none. */
export function checkSigning({ run = runSync, env = process.env, identity = 'Apple Development' } = {}) {
  const r = run(['security', 'find-identity', '-v', '-p', 'codesigning'], { env, timeoutMs: 30_000 });
  if (r.code === 0 && r.stdout.includes(`"${identity}:`)) return null;
  return `no ${identity} signing identity in the login keychain — sign in to Xcode once (Settings → Accounts) on this Mac`;
}

/**
 * The paired iPhones in `devicectl list devices --json-output` (jsonVersion 3,
 * read on this Mac 2026-10-18 and pinned in
 * `tests/fixtures/devicectl-list-devices.json`): `result.devices[]` with
 * `identifier`, `deviceProperties.name`, `hardwareProperties.platform`,
 * `.marketingName`, `.udid` and `connectionProperties.pairingState`.
 */
export function pairedDevices(json) {
  return (json?.result?.devices || [])
    .filter((d) => d?.hardwareProperties?.platform === 'iOS' && d?.connectionProperties?.pairingState === 'paired')
    .map((d) => ({
      id: d.identifier,
      name: d.deviceProperties?.name || d.identifier,
      model: d.hardwareProperties?.marketingName || '',
      udid: d.hardwareProperties?.udid || '',
    }));
}

const NO_PHONE = 'no paired iPhone — connect and unlock it, trust this Mac';

/** The phone to install on: `{ device }`, or `{ lines }` saying why there is none or which to choose. */
export function chooseDevice({ run = runSync, env = process.env, deviceId = null, scratch = tmpdir() } = {}) {
  const dir = mkdtempSync(join(scratch, 'mc-devicectl-'));
  const out = join(dir, 'devices.json');
  try {
    const r = run(['xcrun', 'devicectl', 'list', 'devices', '--json-output', out], { env, timeoutMs: 60_000 });
    let json = null;
    try { json = JSON.parse(readFileSync(out, 'utf8')); } catch { json = null; }
    if (!json) return { lines: [`xcrun devicectl list devices gave no device list: ${firstLine(r)}`] };
    const paired = pairedDevices(json);
    const listed = paired.map((d) => `  --device-id ${d.id}   ${d.name}${d.model ? ` (${d.model})` : ''}`);
    if (deviceId) {
      const device = paired.find((d) => [d.id, d.udid, d.name].includes(deviceId));
      if (device) return { device };
      return { lines: paired.length ? [`no paired iPhone is ${deviceId} — these are:`, ...listed] : [NO_PHONE] };
    }
    if (!paired.length) return { lines: [NO_PHONE] };
    if (paired.length > 1) return { lines: [`${paired.length} paired iPhones — say which:`, ...listed] };
    return { device: paired[0] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The commit to build: production's, or a `--sha` production already
 * contains — the binary always pairs with the web it will meet — and in
 * either case one that is on `origin/main`. `{ sha }` or `{ line }`.
 */
export function resolveTarget({ repoPath, live, ref = null, git = gitRead }) {
  const liveFull = git(repoPath, ['rev-parse', '--verify', '--quiet', `${live}^{commit}`]);
  if (!liveFull) return { line: `production runs ${short(live)}, a commit ${repoPath} does not have — cannot build what it runs` };
  let sha = liveFull;
  if (ref) {
    sha = git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!sha) return { line: `${ref} is not a commit in ${repoPath} — nothing was built` };
    if (git(repoPath, ['merge-base', '--is-ancestor', sha, liveFull]) === null) {
      return { line: `production runs ${short(liveFull)}, which does not contain ${short(sha)} — mc deploy first` };
    }
  }
  if (git(repoPath, ['merge-base', '--is-ancestor', sha, 'origin/main']) === null) {
    return { line: `${short(sha)} is not on memoro's origin/main — mc build ios builds only what main has` };
  }
  return { sha };
}

/**
 * Everything `mc build ios --device` checks in the asking process before it
 * starts anything, in order, each a refusal of one line that names the fix:
 * a build already running (exit 2), Xcode, the signing identity, the phone,
 * then the commit — after a fetch, the declaration from origin/main, and
 * production's `/api/version`. `{ ok: true, repoPath, declaration, device,
 * live, sha, warnings }` or `{ ok: false, code, lines }`.
 */
export async function devicePreflight({
  env = process.env, repos, git = gitRead, run = runSync, fetchVersion = fetchVersionDefault,
  deviceId = null, ref = null, alive, scratch,
} = {}) {
  const refuse = (lines, code = 1) => ({ ok: false, code, lines: [].concat(lines) });
  const other = runningIosBuild(env, alive ? { alive } : {});
  if (other) return refuse(`an iOS build is running (pid ${other.pid}) — mc build ios --follow`, 2);
  const xcode = checkXcode({ run, env });
  if (xcode) return refuse(xcode);
  const signing = checkSigning({ run, env });
  if (signing) return refuse(signing);
  const chosen = chooseDevice({ run, env, deviceId, ...(scratch ? { scratch } : {}) });
  if (!chosen.device) return refuse(chosen.lines);

  const repoPath = memoroRepo(env, repos || defaultRepos(env));
  if (!repoPath) return refuse(`no checkout of ${REPO} on this machine — mc build ios builds from it`);
  const warnings = [];
  if (git(repoPath, ['fetch', 'origin', '--quiet'], { timeoutMs: 30_000 }) === null) {
    warnings.push('could not fetch origin — this is what the checkout already had');
  }
  const read = readIosDeclaration(repoPath, { git });
  if (!read.ok) return refuse(read.reason);
  const { declaration } = read;
  const version = await fetchVersion(declaration.server_url, { env });
  const live = version?.commit_full || null;
  if (!live) return refuse('production did not answer /api/version — cannot say what the app would meet');
  const target = resolveTarget({ repoPath, live, ref, git });
  if (!target.sha) return refuse(target.line);
  return { ok: true, repoPath, declaration, device: chosen.device, live, sha: target.sha, warnings };
}

/** `plutil -convert json` of a plist, parsed; throws when it will not convert. */
export function plutilJson(path) {
  const r = runSync(['plutil', '-convert', 'json', '-o', '-', path], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(firstLine(r));
  return JSON.parse(r.stdout);
}

/** `codesign --verify --deep --strict`: `{ ok, detail }`. */
export function codesignVerify(appDir) {
  const r = runSync(['codesign', '--verify', '--deep', '--strict', appDir], { timeoutMs: 5 * MIN });
  return { ok: r.code === 0, detail: r.code === 0 ? '' : firstLine(r) };
}

/**
 * The built app, read back against the declaration before anything installs
 * it: its own Info.plist says the declared bundle id, the commit it was told
 * and — when one was set — the build number; its `capacitor.config.json`
 * loads the declared production URL and registers every app-local plugin;
 * its signature verifies. `{ ok, problems, name, version, build }`, each
 * problem naming the field and both values.
 */
export function readBack({
  appDir, declaration, sha, build = null,
  readFile = (path) => readFileSync(path, 'utf8'), plutil = plutilJson, codesign = codesignVerify,
}) {
  const problems = [];
  const differs = (name, actual, expected, show = (value) => value) => {
    if (actual === expected) return;
    const said = actual === undefined || actual === null || actual === '' ? 'missing' : show(actual);
    problems.push(`${name} is ${said}, expected ${show(expected)}`);
  };
  let info = null;
  try { info = plutil(join(appDir, 'Info.plist')); } catch (error) {
    problems.push(`Info.plist could not be read (${error?.message || error})`);
  }
  if (info) {
    differs('CFBundleIdentifier', info.CFBundleIdentifier, declaration.bundle_id);
    differs(declaration.info_plist_commit_key, info[declaration.info_plist_commit_key], sha, short);
    if (build !== null && build !== undefined) differs('CFBundleVersion', String(info.CFBundleVersion ?? ''), String(build));
  }
  let config = null;
  try { config = JSON.parse(readFile(join(appDir, 'capacitor.config.json'))); } catch (error) {
    problems.push(`capacitor.config.json could not be read (${error?.message || error})`);
  }
  if (config) {
    differs('server.url', config.server?.url, declaration.server_url);
    const classes = Array.isArray(config.packageClassList) ? config.packageClassList : [];
    for (const plugin of declaration.app_local_plugins) {
      if (!classes.includes(plugin)) problems.push(`packageClassList has no ${plugin}`);
    }
  }
  const signed = codesign(appDir);
  if (!signed.ok) problems.push(`codesign --verify --deep --strict failed: ${signed.detail}`);
  return {
    ok: problems.length === 0,
    problems,
    name: info?.CFBundleDisplayName || info?.CFBundleName || REPO,
    version: String(info?.CFBundleShortVersionString ?? ''),
    build: String(info?.CFBundleVersion ?? ''),
  };
}

/**
 * The one way the builder runs a command: `▸ <label>` (unless `quiet`), the
 * output streamed to the log, the last `OUTPUT_KEEP` of it kept. Past
 * `timeoutMs` the command gets SIGTERM, and SIGKILL `KILL_GRACE_MS` later.
 * Resolves `{ ok, code, signal, timedOut, error, output }`; never rejects.
 * `step.stop(signal)` passes a signal the builder received on to the command
 * running now, and every step after it fails without starting.
 */
export function makeStep({ stdout = process.stdout, spawnProcess = spawn, graceMs = KILL_GRACE_MS } = {}) {
  let current = null;
  let halted = null;
  const step = (label, argv, { cwd, env = process.env, timeoutMs = 10 * MIN, quiet = false } = {}) => new Promise((resolve) => {
    if (halted) {
      resolve({ ok: false, code: 1, signal: halted, timedOut: false, error: `stopped by ${halted}`, output: '' });
      return;
    }
    if (!quiet) stdout.write(`▸ ${label}\n`);
    let output = '';
    let timedOut = false;
    let killer = null;
    let timer = null;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      current = null;
      resolve({ ok: false, signal: null, error: null, ...result, timedOut, output });
    };
    let child;
    try {
      child = spawnProcess(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      settle({ code: 127, error: error?.message || String(error) });
      return;
    }
    current = child;
    const keep = (chunk) => {
      if (!quiet) stdout.write(chunk);
      output = (output + chunk).slice(-OUTPUT_KEEP);
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', keep);
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
    }, timeoutMs);
    child.on('error', (error) => settle({ code: 127, error: error?.message || String(error) }));
    child.on('close', (code, signal) => settle({ ok: code === 0 && !timedOut, code: code ?? 1, signal: signal || null }));
  });
  step.stop = (signal = 'SIGTERM') => {
    halted = signal;
    try { current?.kill(signal); } catch { /* gone */ }
  };
  return step;
}

/** The line of a step's output that says most about why it failed. */
function tellingLine(output) {
  const lines = stripAnsi(String(output || '')).split('\n').map((line) => line.trim()).filter(Boolean);
  const line = lines.findLast((l) => /\berror\b/iu.test(l)) || lines.at(-1) || '';
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

/** The fix a person makes for an xcodebuild that failed on signing, or null. */
export function xcodeHint(output) {
  const text = String(output || '');
  if (/errSecInternalComponent|User interaction is not allowed/u.test(text)) {
    return 'the login keychain is locked — security unlock-keychain ~/Library/Keychains/login.keychain-db in your own terminal, then build again';
  }
  if (/No Account|requires a development team/u.test(text)) {
    return 'Xcode has no account for the team — sign in to Xcode once (Settings → Accounts) on this Mac';
  }
  return null;
}

function stepNote(label, r, timeoutMs) {
  let why = `exited ${r.code}`;
  if (r.timedOut) why = `timed out after ${Math.round(timeoutMs / MIN)} min`;
  else if (r.error) why = `could not start (${r.error})`;
  else if (r.signal) why = `killed by ${r.signal}`;
  const line = tellingLine(r.output);
  return `${label} ${why}${line ? ` — ${line}` : ''}`;
}

/**
 * The builder, in its own process (`ios-build-run.js`): the heavy lane held,
 * mc's worktree put on exactly `job.sha` with nothing generated surviving,
 * a real `npm ci`, the declaration's setup and sync with the commit in the
 * environment and no build number, `xcodebuild`, the read-back, and the
 * install. The row `recordStart` wrote is completed however it ends —
 * `installed`, or `failed` with where it stopped — and a throw does the same
 * and goes on up, as `ship` does.
 */
export async function buildIos(job, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const step = deps.step || makeStep({ stdout });
  const exists = deps.exists || existsSync;
  const { key, sha, repoPath, declaration, device } = job;
  const { worktree, derived, spm } = buildPaths(env);
  const app = builtApp(derived);
  let at = 'heavy lane';
  let holding = false;

  const fail = (stoppedAt, note) => {
    recordEnd(key, { outcome: FAILED, stopped_at: stoppedAt, note }, env);
    stderr.write(`mc: the build stopped at ${stoppedAt} — ${note}\n`);
    stderr.write('mc: nothing was installed\n');
    return 1;
  };
  const run = (label, argv, options = {}) => {
    at = options.stoppedAt || label;
    return step(label, argv, { cwd: worktree, env, ...options });
  };
  const failed = (label, r, timeoutMs, stoppedAt = label) => fail(stoppedAt, stepNote(label, r, timeoutMs));

  try {
    holding = await (deps.holdHeavyLane || holdHeavyLane)(job, { ...deps, stdout, env, mode: IOS_BUILD_MODE });

    // (b) The worktree, on exactly the commit, with nothing generated left:
    // `clean -ffdx` takes `ios/` and `node_modules` with it.
    const git = (label, args, quiet = false) => run(label, ['git', ...args], { cwd: repoPath, quiet, stoppedAt: 'worktree', timeoutMs: 10 * MIN });
    const moves = exists(worktree)
      ? [['git checkout', ['-C', worktree, 'checkout', '--detach', '--force', sha]], ['git clean', ['-C', worktree, 'clean', '-ffdx']]]
      : [['git worktree prune', ['-C', repoPath, 'worktree', 'prune']], ['git worktree add', ['-C', repoPath, 'worktree', 'add', '--detach', worktree, sha]]];
    for (const [label, args] of moves) {
      const r = await git(label, args);
      if (!r.ok) return failed(label, r, 10 * MIN, 'worktree');
    }
    const head = await git('git rev-parse', ['-C', worktree, 'rev-parse', 'HEAD'], true);
    const status = await git('git status', ['-C', worktree, 'status', '--porcelain'], true);
    if (!head.ok || head.output.trim() !== sha || !status.ok || status.output.trim()) {
      const said = !head.ok || head.output.trim() !== sha ? `HEAD is ${short(head.output.trim()) || 'unknown'}` : 'it has uncommitted files';
      return fail('worktree', `${worktree} is not a clean ${short(sha)}: ${said}`);
    }
    stdout.write(`mc: ${worktree} at ${short(sha)}, clean\n`);

    // (c) A real install, never memoro's shared-cache link: a native patch
    // edits a package in node_modules in place.
    const install = await run('npm ci', ['npm', 'ci'], { timeoutMs: 30 * MIN });
    if (!install.ok) return failed('npm ci', install, 30 * MIN);

    // (d) The declaration's setup, each command as memoro wrote it.
    for (const command of [].concat(declaration.setup)) {
      const r = await run(command, ['sh', '-c', command], { timeoutMs: 10 * MIN });
      if (!r.ok) return failed(command, r, 10 * MIN);
    }

    // (e) The sync, told the commit. A device build sets no number, so the
    // declaration's default stands; one in this environment is not passed on.
    const syncEnv = { ...env, [declaration.env.build_commit]: sha };
    delete syncEnv[declaration.env.build_number];
    const sync = await run(declaration.sync, ['sh', '-c', declaration.sync], { env: syncEnv, timeoutMs: 20 * MIN });
    if (!sync.ok) return failed(declaration.sync, sync, 20 * MIN);

    // (f) The build, with the two fixed directories that keep it warm.
    const xcode = await run('xcodebuild', [
      'xcodebuild', '-project', declaration.project, '-scheme', declaration.scheme, '-configuration', 'Release',
      '-destination', 'generic/platform=iOS', '-derivedDataPath', derived, '-clonedSourcePackagesDirPath', spm,
      '-allowProvisioningUpdates', 'build',
    ], { timeoutMs: 60 * MIN });
    if (!xcode.ok) {
      const hint = xcodeHint(xcode.output);
      return hint ? fail('xcodebuild', `xcodebuild failed — ${hint}`) : failed('xcodebuild', xcode, 60 * MIN);
    }

    // (g) The app read back before anything installs it.
    at = 'read-back';
    stdout.write('▸ read-back\n');
    const read = (deps.readBack || readBack)({
      appDir: app, declaration, sha, build: null, readFile: deps.readFile, plutil: deps.plutil, codesign: deps.codesign,
    });
    if (!read.ok) {
      for (const problem of read.problems) stderr.write(`mc:   ${problem}\n`);
      return fail('read-back', `the built app is not what was declared: ${read.problems.join('; ')}`);
    }
    stdout.write(`mc: ${app} says ${declaration.bundle_id}, ${read.version} (${read.build}) from ${short(sha)}, ${declaration.server_url}; signed\n`);

    // (h) The install.
    const installed = await run('install', ['xcrun', 'devicectl', 'device', 'install', 'app', '--device', device.id, app], { timeoutMs: 10 * MIN });
    if (!installed.ok) {
      const locked = /\blocked\b/iu.test(installed.output) ? ' — unlock the iPhone and build again' : '';
      return fail('install', `${stepNote('install', installed, 10 * MIN)}${locked}`);
    }
    recordEnd(key, {
      outcome: INSTALLED, version: read.version, build: read.build, artifact: app, stopped_at: '', note: '',
    }, env);
    stdout.write(`mc: installed ${read.name} ${read.version} (${read.build}) from ${short(sha)} on ${device.name}\n`);
    return 0;
  } catch (error) {
    recordEnd(key, { outcome: FAILED, stopped_at: at, note: `mc: ${error?.message || error}` }, env);
    throw error;
  } finally {
    if (holding) (deps.releaseGateLock || releaseGateLock)({ root: job.lockRoot || mcHome(env), lane: 'heavy' });
  }
}

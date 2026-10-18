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
 */
import { spawnSync } from 'node:child_process';

import { defaultRepos } from './brief-collect.js';
import { lastShipped as lastShippedRow, recordStart, SEED, UPLOADED } from './ios-builds.js';

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

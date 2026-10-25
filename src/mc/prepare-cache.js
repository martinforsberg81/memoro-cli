/**
 * The candidate's `npm ci`, taken from a tree already installed from the
 * same lockfile when there is one.
 *
 * memoro's prepare is `npm ci`: 15 s median and 26 s mean over 80 rounds on
 * 2026-10-09/10, 332 s at the worst — and most rounds install the lockfile
 * the round before installed. So a tree installed by a green `npm ci` is
 * kept under `<work root>/gate-cache/<repo slug>/<key>/node_modules`, and a
 * candidate whose key matches gets a clone of it (`cp -cR`, APFS
 * clonefile: the blocks are shared until written) instead of an install.
 *
 * The key is what `npm ci` reads and what it builds for: the candidate's
 * `package-lock.json` bytes, the fields of its `package.json` that change an
 * install (`INSTALL_FIELDS`), node's major version and module ABI, and the
 * platform and architecture. Until 2026-10-18 it hashed the whole manifest
 * and the full node version, so a version bump, a new script or a node patch
 * release was a miss and a 15-300 s `npm ci` for an identical tree. Anything
 * in the key differing is a miss, and a miss is `npm ci` as it always was.
 * Only `npm ci` on darwin, and only for a `package.json` with no lifecycle
 * script npm ci runs (`preinstall`, `install`, `postinstall`, `prepare`) —
 * with one, `npm ci` may write outside `node_modules`, a clone of
 * `node_modules` is not what it would have left, and scripts are not in the
 * key. A cache that cannot be read, cloned or written never stops a round:
 * every failure is said and becomes the install it replaced. Eviction is least recently used: a store sets `meta.at` and every hit renews it.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { runTool } from './child-async.js';
import { workGateCachePath } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';

/**
 * Entries kept per repository. Two (main's lockfile and one pull request's)
 * thrashed once a dependency bump and main both moved within a few rounds:
 * the third key evicted main's, and main's next round installed again. Four
 * keeps main's across a couple of lockfile-changing pull requests. memoro's
 * tree is about 500 MB as a copy, but clones share blocks on APFS until
 * written, so an entry costs far less than that.
 */
export const PREPARE_CACHE_KEEP = 4;

/**
 * An entry no round has used for fourteen days goes in `mc tidy` (rule A,
 * `tidy.js`), whatever the count. Nothing in this file uses it yet.
 */
export const PREPARE_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** The `package.json` fields that change what `npm ci` installs, in key order. */
export const INSTALL_FIELDS = Object.freeze([
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides',
  'engines', 'workspaces', 'packageManager', 'bundleDependencies', 'bundledDependencies',
]);

/** The lifecycle scripts `npm ci` runs for the root package; one of them keeps the cache out. */
const INSTALL_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall', 'prepare']);

const CACHED_PREPARE = 'npm ci';

export function prepareCacheDir({ repoPath, env = process.env } = {}) {
  return join(workGateCachePath(env), repoFileSlug(repoPath));
}

/**
 * sha256 over the lockfile, NUL, the install fields of the manifest (as JSON,
 * in `INSTALL_FIELDS` order, absent ones left out), NUL, node's major version
 * and module ABI, platform and architecture — first 16 hex. `manifest` is the
 * file's bytes or text; one that does not parse throws, and the caller runs
 * the install.
 */
export function prepareCacheKey({
  lock, manifest, node = process.version, abi = process.versions.modules, platform = process.platform, arch = process.arch,
}) {
  const parsed = JSON.parse(String(manifest));
  const fields = {};
  for (const field of INSTALL_FIELDS) if (parsed[field] !== undefined) fields[field] = parsed[field];
  const major = String(node).replace(/^v/u, '').split('.')[0];
  return createHash('sha256')
    .update(lock).update('\0')
    .update(JSON.stringify(fields)).update('\0')
    .update(`node ${major} abi ${abi} ${platform} ${arch}`)
    .digest('hex').slice(0, 16);
}

function defaultRun(command, args) {
  return runTool(command, args);
}

function readMeta(dir, read) {
  try { return JSON.parse(read(join(dir, 'meta.json'), 'utf8')); } catch { return null; }
}

/**
 * Prepare the candidate at `headDir`: a clone from the cache on a hit, the
 * prepare shell otherwise, and a store after a green `npm ci`. Returns what
 * the shell would have returned (`status`, `stderr`) plus `cached`.
 */
export async function prepareCandidate({
  prepare,
  headDir,
  cacheDir,
  shell,
  say = () => {},
  run = defaultRun,
  exists = existsSync,
  read = readFileSync,
  write = writeFileSync,
  now = () => Date.now(),
  platform = process.platform,
  node = process.version,
  pid = process.pid,
} = {}) {
  const install = async () => shell(prepare, { cwd: headDir });
  if (prepare !== CACHED_PREPARE || platform !== 'darwin' || !cacheDir) return { ...(await install()), cached: false };

  let key = null;
  try {
    const manifestBytes = read(join(headDir, 'package.json'));
    const scripts = JSON.parse(String(manifestBytes)).scripts || {};
    const script = INSTALL_SCRIPTS.find((name) => scripts[name]);
    if (script) {
      say(`prepare: the package.json has a ${script} script, so the cache is not used`);
      return { ...(await install()), cached: false };
    }
    key = prepareCacheKey({ lock: read(join(headDir, 'package-lock.json')), manifest: manifestBytes, node, platform });
  } catch (error) {
    say(`prepare: the cache key could not be read (${error.message}) — running ${prepare}`);
    return { ...(await install()), cached: false };
  }

  const entry = join(cacheDir, key);
  const target = join(headDir, 'node_modules');
  if (exists(join(entry, 'node_modules')) && readMeta(entry, read)?.key === key) {
    const cloned = await run('cp', ['-cR', join(entry, 'node_modules'), target]);
    if (cloned.status === 0) {
      try {
        const meta = readMeta(entry, read);
        write(join(entry, 'meta.json'), `${JSON.stringify({ ...meta, at: now(), hits: (Number(meta?.hits) || 0) + 1 })}\n`);
      } catch { /* the entry keeps its old `at`: evicted a little early, never a failed round */ }
      say(`prepare: cloned node_modules from the cache (${key})`);
      return { status: 0, stdout: '', stderr: '', cached: true, key };
    }
    say(`prepare: the clone from the cache (${key}) failed — ${String(cloned.stderr || cloned.error?.message || '').trim() || `exit ${cloned.status}`}; running ${prepare}`);
    try { rmSync(target, { recursive: true, force: true }); } catch { /* npm ci clears it anyway */ }
  }

  const installed = await install();
  if (installed.status === 0) await store({ key, entry, cacheDir, target, run, read, now, node, pid, say });
  return { ...installed, cached: false, key };
}

async function store({ key, entry, cacheDir, target, run, read, now, node, pid, say }) {
  const staging = `${entry}.tmp-${pid}`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const cloned = await run('cp', ['-cR', target, join(staging, 'node_modules')]);
    if (cloned.status !== 0) throw new Error(String(cloned.stderr || '').trim() || `cp exited ${cloned.status}`);
    const lockSha = createHash('sha256').update(read(join(target, '..', 'package-lock.json'))).digest('hex');
    writeFileSync(join(staging, 'meta.json'), `${JSON.stringify({ key, at: now(), node, lock_sha: lockSha })}\n`);
    try {
      renameSync(staging, entry);
    } catch (error) {
      // Another round stored the same key first: its copy is as good as ours.
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      rmSync(staging, { recursive: true, force: true });
    }
    evict({ cacheDir, read, say });
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* said below */ }
    say(`prepare: could not store node_modules in the cache (${error.message}) — the round goes on`);
  }
}

/**
 * Remove the least recently used entries — by `meta.at`, which a store sets and
 * every hit renews — until `PREPARE_CACHE_KEEP` remain.
 */
export function evict({ cacheDir, read = readFileSync, keep = PREPARE_CACHE_KEEP, say = () => {} }) {
  const entries = readdirSync(cacheDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.includes('.tmp-'))
    .map((item) => ({ name: item.name, at: Number(readMeta(join(cacheDir, item.name), read)?.at) || 0 }))
    .sort((a, b) => b.at - a.at);
  for (const old of entries.slice(keep)) {
    rmSync(join(cacheDir, old.name), { recursive: true, force: true });
    say(`prepare: evicted ${old.name} from the cache`);
  }
}

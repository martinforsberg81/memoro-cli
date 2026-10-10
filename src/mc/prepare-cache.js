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
 * `package-lock.json` bytes, its `package.json` bytes and `process.version`.
 * Anything else differing is a miss, and a miss is `npm ci` as it always
 * was. Only `npm ci` on darwin, and only for a `package.json` with no
 * `postinstall` or `prepare` script — with one, `npm ci` writes outside
 * `node_modules` and a clone of `node_modules` is not what it would have
 * left. A cache that cannot be read, cloned or written never stops a round:
 * every failure is said and becomes the install it replaced.
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
 * Entries kept per repository. One for main's lockfile and one for a pull
 * request that changed it. The disk was 98 % full on 2026-10-09 and memoro's
 * tree is about 500 MB as a copy; clones share blocks on APFS until written,
 * so they cost far less, but more than two is a cost nothing measured asks for.
 */
export const PREPARE_CACHE_KEEP = 2;

const CACHED_PREPARE = 'npm ci';

export function prepareCacheDir({ repoPath, env = process.env } = {}) {
  return join(workGateCachePath(env), repoFileSlug(repoPath));
}

/** sha256 over lockfile, NUL, manifest, NUL, node version — first 16 hex. */
export function prepareCacheKey({ lock, manifest, node = process.version }) {
  return createHash('sha256')
    .update(lock).update('\0')
    .update(manifest).update('\0')
    .update(String(node))
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
    if (scripts.postinstall || scripts.prepare) {
      say('prepare: the package.json has a postinstall or prepare script, so the cache is not used');
      return { ...(await install()), cached: false };
    }
    key = prepareCacheKey({ lock: read(join(headDir, 'package-lock.json')), manifest: manifestBytes, node });
  } catch (error) {
    say(`prepare: the cache key could not be read (${error.message}) — running ${prepare}`);
    return { ...(await install()), cached: false };
  }

  const entry = join(cacheDir, key);
  const target = join(headDir, 'node_modules');
  if (exists(join(entry, 'node_modules')) && readMeta(entry, read)?.key === key) {
    const cloned = await run('cp', ['-cR', join(entry, 'node_modules'), target]);
    if (cloned.status === 0) {
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

/** Remove the oldest entries by `meta.at` until `PREPARE_CACHE_KEEP` remain. */
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

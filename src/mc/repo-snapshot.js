/**
 * The watcher's snapshot — the interface everything else reads.
 *
 * `mc repo status` computing the whole view costs a fetch, a gh round and an
 * inspection of every checkout: seconds, per asker. Once several people ask —
 * a person, the PM, the board, a worker — that is the same work over and
 * over for an answer that changes once a minute at most.
 *
 * So the watcher does it once and writes it down, and everyone else reads a
 * file. That makes the snapshot, not the command, the thing that must be
 * trustworthy: written atomically so a reader never sees half of one, stamped
 * with the moment it was taken so a reader can see it is old, and kept under
 * mc's home so nothing is ever written inside a repository.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { mcHome } from './paths.js';

export const SNAPSHOT_SCHEMA = 'mc-repo-status';
export const SNAPSHOT_VERSION = 1;

/** A snapshot older than this many rounds is old news, and says so. */
export const STALE_ROUNDS = 3;

export const DEFAULT_INTERVAL_MS = 60_000;

export function repoStatusRoot(root = mcHome()) {
  return join(root, 'repo-status');
}

export function combinedPath(root = mcHome()) {
  return join(repoStatusRoot(root), 'all.json');
}

/**
 * One file per repository, named after it.
 *
 * The path is hashed into the name rather than trusted as one: two clones of
 * the same repository, or two repositories sharing a basename, must not land
 * on one file. The full path is inside the file too, so a reader can check
 * what it got rather than infer it from a name.
 */
export function repoSnapshotPath(repoPath, root = mcHome()) {
  const hash = createHash('sha1').update(String(repoPath)).digest('hex').slice(0, 8);
  return join(repoStatusRoot(root), `${basename(String(repoPath)) || 'repo'}-${hash}.json`);
}

export function watcherStatePath(root = mcHome()) {
  return join(repoStatusRoot(root), 'watcher.json');
}

export function watcherLogPath(root = mcHome()) {
  return join(repoStatusRoot(root), 'watcher.log');
}

/**
 * Write the round: one file per repository, then the combined one.
 *
 * The combined file goes last on purpose. It is what `mc repo status` reads,
 * so by the time its timestamp moves every part of that round is already on
 * disk under its own name.
 */
export function writeSnapshot(report, { intervalMs = DEFAULT_INTERVAL_MS, root = mcHome() } = {}) {
  const at = report.at || new Date().toISOString();
  const written = [];
  for (const repo of report.repos || []) {
    const path = repoSnapshotPath(repo.path, root);
    writeJsonAtomic(path, {
      schema: SNAPSHOT_SCHEMA, version: SNAPSHOT_VERSION, at, interval_ms: intervalMs, repo,
    });
    written.push(path);
  }
  const path = combinedPath(root);
  writeJsonAtomic(path, {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    at,
    interval_ms: intervalMs,
    offline: Boolean(report.offline),
    repos: report.repos || [],
  });
  written.push(path);
  // A repository that has gone away — its last work area released, its
  // installation unlinked — leaves a file behind that would otherwise be read
  // as current forever. The round that no longer sees it takes it away.
  for (const stale of orphans(written, root)) rmSync(stale, { force: true });
  return { at, written };
}

function orphans(written, root) {
  const kept = new Set(written);
  let entries = [];
  try { entries = readdirSync(repoStatusRoot(root)); } catch { return []; }
  return entries
    .filter((name) => name.endsWith('.json') && name !== 'watcher.json')
    .map((name) => join(repoStatusRoot(root), name))
    .filter((path) => !kept.has(path));
}

/**
 * The last round, or nothing.
 *
 * Anything unreadable — half-written by an older mc, hand-edited, from a
 * version that meant something else by these fields — reads as absent, and
 * absent means the view counts for itself. A snapshot is a saving of work,
 * never a source of truth that can fail closed.
 */
export function readCombinedSnapshot({ root = mcHome(), now = Date.now() } = {}) {
  return readSnapshotFile(combinedPath(root), now);
}

export function readRepoSnapshot(repoPath, { root = mcHome(), now = Date.now() } = {}) {
  return readSnapshotFile(repoSnapshotPath(repoPath, root), now);
}

function readSnapshotFile(path, now) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return { kind: 'absent' }; }
  if (raw?.schema !== SNAPSHOT_SCHEMA || raw?.version !== SNAPSHOT_VERSION) return { kind: 'absent' };
  const at = Date.parse(raw.at);
  if (!Number.isFinite(at)) return { kind: 'absent' };
  const intervalMs = Number.isFinite(raw.interval_ms) && raw.interval_ms > 0
    ? raw.interval_ms
    : DEFAULT_INTERVAL_MS;
  const ageMs = Math.max(0, now - at);
  return {
    kind: 'present',
    value: raw,
    at: raw.at,
    age_ms: ageMs,
    interval_ms: intervalMs,
    stale: ageMs > STALE_ROUNDS * intervalMs,
  };
}

/** Everything the snapshot directory holds, for a command that removes it. */
export function forgetSnapshots({ root = mcHome() } = {}) {
  const directory = repoStatusRoot(root);
  if (!existsSync(directory)) return [];
  const removed = [];
  for (const name of readdirSync(directory)) {
    if (name === 'watcher.json' || name === 'watcher.log') continue;
    const path = join(directory, name);
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
}

/**
 * Temp file, then rename — the same shape the dev-server registry uses.
 *
 * Rename is atomic within a directory, so a reader holding the path sees
 * either the previous round whole or this one whole. Writing in place would
 * hand a reader half a JSON document once a minute, and the reader would be
 * right to call it corrupt.
 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

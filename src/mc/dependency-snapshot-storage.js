import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { mcHome } from './paths.js';

export const DEFAULT_DEPENDENCY_SNAPSHOT_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const DIGEST_RE = /^[a-f0-9]{64}$/;
const TEMP_RE = /^([a-f0-9]{64})\.tmp-[a-zA-Z0-9-]+$/;

export function scanDependencySnapshots({
  mcDir = mcHome(),
  minAgeMs = DEFAULT_DEPENDENCY_SNAPSHOT_MIN_AGE_MS,
  now = Date.now(),
} = {}) {
  const root = join(mcDir, 'dependency-snapshots', 'v1', 'npm');
  const locksRoot = join(mcDir, 'dependency-snapshots', 'v1', 'locks');
  const items = [];
  for (const name of childNames(root)) {
    const digest = digestForName(name);
    if (!digest) continue;
    const path = join(root, name);
    const temporary = name !== digest;
    const metadata = temporary ? null : readJson(join(path, 'metadata.json'));
    const ready = !temporary
      && directoryKind(path) === 'directory'
      && directoryKind(join(path, 'node_modules')) === 'directory'
      && metadata?.schema_version === 1
      && metadata?.fingerprint === `sha256:${digest}`;
    const state = temporary ? 'temporary' : (ready ? 'ready' : 'invalid');
    const anchorMs = timestampMs(metadata?.last_used_at)
      ?? timestampMs(metadata?.created_at)
      ?? modifiedAtMs(path);
    const ageMs = Number.isFinite(anchorMs) ? Math.max(0, Number(now) - anchorMs) : Infinity;
    const lockPath = join(locksRoot, `${digest}.lock`);
    const locked = existsSync(lockPath);
    items.push({
      digest,
      name,
      path,
      state,
      locked,
      age_ms: ageMs,
      disk_bytes: duBytes(path),
      cleanup_candidate: !locked && ageMs >= minAgeMs,
      lock_path: lockPath,
    });
  }
  items.sort((a, b) => b.age_ms - a.age_ms || a.name.localeCompare(b.name));
  const candidates = items.filter((item) => item.cleanup_candidate);
  return {
    root,
    locks_root: locksRoot,
    min_age_ms: minAgeMs,
    counts: {
      total: items.length,
      ready: items.filter((item) => item.state === 'ready').length,
      invalid: items.filter((item) => item.state === 'invalid').length,
      temporary: items.filter((item) => item.state === 'temporary').length,
      locked: items.filter((item) => item.locked).length,
      candidates: candidates.length,
    },
    disk_bytes: sumBytes(items),
    reclaimable_bytes: sumBytes(candidates),
    items,
    candidates,
  };
}

export function reapDependencySnapshots(scan, { rm = rmSync } = {}) {
  const removed = [];
  const skipped = [];
  const errors = [];
  for (const item of scan?.candidates || []) {
    const name = basename(item.path || '');
    if (!digestForName(name) || join(scan.root, name) !== item.path) {
      errors.push({ ...publicItem(item), error: 'unsafe snapshot path' });
      continue;
    }
    let claimed = false;
    try {
      mkdirSync(scan.locks_root, { recursive: true, mode: 0o700 });
      writeFileSync(item.lock_path, JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        purpose: 'gc',
        acquired_at: new Date().toISOString(),
      }), { flag: 'wx', mode: 0o600 });
      claimed = true;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        skipped.push({ ...publicItem(item), reason: 'locked' });
        continue;
      }
      errors.push({ ...publicItem(item), error: error.message });
      continue;
    }
    try {
      rm(item.path, { recursive: true, force: true });
      removed.push(publicItem(item));
    } catch (error) {
      errors.push({ ...publicItem(item), error: error.message });
    } finally {
      if (claimed) {
        try { unlinkSync(item.lock_path); } catch {}
      }
    }
  }
  return {
    ok: errors.length === 0,
    removed,
    skipped,
    reclaimed_bytes: sumBytes(removed),
    ...(errors.length ? { errors } : {}),
  };
}

export function dependencySnapshotScanJson(scan) {
  return {
    min_age_ms: scan.min_age_ms,
    counts: scan.counts,
    disk_bytes: scan.disk_bytes,
    reclaimable_bytes: scan.reclaimable_bytes,
    candidates: scan.candidates.map(publicItem),
  };
}

function publicItem(item) {
  return {
    digest: item.digest,
    path: item.path,
    state: item.state,
    age_ms: item.age_ms,
    disk_bytes: item.disk_bytes,
  };
}

function digestForName(name) {
  if (DIGEST_RE.test(name)) return name;
  return name.match(TEMP_RE)?.[1] || null;
}

function childNames(path) {
  try { return readdirSync(path); } catch { return []; }
}

function directoryKind(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink';
    return stat.isDirectory() ? 'directory' : 'other';
  } catch {
    return 'missing';
  }
}

function modifiedAtMs(path) {
  try { return lstatSync(path).mtimeMs; } catch { return null; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function timestampMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function duBytes(path) {
  if (!existsSync(path)) return 0;
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const blocks = Number((result.stdout || '').trim().split(/\s+/)[0]);
  return Number.isFinite(blocks) ? blocks * 1024 : null;
}

function sumBytes(items) {
  return items.reduce((sum, item) => sum + (Number.isFinite(item.disk_bytes) ? item.disk_bytes : 0), 0);
}

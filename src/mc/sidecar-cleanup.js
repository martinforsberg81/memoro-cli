import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { mcHome } from './paths.js';
import { readRegistry } from './registry.js';
import { listLocalBrokerAndHostSessions } from './broker/session-hosts.js';

export const DEFAULT_SIDECAR_MIN_AGE_MS = 5 * 60 * 1000;

export async function scanRuntimeSidecars({
  mcDir = mcHome(),
  registry = readRegistry(),
  listSessions = listLocalBrokerAndHostSessions,
  isAlive = defaultIsAlive,
  minAgeMs = DEFAULT_SIDECAR_MIN_AGE_MS,
  now = Date.now(),
} = {}) {
  const registeredIds = new Set((registry?.entries || [])
    .map((entry) => nonEmpty(entry?.coding_session_id))
    .filter(Boolean));
  const items = listSidecarDirs(mcDir, { now, isAlive });
  const liveIds = await liveSessionIds({ listSessions });
  for (const item of items) {
    if (item.kind === 'host' && item.pid_alive && item.sessionId) {
      liveIds.add(item.sessionId);
    }
  }
  const candidates = [];
  const kept = {
    live: 0,
    registered: 0,
    fresh: 0,
    malformed: 0,
  };

  for (const item of items) {
    const sessionId = nonEmpty(item.sessionId);
    if (!sessionId) {
      kept.malformed += 1;
      continue;
    }
    if (liveIds.has(sessionId)) {
      kept.live += 1;
      continue;
    }
    if (registeredIds.has(sessionId)) {
      kept.registered += 1;
      continue;
    }
    if (Number.isFinite(minAgeMs) && item.ageMs < minAgeMs) {
      kept.fresh += 1;
      continue;
    }
    candidates.push({
      kind: item.kind,
      session_id: sessionId,
      path: item.path,
      age_ms: item.ageMs,
      reason: 'not-live-not-registered',
    });
  }

  return {
    candidates,
    counts: {
      candidates: candidates.length,
      kept,
      live_session_ids: liveIds.size,
      registered_session_ids: registeredIds.size,
    },
  };
}

export function reapRuntimeSidecars(scan, {
  remove = (path) => rmSync(path, { recursive: true, force: true }),
} = {}) {
  const removed = [];
  const errors = [];
  for (const item of scan?.candidates || []) {
    try {
      remove(item.path);
      removed.push(item);
    } catch (err) {
      errors.push({
        ...item,
        error: err?.message || String(err),
      });
    }
  }
  return {
    ok: errors.length === 0,
    removed,
    ...(errors.length ? { errors } : {}),
  };
}

async function liveSessionIds({ listSessions }) {
  const sessions = await listSessions().catch(() => []);
  const out = new Set();
  for (const session of sessions || []) {
    const id = nonEmpty(session?.id || session?.coding_session_id || session?.host_session_id);
    if (id) out.add(id);
  }
  return out;
}

function listSidecarDirs(mcDir, { now = Date.now(), isAlive = defaultIsAlive } = {}) {
  return [
    ...listChildDirs(join(mcDir, 'hosts'), 'host', { now, isAlive }),
    ...listChildDirs(join(mcDir, 'guard-bin'), 'guard-bin', { now }),
  ];
}

function listChildDirs(root, kind, { now = Date.now(), isAlive = defaultIsAlive } = {}) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of safeReaddir(root)) {
    const path = join(root, entry.name);
    const stats = safeStat(path);
    if (!stats?.isDirectory()) continue;
    out.push({
      kind,
      sessionId: basename(path),
      path,
      ageMs: Math.max(0, now - stats.mtimeMs),
      pid_alive: kind === 'host' ? pidFileIsAlive(join(path, 'broker.pid'), { isAlive }) : false,
    });
  }
  return out;
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function pidFileIsAlive(path, { isAlive = defaultIsAlive } = {}) {
  let pid = null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    return false;
  }
  return isAlive(pid);
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

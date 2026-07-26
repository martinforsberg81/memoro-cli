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
  const candidates = [];
  const zombieHosts = [];
  const kept = {
    live: 0,
    registered: 0,
    fresh: 0,
    malformed: 0,
    zombie: 0,
  };

  // First pass: classify hosts, so a zombie host's OTHER sidecars (its
  // guard-bin, etc.) stay protected while its processes are still alive —
  // pulling guards out from under a running tool is not "safe" cleanup.
  const zombieIds = new Set();
  for (const item of items) {
    if (item.kind !== 'host' || !item.pid_alive || !item.sessionId) continue;
    if (liveIds.has(item.sessionId)) continue;
    // Daemon pid alive but its session is not enumerable. A busy daemon
    // is already reported live by the enumeration (timeout ⇒ busy), so
    // what remains here is a host that can never be attached again —
    // typically its socket file is gone. Report it separately: reaping
    // kills processes and must be an explicit, non-default choice.
    zombieIds.add(item.sessionId);
    zombieHosts.push({
      kind: 'zombie-host',
      session_id: item.sessionId,
      path: item.path,
      pid: item.pid ?? null,
      age_ms: item.ageMs,
      reason: 'pid-alive-session-unreachable',
    });
  }

  for (const item of items) {
    const sessionId = nonEmpty(item.sessionId);
    if (!sessionId) {
      kept.malformed += 1;
      continue;
    }
    if (zombieIds.has(sessionId)) {
      if (item.kind !== 'host') kept.zombie += 1;
      continue;
    }
    if (item.kind === 'host' && item.pid_alive) {
      kept.live += 1;
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
    zombie_hosts: zombieHosts,
    counts: {
      candidates: candidates.length,
      zombie_hosts: zombieHosts.length,
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

/**
 * Kill unreachable host daemons and remove their dirs. Destructive by
 * nature (the daemon's tool process dies with its process group), so the
 * caller must pass the zombie list explicitly — nothing here runs as part
 * of the default sidecar reap.
 */
export async function reapZombieHosts(zombieHosts, {
  remove = (path) => rmSync(path, { recursive: true, force: true }),
  kill = defaultKillTree,
  isAlive = defaultIsAlive,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = 2_000,
  pollMs = 50,
} = {}) {
  const removed = [];
  const errors = [];
  for (const item of zombieHosts || []) {
    try {
      if (item.pid != null && isAlive(item.pid)) {
        kill(item.pid, 'SIGTERM');
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && isAlive(item.pid)) await sleep(pollMs);
        if (isAlive(item.pid)) {
          kill(item.pid, 'SIGKILL');
          const hardDeadline = Date.now() + waitMs;
          while (Date.now() < hardDeadline && isAlive(item.pid)) await sleep(pollMs);
        }
        if (isAlive(item.pid)) {
          errors.push({ ...item, error: 'process would not exit' });
          continue;
        }
      }
      remove(item.path);
      removed.push(item);
    } catch (err) {
      errors.push({ ...item, error: err?.message || String(err) });
    }
  }
  return {
    ok: errors.length === 0,
    removed,
    ...(errors.length ? { errors } : {}),
  };
}

function defaultKillTree(pid, signal) {
  // Detached daemons lead their own process group; signalling the group
  // takes the daemon and its tool child together.
  try {
    process.kill(-pid, signal);
    return;
  } catch {}
  try {
    process.kill(pid, signal);
  } catch {}
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
    const pid = kind === 'host' ? readPidFile(join(path, 'broker.pid')) : null;
    out.push({
      kind,
      sessionId: basename(path),
      path,
      ageMs: Math.max(0, now - stats.mtimeMs),
      pid,
      pid_alive: pid != null && isAlive(pid),
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

function readPidFile(path) {
  try {
    const parsed = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
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

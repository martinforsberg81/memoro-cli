import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { requestBroker } from './client.js';
import { BROKER_PROTOCOL_VERSION } from './daemon.js';
import { sessionHostPaths, sessionHostsDir } from './paths.js';
import { spawnBrokerDaemon, START_POLL_MS, POLL_INTERVAL_MS, checkBrokerCompatibility } from './supervisor.js';

export async function ensureSessionHostRunning({
  sessionId,
  request = requestBroker,
  spawnDaemon = spawnBrokerDaemon,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = START_POLL_MS,
  intervalMs = POLL_INTERVAL_MS,
  expectedProtocolVersion = BROKER_PROTOCOL_VERSION,
  now = () => new Date().toISOString(),
} = {}) {
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  const paths = sessionHostPaths(sessionId);
  const hostRequest = (message) => request(message, { socketPath: paths.socketPath });
  const existing = await hostRequest({ type: 'status' }).catch(() => null);
  if (existing?.ok) {
    const compatibility = checkBrokerCompatibility(existing, { expectedProtocolVersion });
    if (compatibility.ok) {
      writeSessionHostManifest({ sessionId, paths, broker: existing.broker, now });
      return { ok: true, alreadyRunning: true, ...paths, broker: existing.broker };
    }
  }

  cleanupSessionHostFiles(paths);
  const spawned = spawnDaemon({
    socketPath: paths.socketPath,
    pidPath: paths.pidPath,
    logPath: paths.logPath,
  });
  if (!spawned.ok) return spawned;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await hostRequest({ type: 'status' }).catch(() => null);
    if (res?.ok) {
      writeSessionHostManifest({ sessionId, paths, broker: res.broker, now });
      return { ok: true, started: true, ...paths, broker: res.broker };
    }
    await sleep(intervalMs);
  }
  return { ok: false, error: 'session host did not become ready in time', ...paths };
}

export async function listSessionHostSessions({
  request = requestBroker,
  hostsDir = sessionHostsDir(),
} = {}) {
  const manifests = readSessionHostManifests({ hostsDir });
  const sessions = [];
  for (const manifest of manifests) {
    const socketPath = manifest.socket_path || manifest.socketPath;
    if (!socketPath) continue;
    const res = await request({ type: 'sessions' }, { socketPath }).catch(() => null);
    const rows = res?.ok && Array.isArray(res.sessions) ? res.sessions : [];
    for (const row of rows) {
      sessions.push({
        ...row,
        broker_socket_path: socketPath,
        broker_pid_path: manifest.pid_path || manifest.pidPath || null,
        broker_log_path: manifest.log_path || manifest.logPath || null,
        host_session_id: manifest.session_id || manifest.sessionId || row.id || row.coding_session_id || null,
        host_kind: 'session',
      });
    }
  }
  return sessions;
}

export async function listLocalBrokerAndHostSessions({
  request = requestBroker,
  includeHosts = request === requestBroker,
  hostsDir = sessionHostsDir(),
} = {}) {
  const [brokerSessions, hostSessions] = await Promise.all([
    listGlobalBrokerSessions({ request }).catch(() => []),
    includeHosts ? listSessionHostSessions({ request, hostsDir }).catch(() => []) : [],
  ]);
  return dedupeSessions([...hostSessions, ...brokerSessions]);
}

export function requestForSession(session, {
  request = requestBroker,
} = {}) {
  const socketPath = session?.broker_socket_path || session?.brokerSocketPath || null;
  return (message) => request(message, socketPath ? { socketPath } : undefined);
}

export function readSessionHostManifests({ hostsDir = sessionHostsDir() } = {}) {
  if (!existsSync(hostsDir)) return [];
  const out = [];
  for (const name of safeReaddir(hostsDir)) {
    const path = join(hostsDir, name, 'host.json');
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {}
  }
  return out;
}

function writeSessionHostManifest({ sessionId, paths, broker = {}, now = () => new Date().toISOString() } = {}) {
  mkdirSync(dirname(paths.manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(paths.manifestPath, JSON.stringify({
    session_id: sessionId,
    socket_path: paths.socketPath,
    pid_path: paths.pidPath,
    log_path: paths.logPath,
    broker_pid: broker?.pid || null,
    protocol_version: broker?.protocol_version || BROKER_PROTOCOL_VERSION,
    updated_at: now(),
  }, null, 2), { mode: 0o600 });
}

function cleanupSessionHostFiles(paths) {
  for (const path of [paths.socketPath, paths.pidPath]) {
    try { rmSync(path, { force: true }); } catch {}
  }
}

async function listGlobalBrokerSessions({ request = requestBroker } = {}) {
  const res = await request({ type: 'sessions' }).catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (res?.ok && Array.isArray(res.sessions)) return annotateGlobalBrokerSessions(res.sessions);
  const status = await request({ type: 'status' }).catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (status?.ok && Array.isArray(status.sessions)) return annotateGlobalBrokerSessions(status.sessions);
  return [];
}

function annotateGlobalBrokerSessions(sessions) {
  return sessions.map((session) => ({ ...session }));
}

function dedupeSessions(sessions) {
  const byKey = new Map();
  for (const session of sessions) {
    const id = session?.id || session?.coding_session_id;
    const cwd = session?.cwd || '';
    const key = id || cwd;
    if (!key.trim()) continue;
    if (!byKey.has(key)) byKey.set(key, session);
  }
  return [...byKey.values()];
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';

import { requestBroker } from './client.js';
import { BROKER_PROTOCOL_VERSION } from './daemon.js';
import { BROKER_RUNTIME_IDENTITY } from './runtime-identity.js';
import { sessionHostPaths, sessionHostsDir } from './paths.js';
import { probeSessionHostRuntime } from '../../core/liveness/host-probe.js';

export { probeSessionHostRuntime };
import {
  spawnBrokerDaemon,
  START_POLL_MS,
  POLL_INTERVAL_MS,
  checkBrokerCompatibility,
  liveBrokerSessions,
  retireTerminalBrokerSessions,
  stopExistingBroker,
} from './supervisor.js';

const HOST_START_LOG_TAIL_CHARS = 4000;
const HOST_START_ERROR_CHARS = 1200;
const HOST_RUNTIME_PROBE_TIMEOUT_MS = 600;
const BOOT_CLOCK_SLACK_MS = 5_000;
const CONTROLLER_REQUEST_TYPES = new Set([
  'attach_session',
  'write_session',
  'dispatch_session',
  'fetch_session_output',
  'resize_session',
  'stop_session',
  'remove_session',
  'handoff_switch_read',
  'run_claude_c1',
]);

export async function ensureSessionHostRunning({
  sessionId,
  controllerBinding = null,
  paths = sessionHostPaths(sessionId),
  request = requestBroker,
  spawnDaemon = spawnBrokerDaemon,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = START_POLL_MS,
  intervalMs = POLL_INTERVAL_MS,
  expectedProtocolVersion = BROKER_PROTOCOL_VERSION,
  expectedRuntimeIdentity = BROKER_RUNTIME_IDENTITY,
  now = () => new Date().toISOString(),
} = {}) {
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  const hostRequest = (message) => request(message, { socketPath: paths.socketPath });
  const existing = await hostRequest({ type: 'status' }).catch(() => null);
  if (existing?.ok) {
    const compatibility = checkBrokerCompatibility(existing, {
      expectedProtocolVersion,
      expectedRuntimeIdentity,
    });
    if (compatibility.ok) {
      writeSessionHostManifest({ sessionId, paths, broker: existing.broker, now });
      return { ok: true, alreadyRunning: true, ...paths, broker: existing.broker };
    }
    const liveSessions = liveBrokerSessions(existing.sessions);
    if (liveSessions.length > 0 || !Array.isArray(existing.sessions)) {
      return {
        ok: false,
        reason: liveSessions.length > 0
          ? 'broker-protocol-incompatible-live'
          : 'broker-protocol-incompatible-unknown',
        compatibility_reason: compatibility.reason,
        broker: existing.broker,
        live_sessions: liveSessions,
        // "end" is PERMANENT teardown — never the remedy for a runtime
        // upgrade. The non-destructive way out is exiting the running
        // tool; the empty incompatible host is then replaced on reopen.
        error: liveSessions.length > 0
          ? `session host is incompatible (${compatibility.reason}) with ${liveSessions.length} live session(s); exit the running tool in its terminal (Ctrl+D), then retry — nothing is deleted`
          : `session host is incompatible (${compatibility.reason}) and its session inventory is unavailable; refusing to replace it`,
      };
    }
    const retired = await retireTerminalBrokerSessions({
      request: hostRequest,
      sessions: existing.sessions,
      controllerCapability: validControllerBinding(controllerBinding, sessionId)
        ? controllerBinding.session_controller_capability
        : null,
    });
    if (!retired.ok) {
      return {
        ...retired,
        reason: 'broker-protocol-replacement-failed',
        compatibility_reason: compatibility.reason,
      };
    }
    const stopped = await stopExistingBroker({
      request: hostRequest,
      sleep,
      timeoutMs,
      intervalMs,
    });
    if (!stopped.ok) {
      return {
        ...stopped,
        reason: 'broker-protocol-replacement-failed',
        compatibility_reason: compatibility.reason,
      };
    }
  }

  cleanupSessionHostFiles(paths);
  if (!validControllerBinding(controllerBinding, sessionId)) {
    return {
      ok: false,
      reason: 'session-controller-bootstrap-required',
      error: 'session controller bootstrap is required to start the host',
      ...paths,
    };
  }
  const spawned = spawnDaemon({
    socketPath: paths.socketPath,
    pidPath: paths.pidPath,
    logPath: paths.logPath,
    controllerBinding,
  });
  if (!spawned.ok) return spawned;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await hostRequest({ type: 'status' }).catch(() => null);
    if (res?.ok) {
      const compatibility = checkBrokerCompatibility(res, {
        expectedProtocolVersion,
        expectedRuntimeIdentity,
      });
      if (!compatibility.ok) {
        const liveSessions = liveBrokerSessions(res.sessions);
        return {
          ok: false,
          reason: liveSessions.length > 0
            ? 'broker-protocol-incompatible-live'
            : 'broker-protocol-incompatible-unknown',
          compatibility_reason: compatibility.reason,
          broker: res.broker,
          live_sessions: liveSessions,
          error: liveSessions.length > 0
            ? `session host is incompatible (${compatibility.reason}) with ${liveSessions.length} live session(s); refusing to launch through it`
            : `session host is incompatible (${compatibility.reason}); refusing to launch through it`,
          ...paths,
        };
      }
      writeSessionHostManifest({ sessionId, paths, broker: res.broker, now });
      return { ok: true, started: true, ...paths, broker: res.broker };
    }
    await sleep(intervalMs);
  }
  return { ok: false, error: sessionHostStartError(paths), ...paths };
}

function validControllerBinding(value, sessionId) {
  return value?.schema === 'mc-broker-controller-bootstrap-v1'
    && value.session_id === sessionId
    && /^[a-f0-9]{64}$/.test(value.session_controller_capability || '');
}

// A host whose daemon is busy (an active tool streaming PTY output hogs
// its event loop) may miss this deadline entirely — and that is fine:
// a timeout classifies the host as busy-live from its manifest (see
// below), so the deadline only bounds how long enumeration waits for
// full row details. Total sweep wall-clock ≈ one deadline, so keep it
// short; correctness never depends on it.
const HOST_PROBE_TIMEOUT_MS = 600;
const HOST_PROBE_CONCURRENCY = 16;

export async function listSessionHostSessions({
  request = requestBroker,
  hostsDir = sessionHostsDir(),
  probeTimeoutMs = HOST_PROBE_TIMEOUT_MS,
} = {}) {
  const manifests = readSessionHostManifests({ hostsDir })
    .filter((manifest) => manifest.socket_path || manifest.socketPath);
  const results = new Array(manifests.length);
  let next = 0;
  const worker = async () => {
    while (next < manifests.length) {
      const index = next++;
      const manifest = manifests[index];
      const socketPath = manifest.socket_path || manifest.socketPath;
      results[index] = await request({ type: 'sessions' }, { socketPath, timeoutMs: probeTimeoutMs })
        .then((res) => ({ manifest, socketPath, res }))
        .catch((err) => ({ manifest, socketPath, res: null, timedOut: isTimeoutError(err) }));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HOST_PROBE_CONCURRENCY, manifests.length) }, worker),
  );

  const sessions = [];
  for (const { manifest, socketPath, res, timedOut } of results) {
    const hostMeta = {
      broker_socket_path: socketPath,
      broker_pid_path: manifest.pid_path || manifest.pidPath || null,
      broker_log_path: manifest.log_path || manifest.logPath || null,
      host_kind: 'session',
    };
    if (!res && timedOut) {
      // The socket accepted but never answered inside the deadline: the
      // daemon's event loop is busy (an active tool streaming output), not
      // dead. Losing the row would present a live session as stale, so
      // report what the manifest knows. Dead sockets (refused / missing)
      // still drop out here.
      const sessionId = manifest.session_id || manifest.sessionId || null;
      if (sessionId) {
        sessions.push({
          id: sessionId,
          coding_session_id: sessionId,
          session_state: 'live',
          attachable: true,
          host_busy: true,
          host_session_id: sessionId,
          ...hostMeta,
        });
      }
      continue;
    }
    const rows = res?.ok && Array.isArray(res.sessions) ? res.sessions : [];
    for (const row of rows) {
      sessions.push({
        ...row,
        ...hostMeta,
        host_session_id: manifest.session_id || manifest.sessionId || row.id || row.coding_session_id || null,
      });
    }
  }
  return sessions;
}

function isTimeoutError(err) {
  return /timed out/i.test(err?.message || '');
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
  controllerCapability = null,
} = {}) {
  const socketPath = session?.broker_socket_path || session?.brokerSocketPath || null;
  return (message) => request({
    ...message,
    ...(controllerCapability && CONTROLLER_REQUEST_TYPES.has(message?.type)
      ? { session_controller_capability: controllerCapability }
      : {}),
  }, socketPath ? { socketPath } : undefined);
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
    lifecycle_path: paths.lifecyclePath,
    broker_pid: broker?.pid || null,
    protocol_version: broker?.protocol_version || BROKER_PROTOCOL_VERSION,
    runtime_identity: broker?.runtime_identity || BROKER_RUNTIME_IDENTITY,
    updated_at: now(),
  }, null, 2), { mode: 0o600 });
}

function cleanupSessionHostFiles(paths) {
  for (const path of [paths.socketPath, paths.artifactSocketPath, paths.pidPath]) {
    try { rmSync(path, { force: true }); } catch {}
  }
}

function sessionHostStartError(paths) {
  const logTail = readSessionHostLogTail(paths.logPath);
  if (!logTail) return 'session host did not become ready in time';
  return `session host did not become ready in time; recent log: ${logTail}`;
}

function readSessionHostLogTail(logPath) {
  if (!logPath) return '';
  try {
    const raw = readFileSync(logPath, 'utf8');
    const text = String(raw || '')
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .trim();
    if (!text) return '';
    return text
      .slice(-HOST_START_LOG_TAIL_CHARS)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-12)
      .join(' | ')
      .slice(0, HOST_START_ERROR_CHARS);
  } catch {
    return '';
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

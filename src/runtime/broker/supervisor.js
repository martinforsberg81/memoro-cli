import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { requestBroker } from './client.js';
import { brokerLogPath } from './paths.js';
import { BROKER_PROTOCOL_VERSION } from './daemon.js';
import { BROKER_RUNTIME_IDENTITY } from './runtime-identity.js';
import { scrubRuntimeSecretsFromEnv } from '../../mc/runtime-secrets.js';

// A cold global Node CLI start can exceed five seconds on macOS after package
// replacement, while the detached broker computes and binds its exact runtime
// identity. Keep startup bounded without reporting failure for a host that
// becomes healthy moments later.
export const START_POLL_MS = 15_000;
export const POLL_INTERVAL_MS = 100;

export async function ensureBrokerRunning({
  request = requestBroker,
  spawnDaemon = spawnBrokerDaemon,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = START_POLL_MS,
  intervalMs = POLL_INTERVAL_MS,
  readyFile = null,
  expectedProtocolVersion = BROKER_PROTOCOL_VERSION,
  expectedRuntimeIdentity = BROKER_RUNTIME_IDENTITY,
} = {}) {
  const existing = await request({ type: 'status' }).catch(() => null);
  if (existing?.ok) {
    const compatibility = checkBrokerCompatibility(existing, {
      expectedProtocolVersion,
      expectedRuntimeIdentity,
    });
    if (compatibility.ok) {
      return { ok: true, alreadyRunning: true, broker: existing.broker };
    }

    const liveSessions = liveBrokerSessions(existing.sessions);
    if (liveSessions.length > 0 || !Array.isArray(existing.sessions)) {
      return {
        ok: false,
        stale: true,
        reason: liveSessions.length > 0
          ? 'broker-protocol-incompatible-live'
          : 'broker-protocol-incompatible-unknown',
        compatibility_reason: compatibility.reason,
        broker: existing.broker,
        live_sessions: liveSessions,
        error: liveSessions.length > 0
          ? `running broker is incompatible (${compatibility.reason}) with ${liveSessions.length} live session(s); end them with the previous mc version before starting a new broker`
          : `running broker is incompatible (${compatibility.reason}) and its session inventory is unavailable; refusing to replace it`,
      };
    }

    const stopped = await stopExistingBroker({ request, sleep, timeoutMs, intervalMs });
    if (!stopped.ok) return stopped;
  }

  const spawned = spawnDaemon({ readyFile });
  if (!spawned.ok) return spawned;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await request({ type: 'status' }).catch(() => null);
    if (res?.ok) {
      const compatibility = checkBrokerCompatibility(res, {
        expectedProtocolVersion,
        expectedRuntimeIdentity,
      });
      if (compatibility.ok) return { ok: true, started: true, broker: res.broker };
      return incompatibleBrokerResult(res, compatibility);
    }
    await sleep(intervalMs);
  }
  return { ok: false, error: 'broker did not become ready in time' };
}

function incompatibleBrokerResult(status, compatibility) {
  const liveSessions = liveBrokerSessions(status?.sessions);
  const inventoryKnown = Array.isArray(status?.sessions);
  return {
    ok: false,
    stale: true,
    reason: liveSessions.length > 0
      ? 'broker-protocol-incompatible-live'
      : 'broker-protocol-incompatible-unknown',
    compatibility_reason: compatibility.reason,
    broker: status?.broker || null,
    live_sessions: liveSessions,
    error: liveSessions.length > 0
      ? `running broker is incompatible (${compatibility.reason}) with ${liveSessions.length} live session(s); end them with the previous mc version before starting a new broker`
      : inventoryKnown
        ? `running broker is incompatible (${compatibility.reason}); refusing to launch through it`
        : `running broker is incompatible (${compatibility.reason}) and its session inventory is unavailable; refusing to replace it`,
  };
}

export function checkBrokerCompatibility(status, {
  expectedProtocolVersion = BROKER_PROTOCOL_VERSION,
  expectedRuntimeIdentity = BROKER_RUNTIME_IDENTITY,
} = {}) {
  if (!status?.ok) return { ok: false, reason: 'status_unavailable' };
  const broker = status.broker || {};
  if (!broker.protocol_version) return { ok: false, reason: 'missing_protocol_version' };
  if (broker.protocol_version !== expectedProtocolVersion) {
    return {
      ok: false,
      reason: `protocol_mismatch:${broker.protocol_version}`,
    };
  }
  if (!broker.runtime_identity) {
    return { ok: false, reason: 'missing_runtime_identity' };
  }
  if (broker.runtime_identity !== expectedRuntimeIdentity) {
    return { ok: false, reason: 'runtime_identity_mismatch' };
  }
  return { ok: true };
}

export function liveBrokerSessions(sessions = []) {
  if (!Array.isArray(sessions)) return [];
  return sessions
    .filter((session) => session && session.session_state !== 'dead' && !session.exit)
    .map((session) => ({
      id: session.id || session.coding_session_id || null,
      name: session.name || null,
      cwd: session.cwd || null,
      tool: session.tool || null,
    }));
}

export async function retireTerminalBrokerSessions({
  request,
  sessions,
  controllerCapability = null,
} = {}) {
  if (typeof request !== 'function' || !Array.isArray(sessions)) {
    return { ok: false, error: 'terminal broker session inventory is unavailable' };
  }
  if (liveBrokerSessions(sessions).length > 0) {
    return { ok: false, error: 'live broker sessions cannot be retired for replacement' };
  }
  for (const session of sessions) {
    const id = session?.id || session?.coding_session_id || null;
    if (typeof id !== 'string' || !id) {
      return { ok: false, error: 'terminal broker session identity is unavailable' };
    }
    if (typeof controllerCapability !== 'string' || !controllerCapability) {
      return { ok: false, error: 'terminal broker session controller is unavailable' };
    }
    const removed = await request({
      type: 'remove_session',
      id,
      session_controller_capability: controllerCapability,
    }).catch((error) => ({
      ok: false,
      error: error?.message || String(error),
    }));
    if (!removed?.ok) {
      return {
        ok: false,
        error: `terminal broker session removal failed (${removed?.reason || removed?.error || 'unknown'})`,
      };
    }
  }
  if (sessions.length === 0) return { ok: true, retired: 0 };
  const verified = await request({ type: 'status' }).catch(() => null);
  if (!verified?.ok || !Array.isArray(verified.sessions)
    || verified.sessions.length > 0) {
    return {
      ok: false,
      error: 'terminal broker session removal could not be verified',
    };
  }
  return { ok: true, retired: sessions.length };
}

export async function stopExistingBroker({ request, sleep, timeoutMs, intervalMs }) {
  const stopped = await request({ type: 'stop' }).catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (!stopped?.ok) {
    return { ok: false, error: `stale broker stop failed (${stopped?.error || 'unknown'})` };
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await request({ type: 'status' }).catch(() => null);
    if (!res?.ok) return { ok: true, stopped: true };
    await sleep(intervalMs);
  }
  return { ok: false, error: 'stale broker did not stop in time' };
}

export function spawnBrokerDaemon({
  readyFile = null,
  socketPath = null,
  pidPath = null,
  controllerBinding = null,
  logPath = brokerLogPath(),
  env = process.env,
  argv = process.argv,
  cwd = process.cwd(),
  spawnImpl = spawn,
  openSyncImpl = openSync,
} = {}) {
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const out = openSyncImpl(logPath, 'a');
    const err = openSyncImpl(logPath, 'a');
    const args = [process.execPath, argv[1], 'broker', '--daemon'];
    if (readyFile) args.push('--ready-file', readyFile);
    if (socketPath) args.push('--socket-path', socketPath);
    if (pidPath) args.push('--pid-path', pidPath);
    const bootstrap = validateControllerBinding(controllerBinding);
    if (controllerBinding && !bootstrap) {
      return { ok: false, error: 'invalid broker controller bootstrap' };
    }
    if (bootstrap) args.push('--controller-bootstrap');
    const child = spawnImpl(args[0], args.slice(1), {
      detached: true,
      stdio: [bootstrap ? 'pipe' : 'ignore', out, err],
      cwd,
      env: scrubRuntimeSecretsFromEnv(env),
    });
    if (bootstrap) {
      if (!child.stdin?.end) {
        try { child.kill?.('SIGTERM'); } catch {}
        return { ok: false, error: 'broker controller bootstrap pipe unavailable' };
      }
      child.stdin.on?.('error', () => {});
      child.stdin.end(`${JSON.stringify(bootstrap)}\n`);
    }
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function validateControllerBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => ![
      'schema',
      'session_id',
      'session_controller_capability',
    ].includes(key))
    || value.schema !== 'mc-broker-controller-bootstrap-v1'
    || !/^sess_[A-Za-z0-9_-]{6,}$/.test(value.session_id || '')
    || !/^[a-f0-9]{64}$/.test(value.session_controller_capability || '')) {
    return null;
  }
  return {
    schema: value.schema,
    session_id: value.session_id,
    session_controller_capability: value.session_controller_capability,
  };
}

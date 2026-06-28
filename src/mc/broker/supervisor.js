import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { requestBroker } from './client.js';
import { brokerLogPath } from './paths.js';
import { BROKER_PROTOCOL_VERSION } from './daemon.js';
import { scrubRuntimeSecretsFromEnv } from '../runtime-secrets.js';

export const START_POLL_MS = 1_500;
export const POLL_INTERVAL_MS = 100;

export async function ensureBrokerRunning({
  request = requestBroker,
  spawnDaemon = spawnBrokerDaemon,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = START_POLL_MS,
  intervalMs = POLL_INTERVAL_MS,
  readyFile = null,
  expectedProtocolVersion = BROKER_PROTOCOL_VERSION,
} = {}) {
  const existing = await request({ type: 'status' }).catch(() => null);
  if (existing?.ok) {
    const compatibility = checkBrokerCompatibility(existing, { expectedProtocolVersion });
    if (compatibility.ok) {
      return { ok: true, alreadyRunning: true, broker: existing.broker };
    }

    const liveSessions = liveBrokerSessions(existing.sessions);
    if (liveSessions.length > 0) {
      return {
        ok: false,
        stale: true,
        reason: compatibility.reason,
        broker: existing.broker,
        live_sessions: liveSessions,
        error: `running broker is stale (${compatibility.reason}) with ${liveSessions.length} live session(s); end them or run \`mc broker stop\` before starting a new broker`,
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
    if (res?.ok) return { ok: true, started: true, broker: res.broker };
    await sleep(intervalMs);
  }
  return { ok: false, error: 'broker did not become ready in time' };
}

export function checkBrokerCompatibility(status, {
  expectedProtocolVersion = BROKER_PROTOCOL_VERSION,
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

async function stopExistingBroker({ request, sleep, timeoutMs, intervalMs }) {
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
    const child = spawnImpl(args[0], args.slice(1), {
      detached: true,
      stdio: ['ignore', out, err],
      cwd,
      env: scrubRuntimeSecretsFromEnv(env),
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

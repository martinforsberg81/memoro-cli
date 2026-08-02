/**
 * The host runtime probe — mc's positive local evidence about a session
 * host after its inventory disappeared. Part of THE liveness truth: the
 * presence engine composes this probe's verdicts; nothing else re-derives
 * host liveness.
 *
 * Evidence, in fail-closed order: a definitive socket refusal, the
 * hosted-session listing of a reachable host, the recorded pid (with the
 * boot-time proof that a pre-boot pid record cannot name a live broker),
 * and the bound host manifest.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { requestBroker } from '../../runtime/broker/client.js';

const HOST_RUNTIME_PROBE_TIMEOUT_MS = 600;
const BOOT_CLOCK_SLACK_MS = 5_000;

/**
 * Return positive local evidence about a session host after its inventory
 * disappeared. A stale socket alone is not enough: only a definitive socket
 * refusal combined with ESRCH for the recorded broker pid proves that the
 * broker process exited. Permission errors, timeouts, missing pid evidence,
 * and a live/reused pid stay unknown so callers continue to fail closed.
 */
export async function probeSessionHostRuntime(paths, {
  request = requestBroker,
  readFile = readFileSync,
  readManifestFile = readFileSync,
  lstatFile = lstatSync,
  signalProcess = process.kill,
  timeoutMs = HOST_RUNTIME_PROBE_TIMEOUT_MS,
  expectedSessionId = null,
  bootTimeMs = defaultBootTimeMs,
} = {}) {
  if (!paths?.socketPath || !paths?.pidPath) {
    return { verdict: 'unknown', reason: 'host-paths-missing' };
  }

  const firstSocketProbe = await probeHostSocket(paths.socketPath, { request, timeoutMs });
  if (firstSocketProbe.verdict !== 'exited') {
    // A reachable host owns this session's socket namespace exclusively, so
    // its session list is authoritative: report whether the expected session
    // is actually hosted there. A listing failure omits the field so callers
    // keep failing closed.
    if (firstSocketProbe.verdict === 'live'
      && firstSocketProbe.reason === 'host-socket-reachable'
      && expectedSessionId) {
      const hosted = await hostSessionPresence(paths.socketPath, expectedSessionId, {
        request,
        timeoutMs,
      });
      if (hosted !== null) {
        return { ...firstSocketProbe, hosts_expected_session: hosted };
      }
    }
    return firstSocketProbe;
  }

  const pid = readPositivePid(paths.pidPath, { readFile });
  if (pid == null) return { verdict: 'unknown', reason: 'host-pid-unverified' };
  const hostManifest = readBoundHostManifest(paths, {
    expectedSessionId,
    expectedPid: pid,
    readFile: readManifestFile,
    lstat: lstatFile,
  });
  // A pid record written before the current boot cannot name a live broker:
  // no process survives a reboot, so whatever occupies that pid now is an
  // unrelated post-boot process and a bare kill(pid, 0) success is not
  // liveness evidence. Combined with the definitive socket refusal above,
  // a pre-boot record proves the recorded broker exited.
  if (pidRecordPredatesBoot(paths.pidPath, { lstat: lstatFile, bootTimeMs })) {
    const confirmedSocket = await probeHostSocket(paths.socketPath, { request, timeoutMs });
    if (confirmedSocket.verdict === 'exited') {
      return {
        verdict: 'exited',
        reason: 'host-process-pre-boot',
        pid,
        ...(hostManifest ? { host_manifest: hostManifest } : {}),
      };
    }
    return confirmedSocket;
  }
  try {
    signalProcess(pid, 0);
    return {
      verdict: 'live',
      reason: 'host-pid-live',
      pid,
      ...(hostManifest ? { host_manifest: hostManifest } : {}),
    };
  } catch (error) {
    if (error?.code === 'EPERM') {
      return {
        verdict: 'live',
        reason: 'host-pid-live',
        pid,
        ...(hostManifest ? { host_manifest: hostManifest } : {}),
      };
    }
    if (error?.code === 'ESRCH') {
      // A replacement host may bind after the first refusal and before the
      // pid check. Re-probe so a concurrent restart cannot be mistaken for
      // positive exit evidence.
      const confirmedSocket = await probeHostSocket(paths.socketPath, { request, timeoutMs });
      if (confirmedSocket.verdict === 'exited') {
        return {
          verdict: 'exited',
          reason: 'host-process-exited',
          pid,
          ...(hostManifest ? { host_manifest: hostManifest } : {}),
        };
      }
      return confirmedSocket;
    }
    return { verdict: 'unknown', reason: 'host-pid-unverified', pid };
  }
}

/**
 * True only when the pid file provably predates the current boot. Any
 * doubt — missing file, unreadable stat, unavailable uptime, or a
 * timestamp within clock slack of the boot instant — returns false so the
 * caller falls back to the fail-closed pid evidence path.
 */
function pidRecordPredatesBoot(pidPath, { lstat, bootTimeMs } = {}) {
  try {
    const stat = lstat(pidPath);
    if (!stat?.isFile?.() || stat.isSymbolicLink?.()) return false;
    const mtimeMs = stat.mtimeMs;
    const boot = bootTimeMs();
    return Number.isFinite(mtimeMs)
      && Number.isFinite(boot)
      && mtimeMs < boot - BOOT_CLOCK_SLACK_MS;
  } catch {
    return false;
  }
}

async function hostSessionPresence(socketPath, expectedSessionId, {
  request = requestBroker,
  timeoutMs = HOST_RUNTIME_PROBE_TIMEOUT_MS,
} = {}) {
  try {
    const res = await request({ type: 'sessions' }, { socketPath, timeoutMs });
    if (!res?.ok || !Array.isArray(res.sessions)) return null;
    return res.sessions.some((row) => row
      && (row.id === expectedSessionId || row.coding_session_id === expectedSessionId));
  } catch {
    return null;
  }
}

function defaultBootTimeMs() {
  const uptimeSeconds = uptime();
  return Number.isFinite(uptimeSeconds) && uptimeSeconds > 0
    ? Date.now() - uptimeSeconds * 1000
    : NaN;
}

function readBoundHostManifest(paths, {
  expectedSessionId,
  expectedPid,
  readFile,
  lstat,
} = {}) {
  if (!paths?.manifestPath
    || typeof expectedSessionId !== 'string'
    || !expectedSessionId
    || !Number.isSafeInteger(expectedPid)
    || expectedPid <= 0) {
    return null;
  }
  try {
    const stat = lstat(paths.manifestPath);
    if (!stat.isFile?.() || stat.isSymbolicLink?.() || (stat.mode & 0o077) !== 0) {
      return null;
    }
    const raw = readFile(paths.manifestPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 4096) return null;
    const manifest = JSON.parse(raw);
    if (!manifest
      || typeof manifest !== 'object'
      || Array.isArray(manifest)
      || manifest.session_id !== expectedSessionId
      || manifest.socket_path !== paths.socketPath
      || manifest.pid_path !== paths.pidPath
      || manifest.lifecycle_path !== paths.lifecyclePath
      || manifest.broker_pid !== expectedPid
      || !exactIso(manifest.updated_at)) {
      return null;
    }
    return {
      session_id: manifest.session_id,
      broker_pid: manifest.broker_pid,
      updated_at: manifest.updated_at,
    };
  } catch {
    return null;
  }
}


function readPositivePid(path, { readFile = readFileSync } = {}) {
  try {
    const parsed = Number(readFile(path, 'utf8').trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function exactIso(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isDefinitiveSocketExit(error) {
  if (error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED') return true;
  return /\b(?:ENOENT|ECONNREFUSED)\b/.test(error?.message || '');
}

async function probeHostSocket(socketPath, {
  request = requestBroker,
  timeoutMs = HOST_RUNTIME_PROBE_TIMEOUT_MS,
} = {}) {
  try {
    const response = await request(
      { type: 'status' },
      { socketPath, timeoutMs },
    );
    if (response?.ok) return { verdict: 'live', reason: 'host-socket-reachable' };
    return { verdict: 'unknown', reason: 'host-socket-response-unverified' };
  } catch (error) {
    return isDefinitiveSocketExit(error)
      ? { verdict: 'exited', reason: 'host-socket-refused' }
      : { verdict: 'unknown', reason: 'host-socket-unverified' };
  }
}

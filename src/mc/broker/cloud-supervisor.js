import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { brokerCloudLogPath, brokerCloudPidPath } from './paths.js';

export function ensureCloudBrokerConnected({
  pidPath = brokerCloudPidPath(),
  logPath = brokerCloudLogPath(),
  sourceId = null,
  sourceKind = null,
  sourceName = null,
  cloudSessionId = null,
  readFile = readFileSync,
  writeFile = writeFileSync,
  removeFile = rmSync,
  isAlive = isProcessAlive,
  spawnConnector = spawnCloudBrokerConnector,
  stopConnector = stopSpawnedConnector,
  now = () => Date.now(),
  forceRestart = false,
} = {}) {
  const existingPid = readPid(pidPath, { readFile });
  if (existingPid && isAlive(existingPid) && !forceRestart) {
    return { ok: true, alreadyRunning: true, pid: existingPid, pid_path: pidPath, log_path: logPath };
  }
  if (existingPid && isAlive(existingPid) && forceRestart) {
    stopConnector({ pid: existingPid });
  }
  if (existingPid) {
    try { removeFile(pidPath, { force: true }); } catch {}
  }

  const spawned = spawnConnector({ logPath, sourceId, sourceKind, sourceName, cloudSessionId });
  if (!spawned.ok) return spawned;
  try {
    mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 });
    writeFile(pidPath, String(spawned.pid), { mode: 0o600 });
  } catch (err) {
    stopConnector(spawned);
    return { ok: false, error: `cloud connector pid write failed (${err.message || String(err)})` };
  }
  return {
    ok: true,
    started: true,
    ...(forceRestart && existingPid ? { restarted: true, previous_pid: existingPid } : {}),
    pid: spawned.pid,
    pid_path: pidPath,
    log_path: logPath,
    started_at: new Date(now()).toISOString(),
  };
}

export function spawnCloudBrokerConnector({
  logPath = brokerCloudLogPath(),
  mcBin = resolveMcBinPath(),
  sourceId = null,
  sourceKind = null,
  sourceName = null,
  cloudSessionId = null,
} = {}) {
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const out = openSync(logPath, 'a');
    const err = openSync(logPath, 'a');
    const child = spawn(process.execPath, [mcBin, ...brokerConnectArgs({
      sourceId,
      sourceKind,
      sourceName,
      cloudSessionId,
    })], {
      detached: true,
      stdio: ['ignore', out, err],
      cwd: process.cwd(),
      env: process.env,
    });
    child.unref();
    return { ok: true, pid: child.pid, log_path: logPath, stop: () => child.kill('SIGTERM') };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export function defaultMcBinPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin-mc.js');
}

export function resolveMcBinPath(argv = process.argv) {
  return argv[1] || defaultMcBinPath();
}

export function brokerConnectArgs({
  sourceId = null,
  sourceKind = null,
  sourceName = null,
  cloudSessionId = null,
} = {}) {
  const args = ['broker', 'connect'];
  addFlag(args, '--source-id', sourceId);
  addFlag(args, '--source-kind', sourceKind);
  addFlag(args, '--source-name', sourceName);
  addFlag(args, '--cloud-session-id', cloudSessionId);
  return args;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function stopSpawnedConnector(spawned) {
  if (!spawned) return;
  if (typeof spawned.stop === 'function') {
    try { spawned.stop(); } catch {}
    return;
  }
  if (Number.isInteger(spawned.pid) && spawned.pid > 0) {
    try { process.kill(spawned.pid, 'SIGTERM'); } catch {}
  }
}

function readPid(path, { readFile = readFileSync } = {}) {
  try {
    const value = String(readFile(path, 'utf8') || '').trim();
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function addFlag(args, flag, value) {
  if (typeof value === 'string' && value.length > 0) {
    args.push(flag, value);
  }
}

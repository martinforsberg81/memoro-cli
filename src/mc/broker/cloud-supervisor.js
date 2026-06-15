import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { brokerCloudLogPath, brokerCloudPidPath } from './paths.js';

export function ensureCloudBrokerConnected({
  pidPath = brokerCloudPidPath(),
  logPath = brokerCloudLogPath(),
  readFile = readFileSync,
  writeFile = writeFileSync,
  removeFile = rmSync,
  isAlive = isProcessAlive,
  spawnConnector = spawnCloudBrokerConnector,
  stopConnector = stopSpawnedConnector,
  now = () => Date.now(),
} = {}) {
  const existingPid = readPid(pidPath, { readFile });
  if (existingPid && isAlive(existingPid)) {
    return { ok: true, alreadyRunning: true, pid: existingPid, pid_path: pidPath, log_path: logPath };
  }
  if (existingPid) {
    try { removeFile(pidPath, { force: true }); } catch {}
  }

  const spawned = spawnConnector({ logPath });
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
    pid: spawned.pid,
    pid_path: pidPath,
    log_path: logPath,
    started_at: new Date(now()).toISOString(),
  };
}

export function spawnCloudBrokerConnector({
  logPath = brokerCloudLogPath(),
  mcBin = resolveMcBinPath(),
} = {}) {
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const out = openSync(logPath, 'a');
    const err = openSync(logPath, 'a');
    const child = spawn(process.execPath, [mcBin, 'broker', 'connect'], {
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

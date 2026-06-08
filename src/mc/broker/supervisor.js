import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { requestBroker } from './client.js';
import { brokerLogPath } from './paths.js';

export const START_POLL_MS = 1_500;
export const POLL_INTERVAL_MS = 100;

export async function ensureBrokerRunning({
  request = requestBroker,
  spawnDaemon = spawnBrokerDaemon,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = START_POLL_MS,
  intervalMs = POLL_INTERVAL_MS,
  readyFile = null,
} = {}) {
  const existing = await request({ type: 'status' }).catch(() => null);
  if (existing?.ok) return { ok: true, alreadyRunning: true, broker: existing.broker };

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

export function spawnBrokerDaemon({ readyFile = null } = {}) {
  const logPath = brokerLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const out = openSync(logPath, 'a');
    const err = openSync(logPath, 'a');
    const args = [process.execPath, process.argv[1], 'broker', '--daemon'];
    if (readyFile) args.push('--ready-file', readyFile);
    const child = spawn(args[0], args.slice(1), {
      detached: true,
      stdio: ['ignore', out, err],
      cwd: process.cwd(),
      env: process.env,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

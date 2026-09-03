#!/usr/bin/env node
/**
 * The nightly process itself.
 *
 * Started detached by `mc repo nightly start`, never by hand and never by a
 * conversation. Its stdout and stderr are the log file the starter opened, so
 * everything below is written there with a timestamp — including the gate
 * round's own narration, which is minutes of it, and the stack of a tick that
 * threw.
 *
 * SIGTERM and SIGINT mean stop now, and the round in flight is *not* waited
 * for. The watcher finishes its round because a round is a second and cutting
 * one in half would tear a snapshot; a full round is minutes, and this one
 * writes nothing that half a round could corrupt. `repo-gate.js` catches the
 * same signal for itself and gives back the lease and the round lock before it
 * exits, which is why a stop mid-round leaves the machine free rather than
 * held by a process that is gone.
 */
import { readFileSync, rmSync } from 'node:fs';

import { mcHome } from './paths.js';
import { DEFAULT_INTERVAL_MS, nightlyStatePath } from './nightly.js';
import { nightlyLoop } from './nightly-loop.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const intervalMs = flag('--interval-ms', DEFAULT_INTERVAL_MS);
let stopping = false;
const log = (message) => {
  process.stdout.write(`${new Date().toISOString()}  ${message}\n`);
};

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — stopping`);
  });
}

log(`a full run of every repository every ${hours(intervalMs)} (pid ${process.pid})`);
await nightlyLoop({ intervalMs, shouldStop: () => stopping, log });
log('stopped');

// The pid file is this process's own claim; leaving it behind would tell the
// next reader a nightly is happening when none is.
try {
  const path = nightlyStatePath(mcHome());
  const { pid } = JSON.parse(readFileSync(path, 'utf8'));
  if (Number(pid) === process.pid) rmSync(path, { force: true });
} catch { /* stopped by something that already removed it */ }

function hours(ms) {
  const value = Math.round((ms / 3_600_000) * 10) / 10;
  return value >= 1 ? `${value}h` : `${Math.round(ms / 1000)}s`;
}

#!/usr/bin/env node
/**
 * The watcher process itself.
 *
 * Started detached by `mc repo watch start`, never by hand and never by a
 * conversation. Its stdout and stderr are the log file the starter opened, so
 * everything below is written there with a timestamp — including the stack of
 * a round that threw, which is the one thing a background process must never
 * swallow.
 *
 * It stops on SIGTERM and SIGINT by letting the round in flight finish. That
 * is what makes `mc repo watch stop` safe to run at any moment: the snapshot
 * on disk is always one whole round or the one before it.
 *
 * When its checkout's HEAD has moved past the commit it started on, it leaves
 * after the refresh in flight and starts its successor, which runs the same
 * script in the same checkout and so the new code.
 */
import { readFileSync, rmSync } from 'node:fs';

import { mcHome } from './paths.js';
import { DEFAULT_INTERVAL_MS, watcherStatePath } from './repo-snapshot.js';
import { watchLoop } from './repo-watch-loop.js';
import { checkoutHead, startWatcher } from './repo-watch.js';

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
    log(`${signal} — finishing the round in flight, then leaving`);
  });
}

/** Short shas of two lengths name one commit when one starts the other. */
const sameCommit = (a, b) => a.startsWith(b) || b.startsWith(a);

const started = checkoutHead();
let movedTo = null;
const afterRound = () => {
  const now = checkoutHead();
  if (!started || !now || sameCommit(now, started)) return false;
  movedTo = now;
  return true;
};

log(`watching every ${Math.round(intervalMs / 1000)}s (pid ${process.pid})`);
await watchLoop({ intervalMs, shouldStop: () => stopping, log, afterRound });
log('stopped');
release();

// After the release: `startWatcher` refuses while the pid file names a live
// watcher, and this one is still alive.
if (movedTo && !stopping) {
  log(`code moved ${started} → ${movedTo} — left after this refresh; the next start watches on the new code`);
  const next = startWatcher({ intervalMs });
  log(next.ok ? `successor pid ${next.pid}` : `no successor started (${next.reason})`);
}

/**
 * The pid file is this process's own claim; leaving it behind would tell the
 * next reader a watcher is running when none is.
 */
function release() {
  try {
    const path = watcherStatePath(mcHome());
    const { pid } = JSON.parse(readFileSync(path, 'utf8'));
    if (Number(pid) === process.pid) rmSync(path, { force: true });
  } catch { /* stopped by something that already removed it */ }
}

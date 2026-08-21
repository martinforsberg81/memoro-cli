#!/usr/bin/env node
/**
 * The round's process.
 *
 * Started detached by `mc watch pm start`, never by hand and never by a
 * conversation. Its stdout and stderr are the log file the starter opened, so
 * everything below is written there with a timestamp — including the stack of
 * a pass that threw, which is the one thing a background process must never
 * swallow.
 *
 * It stops on SIGTERM and SIGINT by letting the pass in flight finish. That
 * is what makes `mc watch pm stop` safe to run at any moment: a commit is
 * either made or not made, and a message is either in PM's inbox or not.
 */
import { mcHome } from './paths.js';
import { clearOwnState } from './watch-daemon.js';
import { pmWatchLoop } from './watch-pm-loop.js';
import { DEFAULT_INTERVAL_MS } from './watch-pm-round.js';
import { TARGET } from './watch-pm.js';

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
    log(`${signal} — finishing the pass in flight, then leaving`);
  });
}

log(`watching pm every ${Math.round(intervalMs / 1000)}s (pid ${process.pid})`);
await pmWatchLoop({ intervalMs, shouldStop: () => stopping, log });
log('stopped');

clearOwnState(TARGET, mcHome());

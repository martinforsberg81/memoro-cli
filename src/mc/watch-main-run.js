#!/usr/bin/env node
/**
 * The main-watch process itself.
 *
 * Started detached by `mc watch main start` through the shared daemon
 * (watch-daemon.js), never by hand. Its stdout and stderr are the log the
 * starter opened. It stops on SIGTERM/SIGINT by letting the pass in flight
 * finish, and restarts itself on code that moved under it — the same
 * behaviour as the other two legs.
 */
import { fileURLToPath } from 'node:url';

import { clearOwnState, codeDrift, restartDaemon } from './watch-daemon.js';
import { resolveRepository } from './work-area.js';
import { DEFAULT_INTERVAL_MS, mainWatchLoop } from './watch-main-loop.js';
import { TARGET } from './watch-main.js';

const argv = process.argv.slice(2);
const number = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const word = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
};

const intervalMs = number('--interval-ms', DEFAULT_INTERVAL_MS);
const repoName = word('--repo', null);
const runner = fileURLToPath(import.meta.url);
let stopping = false;
let restarting = false;
const drifted = codeDrift(runner);
const log = (message) => { process.stdout.write(`${new Date().toISOString()}  ${message}\n`); };

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — finishing the pass in flight, then leaving`);
  });
}

const resolved = repoName ? resolveRepository(repoName) : null;
const repoPath = resolved?.path || null;
if (!repoPath) {
  log(`no repository called "${repoName}" — nothing to watch; stopped`);
  clearOwnState(TARGET);
  process.exit(0);
}

log(`watching ${repoName} (${repoPath}) every ${Math.round(intervalMs / 1000)}s (pid ${process.pid})`);
await mainWatchLoop({
  repoPath,
  intervalMs,
  shouldStop: () => {
    if (!stopping && !restarting && drifted()) {
      restarting = true;
      log('mc changed on disk since this watch started — finishing the pass in flight, then restarting on the new code');
    }
    return stopping || restarting;
  },
  log,
});

if (restarting && !stopping) {
  const next = restartDaemon({ target: TARGET, runner, args: argv, intervalMs });
  log(next.ok ? `restarted as pid ${next.pid}` : `could not restart: ${next.reason} — stopped`);
} else {
  log('stopped');
}
clearOwnState(TARGET);

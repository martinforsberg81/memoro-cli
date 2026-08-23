#!/usr/bin/env node
/**
 * The guard process itself.
 *
 * Started detached by `mc watch sessions start` through the shared daemon
 * (`watch-daemon.js`), never by hand and never by a conversation. Its stdout and stderr are the log file the starter opened, so
 * everything below is written there with a timestamp — including the stack of
 * a round that threw, which is the one thing a background process must never
 * swallow.
 *
 * It stops on SIGTERM and SIGINT by letting the round in flight finish, which
 * is what makes `mc watch sessions stop` safe to run at any moment.
 */
import { fileURLToPath } from 'node:url';

import { clearOwnState, codeDrift, restartDaemon } from './watch-daemon.js';
import { DEFAULT_INTERVAL_MS } from './watch-sessions-store.js';
import { DEFAULT_IDLE_MS } from './watch-sessions-scan.js';
import { excerptOf, readOutput } from './watch-sessions-read.js';
import { readTailEntries } from './conversations.js';
import { watchLoop } from './watch-sessions-loop.js';
import { TARGET } from './watch-sessions.js';

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
const model = word('--model', null);
const idleMs = number('--idle-ms', DEFAULT_IDLE_MS);
// `--group a --group b`: every occurrence, in order.
const groups = argv.flatMap((item, index) => (item === '--group' && argv[index + 1] ? [argv[index + 1]] : []));
const runner = fileURLToPath(import.meta.url);
let stopping = false;
// See watch-pm-run.js: code that moved on disk ends this process between
// rounds and a successor picks up on what is there now.
let restarting = false;
const drifted = codeDrift(runner);
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

log(`watching every ${Math.round(intervalMs / 1000)}s${model ? ` on ${model}` : ''} (pid ${process.pid})`
  + ` — unattended after ${Math.round(idleMs / 60_000)}m${groups.length ? `, groups ${groups.map((g) => `${g}*`).join(' ')}` : ''}`);
await watchLoop({
  intervalMs,
  idleMs,
  groups,
  shouldStop: () => {
    if (!stopping && !restarting && drifted()) {
      restarting = true;
      log('mc changed on disk since this guard started — finishing the round in flight, then restarting on the new code');
    }
    return stopping || restarting;
  },
  log,
  // The model is pinned here rather than inside the round, so the round stays
  // a function a test can call with a model that costs nothing.
  read: model
    ? (session) => readOutput(excerptOf(readTailEntries(session.path)), { model })
    : null,
});
if (restarting && !stopping) {
  const next = restartDaemon({ target: TARGET, runner, args: argv, intervalMs });
  log(next.ok ? `restarted as pid ${next.pid}` : `could not restart: ${next.reason} — stopped`);
} else {
  log('stopped');
}

// The pid file is this process's own claim; leaving it behind would tell the
// next reader a guard is running when none is. The shared daemon clears it,
// and only ever its own — so after a restart it stays, naming the successor.
clearOwnState(TARGET);

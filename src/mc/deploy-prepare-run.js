#!/usr/bin/env node
/**
 * The deploy's preparation process itself (`prepare` in `deploy-prepare.js`).
 *
 * Started detached by `mc deploy`, never by hand. Its one argument is the job
 * as JSON; its stdout and stderr are its own log (`deploy-prepare-<started>.log`,
 * named in its record), which the terminals and the page that ask read as it
 * grows. Losing a terminal does not reach it: it has a process group of its own
 * and no terminal to lose.
 *
 * SIGTERM and SIGHUP stop it: `mc deploy --stop-preparation` has written the
 * stop into the record and then sends SIGTERM. The handler aborts the round's
 * signal, which ends the full run's suite and command groups as the repository
 * ceiling does. A stage that reads no signal (the suites against a local
 * server) is cut after `STOP_GRACE_MS`: the process group is told SIGTERM and
 * the process exits.
 */
import { prepare } from './deploy-prepare.js';

const STOP_GRACE_MS = 30_000;

const job = JSON.parse(process.argv[2] || '{}');
const stop = new AbortController();
let stopping = false;
const onStop = (name) => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`mc: ${name} — stopping the preparation\n`);
  stop.abort(new Error(`the preparation was stopped (${name})`));
  const cut = setTimeout(() => {
    try { process.kill(-process.pid, 'SIGTERM'); } catch { /* not a group leader */ }
    process.exit(143);
  }, STOP_GRACE_MS);
  cut.unref();
};
process.on('SIGTERM', () => onStop('SIGTERM'));
process.on('SIGHUP', () => onStop('SIGHUP'));

const code = await prepare(job, { stdout: process.stdout, env: process.env, signal: stop.signal });
process.exit(typeof code === 'number' ? code : 1);

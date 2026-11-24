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
 * ceiling does, or unwinds the local suites through server and holder cleanup.
 * The stop command owns the deadline and any last-resort signalling.
 */
import { prepare } from './deploy-prepare.js';

const job = JSON.parse(process.argv[2] || '{}');
const stop = new AbortController();
let stopping = false;
const onStop = (name) => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`mc: ${name} — stopping the preparation\n`);
  stop.abort(new Error(`the preparation was stopped (${name})`));
};
process.on('SIGTERM', () => onStop('SIGTERM'));
process.on('SIGHUP', () => onStop('SIGHUP'));

const code = await prepare(job, { stdout: process.stdout, env: process.env, signal: stop.signal });
process.exit(typeof code === 'number' ? code : 1);

#!/usr/bin/env node
/**
 * The merger process itself (`merger.js`).
 *
 * Started detached by `mc merge` or the runner when there is a job and no
 * merger, never by hand. Its stdout and stderr are `merger.log`, so every line
 * below goes there with a timestamp — including the stack of a round that
 * threw.
 *
 * SIGTERM and SIGINT let the jobs in flight finish and then leave; what is
 * still queued waits for the next start, and no successor is started. A
 * checkout that moves past the commit this merger started on releases
 * merger.json and starts its successor on the new code at once, while jobs
 * remain: this merger then finishes only the rounds and mends it holds, and the
 * successor takes every other job (`held` in merge-queue.js). The handler only sets `stopping`:
 * the rounds run with `signals: false`, so nothing else in this process exits
 * on a signal, and every child process is started without holding the event
 * loop (child-async.js), so the signal is seen when it comes.
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runTool } from './child-async.js';
import { runAsync as runGitAsync } from './git.js';
import { mayMend, runMend } from './mend.js';
import { landerFor, runsAppender, serve, succeed } from './merger.js';
import { workRoot } from './paths.js';

const argv = process.argv.slice(2);
const at = argv.indexOf('--root');
const root = at >= 0 && argv[at + 1] ? argv[at + 1] : workRoot(process.env);

let stopping = false;
const say = (message) => { process.stdout.write(`${new Date().toISOString()}  ${message}\n`); };

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    say(`${signal} — finishing the jobs in flight, then leaving`);
  });
}

const gh = (args, options = {}) => runTool('gh', args, { cwd: options.cwd });

// The checkout this script runs from and its commit: the first line of the
// log says which code serves the queue, and `serve` asks again before each
// batch whether the checkout has moved past it.
const checkout = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/u, '');
const headNow = async () => {
  const r = await runGitAsync(undefined, ['-C', checkout, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 5000 });
  return r.status === 0 ? String(r.stdout).trim() || null : null;
};
const commit = (await headNow()) || 'unknown';
let movedTo = null;
const home = homedir();
const shown = home && (checkout === home || checkout.startsWith(`${home}/`)) ? `~${checkout.slice(home.length)}` : checkout;
const appendRun = runsAppender(root, { append: (path, text) => appendFileSync(path, text) });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const code = await serve({
  root,
  say,
  version: { checkout: shown, commit },
  stopping: () => stopping,
  head: headNow,
  onMoved: (from, to) => { movedTo = to; },
  // Told once when the checkout moved, after merger.json is released. A stop
  // that came in since starts none: SIGTERM means stop.
  handover: () => { if (!stopping) succeed({ root, movedTo, say }); },
  gh,
  appendRun,
  // A red the change caused gets one mend session first (ruling 37).
  land: landerFor({ root, say, sleep, gh, appendRun, mayMend }),
  mend: (job, report, { onPid }) => runMend({ root, job, report, deps: { onPid } }),
});
process.exit(code);

#!/usr/bin/env node
/**
 * The merger process itself (`merger.js`).
 *
 * Started detached by `mc merge` or the runner when there is a job and no
 * merger, never by hand. Its stdout and stderr are `merger.log`, so every line
 * below goes there with a timestamp — including the stack of a round that
 * threw.
 *
 * SIGTERM and SIGINT let the job in flight finish and then leave; what is
 * still queued waits for the next start.
 */
import { appendFileSync } from 'node:fs';

import { landJob, runsAppender, serve } from './merger.js';
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
    say(`${signal} — finishing the job in flight, then leaving`);
  });
}

const { spawnSync } = await import('node:child_process');
const gh = (args, options = {}) => spawnSync('gh', args, { cwd: options.cwd, encoding: 'utf8' });
const appendRun = runsAppender(root, { append: (path, text) => appendFileSync(path, text) });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const code = await serve({
  root,
  say,
  stopping: () => stopping,
  land: (batch) => landJob(batch, { root, say, sleep, gh, appendRun }),
});
process.exit(code);

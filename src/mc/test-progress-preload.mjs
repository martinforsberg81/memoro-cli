/**
 * A whole-suite run's heartbeat, one line per test file's process
 * (`processProgress`, `test-times.js`).
 *
 * Loaded through `NODE_OPTIONS=--import` by `realSuite` (`repo-gate.js`), so it
 * reaches every node process the suite command starts. It writes only in a
 * test file's own process: node's runner starts each file with
 * `NODE_TEST_CONTEXT` set, the file as `argv[1]` and `--test-isolation` among
 * its options. A process that a test spawns inherits the context and has no
 * such option, so it writes nothing (unless its script is itself a
 * `*.test.*` file). The suite's own runner, npm and memoro's
 * `scripts/testing/run.mjs` have no context, so they write nothing either.
 *
 * Why the reporter is not enough (2026-11-13): node reports a run's files in
 * the order it was given them, and holds back every later file's events until
 * the earlier ones have reported. A slow or hung file therefore hides all the
 * files that finished behind it, and is itself invisible until one of its
 * tests ends. The round's stall watchdog read only that reporter, and called
 * healthy full runs stalled. This line is written when the file's process
 * starts and when it exits, whatever the reporter is waiting for. memoro's
 * runner strips inherited reporter flags from `NODE_OPTIONS` but keeps
 * `--import`, so this also reaches the suite of a repository whose reporter
 * mc cannot see at all.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.env.MC_TEST_PROGRESS;
const file = process.argv[1];
const testFile = Boolean(target && file && String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')
  && (process.execArgv.some((arg) => arg.startsWith('--test-isolation')) || /\.test\.[cm]?[jt]sx?$/u.test(file)));

if (testFile) {
  const path = resolve(file);
  const write = (entry) => {
    try { appendFileSync(target, `${JSON.stringify({ file: path, pid: process.pid, ...entry })}\n`); } catch { /* a heartbeat never fails a test */ }
  };
  write({ process: 'started' });
  process.once('exit', (code) => write({ process: 'exited', code }));
}

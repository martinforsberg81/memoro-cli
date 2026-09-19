/**
 * Where the nightly keeps its files.
 *
 * `mc test <repo> --full` is the reading that is about the code rather than
 * about a change, and until it was taken on a schedule it happened when a
 * person typed it. That is the direct cause of memoro's #10529: four days of
 * merges left 31 tests red on `main` while every pull request's
 * affected-selection passed, because nothing ever looked at the whole.
 *
 * The schedule is a chore of the runner now (`runNightly` in `run.js`, due when
 * a day has passed since the last tick — `nightlyDue` in `run-plan.js`), and
 * this file is what is left of the process that used to carry it: the
 * directory under mc's home and the log in it. Nothing here starts, stops or
 * looks for a process, and nothing writes a pid file.
 *
 * It is a meter, like the repository watcher: it never commits, never pushes,
 * never writes inside a repository, and never takes a branch, and nothing it
 * finds refuses a merge or delays a round.
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome } from './paths.js';

/** A log this size has said everything useful twice. */
const LOG_LIMIT_BYTES = 1024 * 1024;

export function nightlyRoot(root = mcHome()) {
  return join(root, 'nightly');
}

export function nightlyLogPath(root = mcHome()) {
  return join(nightlyRoot(root), 'nightly.log');
}

/**
 * One line onto the log, the log truncated first when it has grown past a
 * megabyte.
 *
 * The log is how the twelve-day outage of September 2026 was diagnosed at all,
 * so it is where everything a tick narrates goes — the gate round's own
 * progress, minutes of it, included — while the runner's output gets only the
 * per-repository summaries. Truncated rather than rotated: the history files
 * beside it are the durable record, and this is for a person reading what
 * happened last night.
 */
export function appendNightlyLog(text, { root = mcHome() } = {}) {
  const log = nightlyLogPath(root);
  mkdirSync(nightlyRoot(root), { recursive: true, mode: 0o700 });
  try {
    if (statSync(log).size > LOG_LIMIT_BYTES) truncateSync(log, 0);
  } catch { /* no log yet */ }
  appendFileSync(log, text, { mode: 0o600 });
}

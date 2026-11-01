/**
 * What each test file cost when it last ran, per repository: measured by every
 * run, never declared. A declared cost goes stale in silence; memoro-cli's
 * "light" stood for 60 s long after its suite took seventeen minutes.
 *
 * A session's gate reads it to leave the costly files to the merge round
 * (`sessionFiles`), so nobody waits for them and the machine stays free. The
 * merge round runs them all unless its repository declares `round_seconds`;
 * a deferred file is unmeasured, never green.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeJsonAtomic } from './atomic-write.js';

/** The estimated seconds a session's gate spends on the files it may leave. */
export const SESSION_GATE_SECONDS = 180;
/** What a file nobody has measured is assumed to cost. */
export const UNMEASURED_SECONDS = 5;
/** New measurements count this much: one run on a loaded machine does not rewrite the table. */
const WEIGHT = 0.5;

export const TIMES_REPORTER = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'test-times-reporter.mjs')).href;

export function testTimesPath(root, repo) {
  return join(root, 'test-times', `${repo}.json`);
}

export function readTestTimes({ root, repo }) {
  try {
    const parsed = JSON.parse(readFileSync(testTimesPath(root, repo), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Seconds per repository-relative file, from the reporter's lines. A line that will not parse is skipped. */
export function measuredSeconds(text, cwd) {
  const seconds = {};
  for (const line of String(text || '').split('\n')) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.file !== 'string' || !(entry.ms >= 0)) continue;
    const file = relative(cwd, entry.file);
    seconds[file] = (seconds[file] || 0) + entry.ms / 1000;
  }
  return seconds;
}

/** A courtesy: a table that cannot be written costs the next gate its estimate, never this run its verdict. */
export function recordTestTimes({ root, repo, cwd, text }) {
  try {
    const measured = measuredSeconds(text, cwd);
    if (!Object.keys(measured).length) return false;
    const table = readTestTimes({ root, repo });
    for (const [file, seconds] of Object.entries(measured)) {
      const known = Number(table[file]);
      table[file] = Math.round((known > 0 ? known * (1 - WEIGHT) + seconds * WEIGHT : seconds) * 10) / 10;
    }
    mkdirSync(dirname(testTimesPath(root, repo)), { recursive: true });
    writeJsonAtomic(testTimesPath(root, repo), table, { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * What a session's gate runs now and what it leaves to the merge round. The
 * files in `keep` (the tests this change touches) always run; the others run
 * cheapest first while the estimate fits. There is always at least one file:
 * a gate that measures nothing says nothing.
 */
export function sessionFiles(files, { times = {}, keep = [], lanes = 2, seconds = SESSION_GATE_SECONDS } = {}) {
  const cost = (file) => (Number(times[file]) > 0 ? Number(times[file]) : UNMEASURED_SECONDS) / Math.max(1, lanes);
  const kept = new Set(keep);
  const run = files.filter((file) => kept.has(file));
  const deferred = [];
  let spent = run.reduce((sum, file) => sum + cost(file), 0);
  const rest = files.filter((file) => !kept.has(file)).sort((a, b) => cost(a) - cost(b) || a.localeCompare(b));
  for (const file of rest) {
    if (run.length && spent + cost(file) > seconds) { deferred.push(file); continue; }
    run.push(file);
    spent += cost(file);
  }
  return { run, deferred };
}

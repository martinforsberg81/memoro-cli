/**
 * What each test file cost when it last ran, per repository: measured by every
 * run, never declared. A declared cost goes stale in silence; memoro-cli's
 * "light" stood for 60 s long after its suite took seventeen minutes.
 *
 * A session's ordinary gate reads it to defer costly selected files
 * (`sessionFiles`), so nobody waits for them and the machine stays free. A
 * deferred file is unmeasured, never green; direct goal landing does not
 * guarantee another gate. A repository that declares `session_whole` defers nothing.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeFileAtomic, writeJsonAtomic } from './atomic-write.js';

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

/** Seconds per repository-relative file, from the reporter's lines. A line that will not parse is skipped, and so is a test's own line (`testsMeasured`). */
export function measuredSeconds(text, cwd) {
  const seconds = {};
  for (const line of String(text || '').split('\n')) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.file !== 'string' || !(entry.ms >= 0) || entry.test) continue;
    const file = relative(cwd, entry.file);
    seconds[file] = (seconds[file] || 0) + entry.ms / 1000;
  }
  return seconds;
}

/**
 * Every test the reporter named, at any nesting: `{ file, name, line, seconds,
 * failed, timeout }`, the file repository-relative, `seconds` null when node
 * gave no time, and `timeout` the limit in ms a test was cut at (null for a
 * test that ended by itself). A line that will not parse, or that names no
 * test line, is skipped.
 */
export function testsMeasured(text, cwd) {
  const tests = [];
  for (const line of String(text || '').split('\n')) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    const test = entry?.test;
    if (typeof entry?.file !== 'string' || !test || typeof test.name !== 'string' || !(test.line > 0)) continue;
    tests.push({
      file: relative(cwd, entry.file),
      name: test.name,
      line: Number(test.line),
      seconds: test.ms >= 0 ? test.ms / 1000 : null,
      failed: test.failed === true,
      timeout: test.timeout > 0 ? Number(test.timeout) : null,
    });
  }
  return tests;
}

/** Where the tests that reached their time limit are kept: `<work root>/runner/too-slow/<repo>.tsv`. */
export function tooSlowPath(root, repo) {
  return join(root, 'runner', 'too-slow', `${repo}.tsv`);
}

const TOO_SLOW_COLUMNS = ['file', 'test', 'first_seen', 'last_seen', 'where', 'limit_ms'];

/** The rows of a repository's too-slow file, `{ file, name, first_seen, last_seen, where, limit_ms }`; none when there is no file. */
export function readTooSlow({ root, repo }) {
  let text = '';
  try { text = readFileSync(tooSlowPath(root, repo), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    const cells = line.split('\t');
    if (cells.length < TOO_SLOW_COLUMNS.length || cells[0] === TOO_SLOW_COLUMNS[0]) continue;
    rows.push({ file: cells[0], name: cells[1], first_seen: cells[2], last_seen: cells[3], where: cells[4], limit_ms: Number(cells[5]) > 0 ? Number(cells[5]) : null });
  }
  return rows;
}

/**
 * The tests of a round that node cut at their time limit, kept in the
 * repository's too-slow file until they pass under it (Martin, 2026-11-03: a
 * test over the limit is red and is rebuilt, not rerun). `tests` is what
 * `testsMeasured` read off the round; `where` names it, the pull request or
 * `gate`. One row per test: a test already there keeps its `first_seen` and
 * gets this round's `last_seen`, `where` and limit; a test that passed under
 * its row's limit this round is removed. The file is written whole or not at
 * all, and only when a row changed. A courtesy like `recordTestTimes`: a file
 * that cannot be written costs the record, never the round its verdict. Returns
 * the rows now in the file, or null when nothing was written.
 */
export function recordTooSlow({ root, repo, where = 'gate', tests = [], now = new Date() }) {
  try {
    const slow = tests.filter((test) => test.timeout > 0);
    const passed = new Map(tests.filter((test) => !test.failed && test.seconds !== null).map((test) => [keyOf(test), test.seconds * 1000]));
    const before = readTooSlow({ root, repo });
    const rows = before.filter((row) => {
      const ms = passed.get(keyOf(row));
      return ms === undefined || (row.limit_ms !== null && ms >= row.limit_ms);
    });
    const stamp = now.toISOString();
    for (const test of slow) {
      const row = rows.find((one) => keyOf(one) === keyOf(test));
      if (row) Object.assign(row, { last_seen: stamp, where, limit_ms: test.timeout });
      else rows.push({ file: test.file, name: test.name, first_seen: stamp, last_seen: stamp, where, limit_ms: test.timeout });
    }
    if (!slow.length && rows.length === before.length) return null;
    rows.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
    const cell = (value) => String(value ?? '').replace(/[\t\n\r]+/gu, ' ');
    const text = [TOO_SLOW_COLUMNS, ...rows.map((row) => [row.file, row.name, row.first_seen, row.last_seen, row.where, row.limit_ms])]
      .map((cells) => cells.map(cell).join('\t')).join('\n');
    writeFileAtomic(tooSlowPath(root, repo), `${text}\n`, { mode: 0o600 });
    return rows;
  } catch { return null; }
}

const keyOf = (test) => `${test.file}\u0000${test.name}`;

/**
 * The new-side line ranges a diff with no context adds or changes: each
 * `@@ -a,b +c,d @@` hunk gives `[c, c+d-1]`. A hunk that only deletes lines
 * (`d` is 0) marks the line it lands on and the one after, so a test the
 * deletion is in still counts.
 */
export function changedRanges(diff) {
  const ranges = [];
  for (const line of String(diff || '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    ranges.push(count > 0 ? [start, start + count - 1] : [Math.max(1, start), Math.max(1, start) + 1]);
  }
  return ranges;
}

/**
 * The tests a change touches, of the tests `testsMeasured` named. `timed` maps
 * each repository-relative test file the change adds or changes to its changed
 * ranges (`changedRanges`), or to null for a file the change adds whole. A test
 * is touched when a changed line falls from its own line to the line before the
 * next test's in the same file, so a test whose body the change edits counts and
 * its neighbour's does not. A file not in `timed` contributes nothing.
 */
export function touchedTests(tests, timed = {}) {
  const byFile = new Map();
  for (const test of tests) {
    if (!Object.hasOwn(timed, test.file)) continue;
    byFile.set(test.file, [...(byFile.get(test.file) || []), test]);
  }
  const touched = [];
  for (const [file, list] of byFile) {
    const ranges = timed[file];
    const ordered = list.sort((a, b) => a.line - b.line);
    ordered.forEach((test, i) => {
      const end = i + 1 < ordered.length ? ordered[i + 1].line - 1 : Infinity;
      const hit = ranges === null || ranges.some(([from, to]) => from <= end && to >= test.line);
      if (hit && test.seconds !== null) touched.push(test);
    });
  }
  return touched;
}

/**
 * What the runs wrote so far, read from their times files while they are still
 * going (a run that hangs never writes its last line, so it cannot be read after
 * it ends). `unfinished` is every file with a top-level test that started and has
 * not ended; `finished` is every file whose top-level tests all ended, with the
 * seconds they took, slowest first. Both are absolute paths, as node reports them.
 * A file that was never started is in neither: the caller knows which it was asked for.
 */
export function runProgress(paths) {
  const started = new Map();
  const ended = new Map();
  const seconds = new Map();
  const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
  for (const path of paths || []) {
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      let entry = null;
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry?.file !== 'string') continue;
      if (entry.started) bump(started, entry.file);
      else if (entry.done) {
        bump(ended, entry.file);
        if (entry.ms >= 0) bump(seconds, entry.file, entry.ms / 1000);
      }
    }
  }
  const unfinished = [...started.keys()].filter((file) => (ended.get(file) || 0) < started.get(file));
  const done = new Set(unfinished);
  const finished = [...ended.keys()].filter((file) => !done.has(file))
    .map((file) => ({ file, seconds: Math.round((seconds.get(file) || 0) * 10) / 10 }))
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
  return { unfinished: unfinished.sort(), finished };
}

/**
 * What the reporter's per-test lines say of each file, beside `runProgress`:
 * `failed` is every file with a test that failed, was cancelled or reached its
 * time limit (the reporter marks all three `failed`), and `tests` every test it
 * named, `{ file, name, line, seconds }`, the file absolute as node reports it.
 * `ended` is every file whose run node summed up with no failed or cancelled
 * test (the reporter's `ended` line); one it summed up otherwise is `failed`.
 * A resumed gate reuses only a file that ended, that `runProgress` finished and
 * that never failed.
 */
export function runOutcomes(paths) {
  const failed = new Set();
  const ended = new Set();
  const tests = [];
  for (const path of paths || []) {
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      let entry = null;
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry?.file === 'string' && entry.ended === true) {
        (entry.ok === true ? ended : failed).add(entry.file);
        continue;
      }
      const test = entry?.test;
      if (typeof entry?.file !== 'string' || !test || typeof test.name !== 'string') continue;
      if (test.failed === true || test.timeout > 0) failed.add(entry.file);
      if (test.line > 0) tests.push({ file: entry.file, name: test.name, line: Number(test.line), seconds: test.ms >= 0 ? test.ms / 1000 : null });
    }
  }
  return { failed: [...failed].sort(), ended: [...ended].filter((file) => !failed.has(file)).sort(), tests };
}

/**
 * Each asked file's outcome in one run, as it was asked for (matched by tail, as
 * `outputCut` matches): `passed` when its top-level tests all ended, node summed
 * the file up as ended (`runOutcomes`) and none of its tests failed; `failed`;
 * `unfinished` when a test or the file itself never ended; and `not-started`
 * when the reporter named none of it.
 */
export function fileOutcomes(files, { progress, outcomes }) {
  const asked = [...new Set((files || []).map(String).filter(Boolean))];
  const name = (path) => asked.find((file) => path === file || path.endsWith(`/${file}`)) || null;
  const unfinished = new Set((progress?.unfinished || []).map(name));
  const finished = new Map((progress?.finished || []).map((one) => [name(one.file), one.seconds]));
  const failed = new Set((outcomes?.failed || []).map(name));
  const ended = new Set((outcomes?.ended || []).map(name));
  const tests = new Map();
  for (const test of outcomes?.tests || []) {
    const file = name(test.file);
    if (file) tests.set(file, [...(tests.get(file) || []), { ...test, file }]);
  }
  return asked.map((file) => ({
    file,
    outcome: unfinished.has(file) ? 'unfinished' : failed.has(file) ? 'failed' : !finished.has(file) ? 'not-started'
      : ended.has(file) ? 'passed' : 'unfinished',
    seconds: finished.get(file) ?? null,
    tests: tests.get(file) || [],
  }));
}

/** Keep compact snapshots before reporter files are deleted at batch completion.
 * A timeout in a later batch or command must not forget the earlier evidence. */
export function progressTracker() {
  const active = new Set();
  const completed = [];
  const outcomes = [];
  return {
    track: (file) => active.add(file),
    complete: (file) => {
      if (!active.delete(file)) return;
      completed.push(runProgress([file]));
      outcomes.push(runOutcomes([file]));
    },
    /** The failed files and named tests of every run, completed or still going (`runOutcomes`). */
    outcomes: () => {
      const all = [...outcomes, runOutcomes(active)];
      const failed = new Set(all.flatMap((one) => one.failed));
      return { failed: [...failed].sort(), ended: [...new Set(all.flatMap((one) => one.ended))].filter((file) => !failed.has(file)).sort(),
        tests: all.flatMap((one) => one.tests) };
    },
    read: () => {
      const snapshots = [...completed, runProgress(active)];
      const unfinished = new Set(snapshots.flatMap((one) => one.unfinished));
      const seconds = new Map();
      for (const one of snapshots.flatMap((snapshot) => snapshot.finished)) {
        seconds.set(one.file, (seconds.get(one.file) || 0) + one.seconds);
      }
      return {
        unfinished: [...unfinished].sort(),
        finished: [...seconds].filter(([file]) => !unfinished.has(file))
          .map(([file, seconds]) => ({ file, seconds: Math.round(seconds * 10) / 10 }))
          .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file)),
      };
    },
  };
}

/**
 * The requested files a run did not finish, as they were asked for: a file no
 * test of it ever started, and a file with a top-level test that started and
 * never ended. `progress` is what the run's tracker read (`runProgress`). A run
 * that exits 0 and prints its summary can still have been cut short — its exit
 * code and its totals say nothing about a file whose tests never ended. Matched
 * by tail, as `redFiles` matches: node reports the real path of a file, and a
 * worktree may be reached through a link.
 */
export function outputCut(files, { progress }) {
  const asked = [...new Set((files || []).map(String).filter(Boolean))];
  const name = (path) => asked.find((file) => path === file || path.endsWith(`/${file}`)) || path;
  const unfinished = new Set((progress?.unfinished || []).map(name));
  const finished = new Set((progress?.finished || []).map((one) => name(one.file)));
  const cut = asked.filter((file) => unfinished.has(file) || !finished.has(file));
  return [...cut, ...[...unfinished].filter((file) => !asked.includes(file))];
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

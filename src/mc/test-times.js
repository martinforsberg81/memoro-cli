/**
 * An estimate of what each test file cost when it last ran, per repository: the
 * sum of its top-level test durations, measured by every run, never declared. It
 * excludes import and process startup. A declared cost goes stale in silence; memoro-cli's
 * "light" stood for 60 s long after its suite took seventeen minutes.
 *
 * A session's ordinary gate reads it to defer costly selected files
 * (`sessionFiles`), so nobody waits for them and the machine stays free. A
 * deferred file is unmeasured, never green, until the merge round or
 * `mc gate --whole-selection` measures it. A repository that declares `session_whole` defers nothing.
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

/**
 * The slow-test indicator (Martin, 2026-11-07): a test that passed in more than
 * this is named as slow, so the tests that slow or stall a gate are found. It is
 * an indicator, never red: the hard limit is the stall guard, the run's own
 * `--test-timeout`, and only a test cut at that is red. Not configurable per
 * repository.
 */
export const SLOW_TEST_MS = 1000;
/** How many slow tests a verdict names before it counts the rest. */
export const SLOW_LINES = 20;

/** A test that passed, measured over `SLOW_TEST_MS`, and was not cut. */
const isSlow = (test) => !test.failed && !(test.timeout > 0) && test.seconds !== null && test.seconds * 1000 > SLOW_TEST_MS;

/**
 * The passed tests over the indicator, `{ file, name, seconds }`, slowest first,
 * one per file and name (the slowest time of a test measured twice). `tests` is
 * what `testsMeasured` read; a test with no time, failed or cut is not slow.
 */
export function slowTests(tests) {
  const slowest = new Map();
  for (const test of tests || []) {
    if (!isSlow(test)) continue;
    const known = slowest.get(keyOf(test));
    if (!known || test.seconds > known.seconds) slowest.set(keyOf(test), { file: test.file, name: test.name, seconds: test.seconds });
  }
  return [...slowest.values()].sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

/**
 * The verdict's lines for the slow tests (`slowTests`): a heading that says they
 * are over the indicator and not red, then `slow <file> › <name> — 1.400 s` for
 * at most `SLOW_LINES`, then how many were left out. Nothing when none is slow.
 * `indent` prefixes every line.
 */
export function slowTestLines(slow, { indent = '' } = {}) {
  const list = slowTests(slow || []);
  if (!list.length) return [];
  const lines = [`${indent}${list.length} test${list.length === 1 ? '' : 's'} over the ${SLOW_TEST_MS / 1000} s slow-test indicator — not red; rebuild a new or changed one, or say in the PR why its cost is warranted:`];
  for (const test of list.slice(0, SLOW_LINES)) lines.push(`${indent}slow ${test.file} › ${test.name} — ${test.seconds.toFixed(3)} s`);
  if (list.length > SLOW_LINES) lines.push(`${indent}… and ${list.length - SLOW_LINES} more slow tests`);
  return lines;
}

/** Where the slow tests and the tests that reached their time limit are kept: `<work root>/runner/too-slow/<repo>.tsv`. */
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
 * The tests of a round that node cut at the stall guard, and the passed tests
 * over the slow-test indicator, kept in the repository's too-slow file until
 * they pass under their row's limit (Martin, 2026-11-03 and 2026-11-07: a cut
 * test is red and is rebuilt, not rerun; a slow one is named, not red). A cut
 * row's `limit_ms` is the limit it was cut at; a slow row's is `SLOW_TEST_MS`.
 * `tests` is what `testsMeasured` read off the round; `where` names it, the pull
 * request or `gate`. One row per test: a test already there keeps its
 * `first_seen` and gets this round's `last_seen`, `where` and limit; a test that
 * passed under its row's limit this round is removed. The file is written whole
 * or not at all, and only when a row changed. A courtesy like `recordTestTimes`:
 * a file that cannot be written costs the record, never the round its verdict.
 * Returns the rows now in the file, or null when nothing was written.
 */
export function recordTooSlow({ root, repo, where = 'gate', tests = [], now = new Date() }) {
  try {
    const slow = [
      ...tests.filter((test) => test.timeout > 0).map((test) => ({ test, limit: test.timeout })),
      ...tests.filter(isSlow).map((test) => ({ test, limit: SLOW_TEST_MS })),
    ];
    const passed = new Map(tests.filter((test) => !test.failed && test.seconds !== null).map((test) => [keyOf(test), test.seconds * 1000]));
    const before = readTooSlow({ root, repo });
    const rows = before.filter((row) => {
      const ms = passed.get(keyOf(row));
      return ms === undefined || (row.limit_ms !== null && ms >= row.limit_ms);
    });
    const stamp = now.toISOString();
    for (const { test, limit } of slow) {
      const row = rows.find((one) => keyOf(one) === keyOf(test));
      // A cut row that passed over the indicator becomes a slow row and keeps when it was first seen.
      const first = before.find((one) => keyOf(one) === keyOf(test))?.first_seen || stamp;
      if (row) Object.assign(row, { last_seen: stamp, where, limit_ms: limit });
      else rows.push({ file: test.file, name: test.name, first_seen: first, last_seen: stamp, where, limit_ms: limit });
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
 * seconds they took, slowest first; `ended` is every file whose run wrote its own
 * `{ file, ended }` line (any `ok`), which node writes once the file's run is summed up.
 * Start and done lines name the file a test was called from, which for a file that
 * only calls a helper is the helper: so `ended` alone says a file ran whole.
 * All are absolute paths, as node reports them. A file that was never started is
 * in none of them: the caller knows which it was asked for.
 */
export function runProgress(paths) {
  const started = new Map();
  const ended = new Map();
  const seconds = new Map();
  const summed = new Set();
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
      } else if (entry.ended === true) summed.add(entry.file);
    }
  }
  const unfinished = [...started.keys()].filter((file) => (ended.get(file) || 0) < started.get(file));
  const done = new Set(unfinished);
  const finished = [...ended.keys()].filter((file) => !done.has(file))
    .map((file) => ({ file, seconds: Math.round((seconds.get(file) || 0) * 10) / 10 }))
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
  return { unfinished: unfinished.sort(), finished, ended: [...summed].sort() };
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
 * `outputCut` matches). A file is whole only when its run wrote its ended line
 * and no top-level test of it is left started (`outputCut`'s rule); a file that is
 * not whole is `unfinished`, or `not-started` when the run named none of it. A
 * whole file is `failed` when node summed it up as failed or one of its tests
 * failed, and `passed` when node summed it up as ended and none failed (`runOutcomes`).
 */
export function fileOutcomes(files, { progress, outcomes }) {
  const asked = [...new Set((files || []).map(String).filter(Boolean))];
  const name = (path) => asked.find((file) => path === file || path.endsWith(`/${file}`)) || null;
  const unfinished = new Set((progress?.unfinished || []).map(name));
  const summed = new Set((progress?.ended || []).map(name));
  // Named by any line of the run: a start, a done, an ended or a test line.
  const named = new Set([...(progress?.unfinished || []), ...(progress?.finished || []).map((one) => one.file),
    ...(progress?.ended || []), ...(outcomes?.tests || []).map((test) => test.file)].map(name));
  const finished = new Map((progress?.finished || []).map((one) => [name(one.file), one.seconds]));
  const failed = new Set((outcomes?.failed || []).map(name));
  const endedOk = new Set((outcomes?.ended || []).map(name));
  const tests = new Map();
  for (const test of outcomes?.tests || []) {
    const file = name(test.file);
    if (file) tests.set(file, [...(tests.get(file) || []), { ...test, file }]);
  }
  return asked.map((file) => ({
    file,
    outcome: unfinished.has(file) || !summed.has(file) ? (named.has(file) ? 'unfinished' : 'not-started')
      : failed.has(file) ? 'failed' : endedOk.has(file) ? 'passed' : 'unfinished',
    seconds: finished.get(file) ?? null,
    tests: tests.get(file) || [],
  }));
}

/**
 * The files a tracker's run snapshots leave ended, in the order the runs ran: a
 * file is ended as the latest run that named it left it, so an earlier run's ended
 * line does not stand for a later rerun of the same file that never wrote one.
 */
function endedAsLatest(snapshots) {
  const ended = new Set();
  for (const snapshot of snapshots) {
    const summed = new Set(snapshot.ended);
    const named = [...snapshot.unfinished, ...snapshot.finished.map((one) => one.file), ...summed];
    for (const file of named) {
      if (summed.has(file)) ended.add(file);
      else ended.delete(file);
    }
  }
  return ended;
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
    /**
     * The failed files and named tests of every run, completed or still going (`runOutcomes`).
     * `failed` and `tests` are unions over every run. `ended` is the files `read()` leaves
     * ended, less the failed: a file is ended as the latest run that named it left it, as in
     * `read()`, so an earlier run's ended line never stands for a later rerun that wrote none. Less the failed, it is the
     * ended-with-ok files of `runOutcomes().ended`, since `runOutcomes` puts every not-ok ended file in `failed`.
     */
    outcomes: () => {
      const all = [...outcomes, runOutcomes(active)];
      const failed = new Set(all.flatMap((one) => one.failed));
      const ended = endedAsLatest([...completed, runProgress(active)]);
      return { failed: [...failed].sort(), ended: [...ended].filter((file) => !failed.has(file)).sort(),
        tests: all.flatMap((one) => one.tests) };
    },
    read: () => {
      const snapshots = [...completed, runProgress(active)];
      const unfinished = new Set(snapshots.flatMap((one) => one.unfinished));
      const ended = endedAsLatest(snapshots);
      const seconds = new Map();
      for (const one of snapshots.flatMap((snapshot) => snapshot.finished)) {
        seconds.set(one.file, (seconds.get(one.file) || 0) + one.seconds);
      }
      return {
        unfinished: [...unfinished].sort(),
        finished: [...seconds].filter(([file]) => !unfinished.has(file))
          .map(([file, seconds]) => ({ file, seconds: Math.round(seconds * 10) / 10 }))
          .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file)),
        ended: [...ended].sort(),
      };
    },
  };
}

/**
 * The requested files a run did not finish, as they were asked for. An asked file
 * is whole only when its run wrote its `{ file, ended }` line (`runProgress`'s
 * `ended`) and no top-level test of it is left started; any other asked file is
 * cut, including one whose start and done lines all balance but which never wrote
 * its ended line, and one no line named at all. Start and done lines of a path that was not
 * asked (a helper a file calls) never cut an asked file. With no files asked (a
 * whole suite), the unfinished paths are the cut. A run that exits 0 and prints its
 * summary can still have been cut short — its exit code and its totals say nothing
 * about a file that never wrote its ended line. Matched by tail, as `redFiles`
 * matches: node reports the real path of a file, and a worktree may be reached
 * through a link.
 */
export function outputCut(files, { progress }) {
  const asked = [...new Set((files || []).map(String).filter(Boolean))];
  const name = (path) => asked.find((file) => path === file || path.endsWith(`/${file}`)) || path;
  const unfinished = new Set((progress?.unfinished || []).map(name));
  const summed = new Set((progress?.ended || []).map(name));
  const cut = asked.filter((file) => unfinished.has(file) || !summed.has(file));
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

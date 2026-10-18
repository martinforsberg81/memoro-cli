/**
 * `mc gate` — the repository's own local gate, run in the worktree the caller
 * stands in, answered in a bounded number of lines.
 *
 * The session's gate before the pull request exists. `mc test <repo> <pr>`
 * measures a pull request in a throwaway worktree; this runs the same thing
 * the repository's `AGENTS.md` tells a session to run before it pushes —
 * `npm run ci -- --base-ref origin/<base>` where the repository has a `ci`
 * script, `npm test` otherwise — and keeps the output out of the session's
 * context. Measured over 2026-09-15..25 (233 step sessions): the test class
 * was 375 Bash calls and 4.1 h of wall, and a red run's output is the whole
 * suite's chatter, re-read on every turn that follows. What comes back here
 * is the verdict, the counts, the failing names with their locations, and
 * the path of the whole output on disk — at most `OUTPUT_CAP` bytes; the
 * disk is free and the context is not.
 *
 * Pure over text: the verb runs the command and hands the output in.
 */

/** How much of the gate's output the caller's context gets, in bytes. */
export const OUTPUT_CAP = 2048;
/** How many failing lines are named before the rest is "and N more". */
export const FAILURE_LINES = 20;

/**
 * The command the repository means by "run the gate on this tree", read
 * from its `package.json`: a `ci` script gets the base it measures against
 * (memoro's `scripts/testing/ci.mjs` selects by the diff to it); otherwise
 * `npm test`, verbatim. Null when there is neither — the gate has nothing
 * to run, and says so rather than guessing.
 */
export function gateCommand(manifest, { base = 'origin/main' } = {}) {
  const scripts = manifest?.scripts || {};
  if (typeof scripts.ci === 'string' && scripts.ci.trim()) {
    return { run: `npm run ci -- --base-ref ${base}`, script: scripts.ci, source: 'ci' };
  }
  if (typeof scripts.test === 'string' && scripts.test.trim()) {
    return { run: 'npm test', script: scripts.test, source: 'test' };
  }
  return null;
}

/**
 * The `node --test` flags a repository's `test` script carries: every
 * `--import <x>` / `--import=<x>` and `--experimental-*` argument, in order.
 * Empty when the script does not start with `node --test`.
 */
export function testFlags(script) {
  const words = String(script || '').trim().split(/\s+/u);
  if (words[0] !== 'node' || words[1] !== '--test') return [];
  const flags = [];
  for (let i = 2; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--import' && words[i + 1]) { flags.push(word, words[i + 1]); i += 1; }
    else if (word.startsWith('--import=') || word.startsWith('--experimental-')) flags.push(word);
  }
  return flags;
}

/**
 * The command for named test files: `node --test` with the repository's flags,
 * the files (relative to the worktree root), and the name pattern if one was given.
 * `flags` replaces the flags read off the `test` script — the declaration's
 * `pr_tests_flags`, for a repository whose `test` script is not a `node --test` line.
 */
export function namedCommand(manifest, files, { pattern, flags = null } = {}) {
  const script = manifest?.scripts?.test ?? null;
  const words = ['node', '--test', ...(flags?.length ? flags.map(shellWord) : testFlags(script)), ...files.map(shellWord)];
  if (pattern != null) words.push('--test-name-pattern', shellQuote(pattern));
  return { run: words.join(' '), script, source: 'files', files };
}

/** The failing test names the reporter printed (`✖ name (1.2ms)`), once each, in order. */
export function failingNames(output) {
  const names = [];
  for (const line of String(output || '').split('\n')) {
    const failed = FAILED_TEST.exec(line);
    if (!failed || failed[1] === 'failing tests:' || names.includes(failed[1])) continue;
    names.push(failed[1]);
  }
  return names;
}

/**
 * The `--test-name-pattern` that selects the named tests: at most five of
 * them, each regex-escaped, joined by `|`.
 */
export function namePattern(names) {
  return names.slice(0, RERUN_NAMES).map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
}

/**
 * The line a red named-files gate hands back: the same files again, on the
 * tests that failed. Null when no files were named.
 */
export function rerunLine(files, output) {
  if (!files?.length) return null;
  const names = failingNames(output);
  const pattern = names.length ? ` --test-name-pattern ${shellQuote(namePattern(names))}` : '';
  return `re-run: mc gate ${files.map(shellWord).join(' ')}${pattern}`;
}

/**
 * The test files a red gate's output names as failing, once each, in order,
 * relative to the worktree root: node's spec reporter prints `test at
 * <file>:<line>:<col>` above each failing test in its closing summary; TAP
 * prints `location: '<file>:<line>:<col>'` in the block of every test, so only
 * a `not ok` block's counts; a stack frame counts when it follows a failing
 * line; and a `✖ <file>` names a file that failed outside any test. Only
 * `….test.js` / `….test.mjs` paths inside the worktree are kept — a helper
 * module in a stack is not a test file. Empty when nothing names one, which
 * the incremental gate reads as "cannot tell what was red".
 */
export function redFiles(output, { root = null } = {}) {
  const found = [];
  const keep = (raw) => {
    const file = testFileOf(raw, root);
    if (file && !found.includes(file)) found.push(file);
  };
  let failing = false;
  for (const line of String(output || '').split('\n')) {
    const at = SPEC_TEST_AT.exec(line);
    if (at) { keep(at[1]); continue; }
    if (TAP_OK.test(line) || PASSED.test(line)) { failing = false; continue; }
    const crossed = FAILED_TEST.exec(line);
    if (crossed) keep(crossed[1]);
    if (FAILURE.test(line)) { failing = true; continue; }
    if (!failing) continue;
    const location = TAP_LOCATION.exec(line);
    if (location) { keep(location[1]); continue; }
    const frame = LOCATION.exec(line);
    if (frame) keep(frame[1] || frame[2]);
  }
  return found;
}

/** A path from a report line as a worktree-relative test file, or null. */
function testFileOf(raw, root) {
  let path = String(raw || '').trim().replace(/^file:\/\//u, '').replace(/:\d+(?::\d+)?$/u, '');
  if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
  path = path.replace(/^\.\//u, '');
  if (path.startsWith('/') || path.includes('node_modules/') || path.split('/').includes('..')) return null;
  return TEST_FILE.test(path) ? path : null;
}

/** A word for `sh -c`, quoted only where it has to be. */
function shellWord(word) {
  return /^[\w./:=@%+,-]+$/u.test(word) ? word : shellQuote(word);
}

function shellQuote(text) {
  return `'${String(text).replace(/'/gu, `'\\''`)}'`;
}

// A line that names a failure, across the reporters the two repositories
// print: node's spec reporter (`✖ name`), TAP (`not ok N - name`), memoro's
// ci summary (`status: fail`, `command x: fail`), and the assertion's own
// first line. Location lines (`at file:line`) are kept only right after one.
const FAILURE = /^\s*(✖|not ok\b|\s*status: fail|\s*command [\w:-]+: fail|AssertionError|Error:|TypeError|ReferenceError|SyntaxError|FAIL\b)/u;
const LOCATION = /^\s+at .*\((.*?:\d+):\d+\)|^\s+at (\S+:\d+):\d+/u;
const COUNTS = /^ℹ (tests|pass|fail|skipped) (\d+)$/u;
const CI_TESTS = /^\s*tests: ran (\d+)\/(\d+) files/u;
// memoro's ci prints one `ℹ tests` block per lane; a failed command gate is
// `command sql:pr-ci: fail`; a refused selection is `ci runner:` and the paths.
const COMMAND_FAIL = /^\s*command ([\w:.-]+): fail/u;
const CI_RUNNER = /^ci runner: /u;
const CI_RUNNER_PATH = /^\s*- \S/u;
const CI_RUNNER_PATHS = 10;
// A failing test's line in node's spec reporter, with its duration when it has one.
const FAILED_TEST = /^\s*✖ (.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/u;
// What `redFiles` reads: the spec reporter's summary line above a failing test,
// TAP's location, a passing test that ends a failing block, and a test file path.
const SPEC_TEST_AT = /^\s*test at (\S+?:\d+:\d+)\s*$/u;
const TAP_LOCATION = /^\s+location: '([^']+)'/u;
const TAP_OK = /^\s*ok \d+\b/u;
const PASSED = /^\s*✔ /u;
const TEST_FILE = /^[\w@.+-][\w@.+/-]*\.test\.m?js$/u;
/** How many failing test names a re-run line names. */
const RERUN_NAMES = 5;

/**
 * The output boiled down: `ok`, the counts the reporter printed (summed over
 * every block — each lane prints its own), the failed command gates by name,
 * the failing lines (each with the first location line under it), and how
 * many failing lines were left unnamed. `ok` is the exit code's, not the
 * text's — a suite that crashes before its summary is red with no counts.
 */
export function summarizeGate(output, { exitCode }) {
  const lines = String(output || '').split('\n');
  const counts = {};
  const gates = [];
  const failures = [];
  let pendingLocation = false;
  let runnerPaths = -1;
  for (const line of lines) {
    const count = COUNTS.exec(line);
    if (count) { counts[count[1]] = (counts[count[1]] || 0) + Number(count[2]); continue; }
    const ran = CI_TESTS.exec(line);
    if (ran) { counts.files = Number(ran[1]); counts.selected = Number(ran[2]); continue; }
    const gate = COMMAND_FAIL.exec(line);
    if (gate && !gates.includes(gate[1])) gates.push(gate[1]);
    if (CI_RUNNER.test(line)) { failures.push(line.trimEnd()); runnerPaths = 0; continue; }
    if (runnerPaths >= 0) {
      if (CI_RUNNER_PATH.test(line)) {
        if (runnerPaths < CI_RUNNER_PATHS) failures.push(line.trimEnd());
        runnerPaths++;
        continue;
      }
      runnerPaths = -1;
    }
    if (pendingLocation) {
      const at = LOCATION.exec(line);
      if (at) { failures.push(`    ${at[1] || at[2]}`); pendingLocation = false; continue; }
    }
    if (FAILURE.test(line)) {
      failures.push(line.replace(/\s+\(\d+(\.\d+)?ms\)\s*$/u, '').trimEnd());
      pendingLocation = true;
    }
  }
  return { ok: exitCode === 0, counts, gates, failures: failures.slice(0, FAILURE_LINES), more: Math.max(0, failures.length - FAILURE_LINES) };
}

/**
 * The lines the session reads, capped at `OUTPUT_CAP` bytes. Green is three
 * lines; red names what failed, the re-run line when there are named files,
 * and where the whole output is.
 */
export function gateLines(summary, { command, seconds, logPath, rerun = null, label = null }) {
  const c = summary.counts;
  const gates = summary.gates ?? [];
  let counted = c.tests != null
    ? `${c.tests} tests, ${c.fail ?? 0} failed${c.skipped ? `, ${c.skipped} skipped` : ''}`
    : c.files != null ? `${c.files}/${c.selected} files` : 'no counts in the output';
  if (!summary.ok && gates.length) {
    counted += `; command gate${gates.length === 1 ? '' : 's'} failed: ${gates.join(', ')}`;
  } else if (!summary.ok && !c.fail && c.files == null && summary.failures.length) {
    // The counts say nothing failed, but something did, and it is named below.
    counted = `${c.tests ?? 0} tests counted — the failure is below`;
  }
  const lines = [
    `${summary.ok ? 'GREEN' : 'RED'}${label ? ` ${label}` : ''} — ${command} — ${counted} — ${seconds}s`,
  ];
  if (!summary.ok) {
    for (const line of summary.failures) lines.push(line);
    if (summary.more) lines.push(`… and ${summary.more} more failing lines`);
    if (!summary.failures.length && !gates.length) lines.push('the output names no failing test — read the log');
    if (rerun) lines.push(rerun);
  }
  lines.push(`whole output: ${logPath}`);
  let text = lines.join('\n');
  if (Buffer.byteLength(text) > OUTPUT_CAP) {
    const keep = [];
    let size = Buffer.byteLength(`… (capped at ${OUTPUT_CAP} bytes)\nwhole output: ${logPath}`) + 1;
    for (const line of lines.slice(0, -1)) {
      size += Buffer.byteLength(line) + 1;
      if (size > OUTPUT_CAP) break;
      keep.push(line);
    }
    text = [...keep, `… (capped at ${OUTPUT_CAP} bytes)`, `whole output: ${logPath}`].join('\n');
  }
  return text;
}

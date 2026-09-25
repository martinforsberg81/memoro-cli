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

// A line that names a failure, across the reporters the two repositories
// print: node's spec reporter (`✖ name`), TAP (`not ok N - name`), memoro's
// ci summary (`status: fail`, `command x: fail`), and the assertion's own
// first line. Location lines (`at file:line`) are kept only right after one.
const FAILURE = /^\s*(✖|not ok\b|\s*status: fail|\s*command [\w:-]+: fail|AssertionError|Error:|TypeError|ReferenceError|SyntaxError|FAIL\b)/u;
const LOCATION = /^\s+at .*\((.*?:\d+):\d+\)|^\s+at (\S+:\d+):\d+/u;
const COUNTS = /^ℹ (tests|pass|fail|skipped) (\d+)$/u;
const CI_TESTS = /^\s*tests: ran (\d+)\/(\d+) files/u;

/**
 * The output boiled down: `ok`, the counts the reporter printed, the failing
 * lines (each with the first location line under it), and how many failing
 * lines were left unnamed. `ok` is the exit code's, not the text's — a suite
 * that crashes before its summary is red with no counts.
 */
export function summarizeGate(output, { exitCode }) {
  const lines = String(output || '').split('\n');
  const counts = {};
  const failures = [];
  let pendingLocation = false;
  for (const line of lines) {
    const count = COUNTS.exec(line);
    if (count) { counts[count[1]] = Number(count[2]); continue; }
    const ran = CI_TESTS.exec(line);
    if (ran) { counts.files = Number(ran[1]); counts.selected = Number(ran[2]); continue; }
    if (pendingLocation) {
      const at = LOCATION.exec(line);
      if (at) { failures.push(`    ${at[1] || at[2]}`); pendingLocation = false; continue; }
    }
    if (FAILURE.test(line)) {
      failures.push(line.replace(/\s+\(\d+(\.\d+)?ms\)\s*$/u, '').trimEnd());
      pendingLocation = true;
    }
  }
  return { ok: exitCode === 0, counts, failures: failures.slice(0, FAILURE_LINES), more: Math.max(0, failures.length - FAILURE_LINES) };
}

/**
 * The lines the session reads, capped at `OUTPUT_CAP` bytes. Green is three
 * lines; red names what failed and where the whole output is.
 */
export function gateLines(summary, { command, seconds, logPath }) {
  const c = summary.counts;
  const counted = c.tests != null
    ? `${c.tests} tests, ${c.fail ?? 0} failed${c.skipped ? `, ${c.skipped} skipped` : ''}`
    : c.files != null ? `${c.files}/${c.selected} files` : 'no counts in the output';
  const lines = [
    `${summary.ok ? 'GREEN' : 'RED'} — ${command} — ${counted} — ${seconds}s`,
  ];
  if (!summary.ok) {
    for (const line of summary.failures) lines.push(line);
    if (summary.more) lines.push(`… and ${summary.more} more failing lines`);
    if (!summary.failures.length) lines.push('the output names no failing test — read the log');
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

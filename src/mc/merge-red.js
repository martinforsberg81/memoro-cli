/**
 * A red round's failures, kept on disk and handed on (ruling 44).
 *
 * A round that went red used to leave its reason — "2 tests red: a › b" — and
 * nothing else. The session the step came back to, or the mend, then ran the
 * whole suite again to see what the round had already seen, and the mend was
 * told `red files:` with nothing after it in every case: the merge report keeps
 * the gate's verdict under `gate`, and the mend read the top level only.
 *
 * So every round that finishes `red` writes what failed to
 * `runner/merge-red/<repo>-<pr>.txt` — per red test its file, its name, where
 * it failed and the assertion's first lines, at most `DETAIL_LINES` in all —
 * one file per pull request, the next red overwriting it and a landing
 * removing it. The retry preamble names that path, the red files and the one
 * `mc gate` line that runs just those tests again.
 *
 * Martin, 2026-11-10: every red names exactly what did not pass, and nobody
 * runs a test or a gate again to find out. So the file is written for every
 * stop that is a failure, not only `red`: each red test with its whole error
 * and stack (`detail`, `tap-red.js`), the pull request's own red tests, and
 * each failed command gate with its command, exit, the tests or lines it
 * failed on (`command-failure.js`) and the path of its whole output. Until then
 * a failed command gate (`selected-gate`) wrote nothing, and each red test kept
 * six lines of its error.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** At most this many lines in a red round's file. */
export const DETAIL_LINES = 6000;

/**
 * The stops that are not a failure of the change or its gates: nothing was
 * measured, or the round was put back without a verdict. Every other stop
 * writes its file.
 */
export const NO_DETAIL_STOPS = Object.freeze(['lease', 'gone', 'offline', 'moved', 'dropped', 'fetch', 'pr']);

/** At most this many test names in the re-run line's pattern. */
export const RERUN_NAMES = 5;

/** Where a pull request's last red round is kept: `<root>/runner/merge-red/<repo>-<pr>.txt`. */
export function mergeRedPath(root, repo, pr) {
  return join(root, 'runner', 'merge-red', `${repo}-${pr}.txt`);
}

/**
 * The stops whose failures are kept besides `red`: a red only under load and a
 * file killed from outside the round. Kept under a name of their own, with the
 * round's time, because the pull request is put back in line and may land —
 * and a landing removes `mergeRedPath` — while whether it failed for a
 * different reason under load than alone is what a later reader needs
 * (gate-round-under-load, 2026-10-19).
 */
export const KEPT_LOAD_STOPS = Object.freeze(['red-under-load', 'file-killed']);

/** Where a load stop's failures are kept: `<repo>-<pr>-<stop>-<time>.txt`, never removed by a landing. */
export function loadRedPath(root, repo, pr, stop, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  return join(root, 'runner', 'merge-red', `${repo}-${pr}-${stop}-${stamp}.txt`);
}

/** The gate's verdict a report carries: a merge round's `gate`, or the report itself. */
const gateOf = (report) => report?.gate || report || {};

/**
 * The red files of a gate verdict: the selected run's, or — for a whole-suite
 * run, which names no files — the files its red tests are in.
 */
export function gateRedFiles(gate) {
  if (gate?.red_files?.length) return [...new Set(gate.red_files)];
  const named = gate?.candidate?.red_files || [];
  if (named.length) return [...named];
  return [...new Set((gate?.candidate?.red_tests || []).map((test) => test.file).filter(Boolean))];
}

/**
 * What a red round hands on: `{ files, detail, names }` — its red files, the
 * path of its file under `merge-red/` and its red tests' own names — or null
 * when it named no red file.
 */
export function redHandoff(report) {
  const gate = gateOf(report);
  const files = [...new Set([...(report?.red_files || []), ...gateRedFiles(gate)])];
  const gates = failedGates(gate).map((one) => one.id || one.name);
  if (!files.length && gates.length) return { files: [], detail: report?.red_detail || null, names: [], gates };
  if (!files.length) return null;
  const tests = gate.candidate?.red_tests;
  const names = tests?.length ? tests.map((test) => test.own) : (gate.candidate?.red || []).map((name) => name.split(' › ').at(-1));
  return { files, detail: report?.red_detail || null, names: [...new Set(names.filter(Boolean))] };
}

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const quoted = (text) => `'${String(text).replace(/'/gu, "'\\''")}'`;

/** The one line that runs just the red tests again: `mc gate <files> --test-name-pattern '<names>'`. */
export function rerunLine(files, names = []) {
  const some = [...new Set(names)].slice(0, RERUN_NAMES).map(escapeRegExp);
  return `Re-run just those: mc gate ${files.join(' ')}${some.length ? ` --test-name-pattern ${quoted(some.join('|'))}` : ''}`;
}

/** The three lines a retry is handed; empty without red files. */
export function redLines(red) {
  if (!red?.files?.length && red?.gates?.length) {
    return [
      `Failed command gates: ${red.gates.join(' ')}`,
      ...(red.detail ? [`The failures, as the round saw them: ${red.detail}`] : []),
      ...red.gates.map((id) => `Re-run it: mc gate --command ${id}`),
    ];
  }
  if (!red?.files?.length) return [];
  return [
    `Red files: ${red.files.join(' ')}`,
    ...(red.detail ? [`The failures, as the round saw them: ${red.detail}`] : []),
    rerunLine(red.files, red.names || []),
  ];
}

/** The command gates of a verdict that failed: ran, not ok, and not unavailable. */
export function failedGates(gate) {
  return (gate?.extra_gates || []).filter((one) => one && one.ran !== false && !one.ok && !one.unavailable);
}

/** Red tests under a heading per file: name, place and the whole error. */
function testLines(tests, lines) {
  const byFile = new Map();
  for (const test of tests) {
    const file = test.file || '(no file named)';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(test);
  }
  for (const [file, inFile] of byFile) {
    lines.push('', file);
    for (const test of inFile) {
      lines.push(`  ✗ ${test.name}`);
      if (test.at) lines.push(`    at ${test.at}`);
      for (const line of test.detail || test.error || []) lines.push(`    ${line}`);
    }
  }
}

/** The text of a red round's file: everything that failed, at most `DETAIL_LINES` lines. */
export function redDetailText(report, { repo, pr, now = new Date() } = {}) {
  const gate = gateOf(report);
  const tests = gate.candidate?.red_tests || [];
  const lines = [
    `${repo} #${pr} — ${report?.stopped_at || gate.stopped_at || 'red'} at ${now.toISOString().replace(/\.\d{3}Z$/u, 'Z')}`,
    `reason: ${report?.reason || gate.reason || 'the round said nothing'}`,
  ];
  const files = gateRedFiles(gate);
  if (files.length) lines.push(`red files: ${files.join(' ')}`);
  testLines(tests, lines);
  const own = [gate.pr_tests, ...(gate.prs || []).map((item) => item?.pr_tests)].flatMap((result) => result?.red_tests || []);
  if (own.length) {
    lines.push('', "The pull request's own tests:");
    testLines(own, lines);
  }
  const gates = failedGates(gate);
  for (const one of gates) {
    lines.push('', `command gate ${one.name}${one.id && one.id !== one.name ? ` (${one.id})` : ''} — exit ${one.exit_code ?? 'none'}${one.signal ? `, signal ${one.signal}` : ''}${one.duration_ms != null ? `, ${Math.round(one.duration_ms / 100) / 10} s` : ''}`);
    if (one.command) lines.push(`  $ ${one.command}`);
    if (one.output_path) lines.push(`  whole output: ${one.output_path}`);
    const failure = one.failure || {};
    if (failure.tests?.length) testLines(failure.tests, lines);
    else if (failure.spec?.length) for (const line of failure.spec) lines.push(`  ${line}`);
    else for (const line of (failure.tail?.length ? failure.tail : String(one.output || '').split('\n'))) lines.push(`  ${line}`);
  }
  if (!tests.length && !own.length && !gates.length) lines.push('', 'The round named no red test or failed gate; its reason above is all it said.');
  if (lines.length > DETAIL_LINES) {
    const cut = lines.length - (DETAIL_LINES - 1);
    lines.length = DETAIL_LINES - 1;
    lines.push(`… ${cut} more line${cut === 1 ? '' : 's'} not kept here — the round's log has them`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A red round's file written, and its path; null for a round that is not
 * `red`, or when it cannot be written — a file that describes a round must
 * never fail it.
 */
export function writeRedDetail({ root, repo, pr, report, now = new Date() }) {
  if (!report || report.ok) return null;
  const load = KEPT_LOAD_STOPS.includes(report.stopped_at);
  if (NO_DETAIL_STOPS.includes(report.stopped_at)) return null;
  try {
    const path = load ? loadRedPath(root, repo, pr, report.stopped_at, now) : mergeRedPath(root, repo, pr);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, redDetailText(report, { repo, pr, now }));
    return path;
  } catch {
    return null;
  }
}

/** A landed pull request's red file removed; nothing to remove is fine. */
export function removeRedDetail({ root, repo, pr }) {
  try { rmSync(mergeRedPath(root, repo, pr), { force: true }); } catch { /* nothing kept it */ }
}

/** A compact display reason; the complete diagnostic stays in the report/log. */
export function mergeFailureSummary(reason) {
  const first = String(reason || 'failure reason unavailable').split(/\r?\n/u).find((line) => line.trim()) || 'failure reason unavailable';
  if (/not mergeable|merge conflict|CONFLICT \(/iu.test(first)) return 'Merge conflict';
  return first.replace(/^merge:\s*(?:X\s*)?/u, '').trim();
}

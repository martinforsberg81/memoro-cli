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
 * removing it. The retry preamble and the mend prompt name that path, the red
 * files and the one `mc gate` line that runs just those tests again.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** At most this many lines in a red round's file. */
export const DETAIL_LINES = 200;

/** At most this many test names in the re-run line's pattern. */
export const RERUN_NAMES = 5;

/** Where a pull request's last red round is kept: `<root>/runner/merge-red/<repo>-<pr>.txt`. */
export function mergeRedPath(root, repo, pr) {
  return join(root, 'runner', 'merge-red', `${repo}-${pr}.txt`);
}

/** The gate's verdict a report carries: a merge round's `gate`, or the report itself. */
const gateOf = (report) => report?.gate || report || {};

/**
 * The red files of a gate verdict: the selected run's, or — for a whole-suite
 * run, which names no files — the files its red tests are in.
 */
export function gateRedFiles(gate) {
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

/** The three lines a retry and a mend are handed; empty without red files. */
export function redLines(red) {
  if (!red?.files?.length) return [];
  return [
    `Red files: ${red.files.join(' ')}`,
    ...(red.detail ? [`The failures, as the round saw them: ${red.detail}`] : []),
    rerunLine(red.files, red.names || []),
  ];
}

/** The text of a red round's file: what failed, per file, at most `DETAIL_LINES` lines. */
export function redDetailText(report, { repo, pr, now = new Date() } = {}) {
  const gate = gateOf(report);
  const tests = gate.candidate?.red_tests || [];
  const lines = [
    `${repo} #${pr} — red at ${now.toISOString().replace(/\.\d{3}Z$/u, 'Z')}`,
    `reason: ${report?.reason || gate.reason || 'the round said nothing'}`,
  ];
  const files = gateRedFiles(gate);
  if (files.length) lines.push(`red files: ${files.join(' ')}`);
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
      for (const line of test.error || []) lines.push(`    ${line}`);
    }
  }
  if (!tests.length) lines.push('', 'The round named no red test of its own; its reason above is all it said.');
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
  if (!report || report.ok || report.stopped_at !== 'red') return null;
  try {
    const path = mergeRedPath(root, repo, pr);
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

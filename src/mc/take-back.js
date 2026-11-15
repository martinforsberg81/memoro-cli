/**
 * Whether a release can be taken back, read by memoro's own script.
 *
 * `mc deploy` says, for the commits between what is live and the commit it
 * picks, whether the release can be taken back and, when it cannot, which
 * change makes it so (docs/technical/mc-deploy.md, *The reading*). The rules
 * are memoro's (`docs/technical/release-take-back.md`, in
 * `scripts/_lib/release-reading.mjs`); this module only runs the script and
 * reads what it printed.
 *
 * It uses no checkout. `mc deploy` runs in the bare repository
 * `~/mc/repos/memoro.git`, which has no working tree and so no script; the
 * checkout mc keeps (`~/mc/self/memoro`) can be behind or on another branch,
 * without `scripts/release/` at all. So the pick's `scripts/` is written out as
 * the pick has it into a directory of its own, and run there. The script
 * reads the repository only through git and needs no package (D6), so it asks
 * nothing of the directory it stands in. It does not go through `atRev`, whose
 * cwd is a checkout and whose packages are that checkout's.
 *
 * A reading that cannot be made is a release that cannot be taken back
 * (`made: false, can: false`, `why` saying `reading not made: …`): the
 * answer to "can it be undone" is never "unknown, so yes". The reading never
 * refuses, holds or asks; what it changes is what is said and recorded.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportAtRev, reasonLine } from './export-at-rev.js';

/** The script's own path in the repository: what `exportAtRev` is asked for and what runs. */
export const READING_SCRIPT = 'scripts/release/reading.mjs';
/** How long the script may take; past it the reading is not made, and mc does not stall on it. */
export const READING_TIMEOUT_MS = 60_000;
/** The reasons a line or a cell spells out; the rest are counted. */
export const REASONS_SHOWN = 5;

const KINDS = new Set([
  'migration-after', 'migration-before', 'migration-changed', 'durable-object',
  'binding', 'container', 'config', 'production-act',
]);

/** A reading that could not be made: `no`, with the reason in the words the row keeps. */
function notMade(why) {
  return { made: false, can: false, reasons: [], why: `reading not made: ${why}` };
}

/**
 * The D6 object, or the line that says what is wrong with `text`. Strict on
 * purpose: output that is not exactly what the contract says is no reading.
 */
function parseReading(text) {
  let json;
  try { json = JSON.parse(text); } catch { return { problem: 'the script printed no JSON' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { problem: 'the script printed no JSON object' };
  if (json.schema_version !== 1) return { problem: `the script's schema_version is ${JSON.stringify(json.schema_version)}, not 1` };
  if (typeof json.can_take_back !== 'boolean') return { problem: 'the script printed no can_take_back' };
  if (!Array.isArray(json.reasons)) return { problem: 'the script printed no reasons[]' };
  const reasons = [];
  for (const reason of json.reasons) {
    if (!reason || typeof reason !== 'object' || !KINDS.has(reason.kind) || typeof reason.what !== 'string') {
      return { problem: 'the script printed a reason that is not {kind, what, …}' };
    }
    const commits = Array.isArray(reason.commits)
      ? reason.commits.filter((c) => c && typeof c.sha === 'string').map((c) => ({ sha: c.sha, subject: String(c.subject ?? '') }))
      : [];
    reasons.push({ kind: reason.kind, what: reason.what, file: typeof reason.file === 'string' ? reason.file : '', commits });
  }
  if (json.can_take_back !== (reasons.length === 0)) return { problem: 'the script said can_take_back and reasons that disagree' };
  return { reasons };
}

/** One reason in a sentence: what it is and the commits that brought it. */
export function reasonText(reason, { subjects = false } = {}) {
  const commits = (reason.commits || []).map((c) => (subjects && c.subject ? `${c.sha} ${c.subject}` : c.sha));
  return `${reason.kind}: ${reason.what}${commits.length ? ` (${commits.join(', ')})` : ''}`;
}

/** The reasons as the `take_back_why` cell keeps them: one line, at most five, the rest counted. */
export function whyCell(reasons) {
  const shown = reasons.slice(0, REASONS_SHOWN).map((reason) => reasonText(reason));
  if (reasons.length > REASONS_SHOWN) shown.push(`and ${reasons.length - REASONS_SHOWN} more`);
  return shown.join('; ');
}

/** Runs `argv` in `cwd`, bounded: `{ code, stdout, stderr, error, timedOut }`. */
function runBounded(argv, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: error.message, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: null, error: error.message }));
    child.on('close', (code) => finish({ code }));
  });
}

/**
 * The reading for `from..to` in the repository git runs in, `path` — a bare
 * repository or a working tree; only refs and objects are read from it.
 *
 * Returns `{ made, can, reasons, why }`. `reasons` are the script's, each
 * `{ kind, what, file, commits: [{ sha, subject }] }`; `why` is what the row
 * keeps (empty when the release can be taken back, the reasons joined when it
 * cannot, `reading not made: <why>` when no reading was made). Never throws
 * and never refuses.
 */
export async function takeBackReading({
  path, from, to, exportTree = exportAtRev, timeoutMs = READING_TIMEOUT_MS, scratch = tmpdir(),
}) {
  if (!from) return notMade('no live commit is known, so there is no range to read');
  if (!path || !to) return notMade('no repository or commit to read');
  let dir = null;
  try {
    // The real path: Node resolves a module's import.meta.url through a symlinked tmpdir
    // (macOS' /var → /private/var), and a script that compares its own url with its argv
    // would otherwise run nothing (the lesson `atRev` learned, 2026-11-03).
    dir = realpathSync(mkdtempSync(join(scratch, 'mc-take-back-')));
    const why = exportTree(path, to, 'scripts', dir);
    if (why) return notMade(`${READING_SCRIPT} is not on ${to.slice(0, 10)} (${why})`);
    if (!existsSync(join(dir, READING_SCRIPT))) return notMade(`${to.slice(0, 10)} has no ${READING_SCRIPT}`);
    const result = await runBounded(
      ['node', join(dir, READING_SCRIPT), '--repo', path, '--from', from, '--to', to],
      { cwd: dir, timeoutMs },
    );
    if (result.timedOut) return notMade(`${READING_SCRIPT} did not finish in ${Math.round(timeoutMs / 1000)} s and was stopped`);
    if (result.error) return notMade(`${READING_SCRIPT} could not be run (${result.error})`);
    if (result.code !== 0) return notMade(`${READING_SCRIPT} exited ${result.code}${reasonLine(result.stderr) ? `: ${reasonLine(result.stderr)}` : ''}`);
    const parsed = parseReading(result.stdout);
    if (parsed.problem) return notMade(parsed.problem);
    return { made: true, can: parsed.reasons.length === 0, reasons: parsed.reasons, why: whyCell(parsed.reasons) };
  } catch (error) {
    return notMade(error?.message || String(error));
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** The `take_back` and `take_back_why` cells of a reading: empty when none was made at all. */
export function takeBackCells(reading) {
  if (!reading) return { take_back: '', take_back_why: '' };
  return { take_back: reading.can ? 'yes' : 'no', take_back_why: reading.why || '' };
}

/**
 * The reading as `mc deploy` says it: one line for can or cannot, then at most
 * five reasons with the commits that brought them, the rest counted.
 */
export function takeBackLines(reading) {
  if (!reading) return [];
  if (!reading.made) return [`mc: this release is read as one that cannot be taken back — ${reading.why}`];
  if (reading.can) return ['mc: this release can be taken back — nothing in it is one the provider cannot roll back'];
  const n = reading.reasons.length;
  const lines = [`mc: this release cannot be taken back — ${n === 1 ? '1 change makes' : `${n} changes make`} it so:`];
  for (const reason of reading.reasons.slice(0, REASONS_SHOWN)) lines.push(`mc:   ${reasonText(reason, { subjects: true })}`);
  if (n > REASONS_SHOWN) lines.push(`mc:   … and ${n - REASONS_SHOWN} more`);
  return lines;
}

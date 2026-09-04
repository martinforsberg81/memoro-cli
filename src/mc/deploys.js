/**
 * `~/mc/runner/log/deploys.tsv` — what mc deployed, written as it happens.
 *
 * One row per deploy a person typed, and the row exists before the deploy
 * does: `recordStart` appends it with `outcome: running` and `recordEnd`
 * completes that same row when the script exits. A deploy that dies half-way —
 * the terminal closed, the laptop slept, wrangler hung and somebody hit ^C —
 * is then a row that still says `running` with no `ended`, which is the true
 * thing to say about it. A gap would say nothing at all, and the reader would
 * have to reconstruct it from `/admin/deploy/logs` afterwards, which is the
 * failure mode this file exists to end.
 *
 * A refusal is a row too (`recordRefusal`): a `no` at the question, no
 * terminal to ask at, a repository somebody else holds. They are the deploys
 * somebody meant to make, and the brief can see them only if they are written.
 *
 * The shape follows `runs.tsv` (`RUNS_HEADER`, `tsvRow` in `run-plan.js`,
 * `parseRuns` in `brief-collect.js`): a header written once when the file is
 * made, rows appended whole, read back keyed by the header that file actually
 * carries rather than the one this module knows. That last part is why
 * completing a row rewrites the file through its own header: a `deploys.tsv`
 * written by an older mc keeps its columns, and a column this mc sets that the
 * file has no room for is dropped rather than shifting every cell after it.
 *
 * Rewriting the whole file to change one row is fine at this size — a deploy
 * is a thing that happens a few times a day at most — and it is one
 * `writeFileAtomic` (`atomic-write.js`), so a reader sees the file before or
 * after, never half-way through the edit.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { workRoot } from './paths.js';

/**
 * The columns. Append, never insert: a cell added at the end is one a
 * header-keyed reader of the old file ignores, where a cell inserted in the
 * middle moves `note` for every reader that has the old header memorised.
 */
export const DEPLOYS_HEADER = [
  'started', 'ended', 'sha', 'build', 'holder', 'outcome', 'live_commit', 'live_build', 'stopped_at', 'note',
];

export const RUNNING = 'running';
export const DEPLOYED = 'deployed';
export const FAILED = 'failed';
export const REFUSED = 'refused';

export function deploysPath(env = process.env) {
  return join(workRoot(env), 'runner', 'log', 'deploys.tsv');
}

export function tsvHeader() {
  return DEPLOYS_HEADER.join('\t');
}

/** Empty rather than `-` for what is not known: an unfinished deploy has no
 * `ended`, and a dash there reads like a value somebody wrote. */
function cell(value) {
  return String(value ?? '').replace(/[\t\r\n]/gu, ' ');
}

export function tsvRow(row, header = DEPLOYS_HEADER) {
  return header.map((name) => cell(row?.[name])).join('\t');
}

/** Every row, in file order, as objects keyed by the header the file carries. */
export function parseDeploys(tsv) {
  const lines = String(tsv || '').split('\n').filter((line) => line.trim());
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']));
  });
}

function readFile(env) {
  try { return readFileSync(deploysPath(env), 'utf8'); } catch { return ''; }
}

/** The header this file has, or the one it would be made with. */
function fileHeader(text) {
  const first = String(text || '').split('\n').find((line) => line.trim());
  return first ? first.split('\t') : DEPLOYS_HEADER;
}

export function readDeploys(env = process.env) {
  return parseDeploys(readFile(env));
}

/**
 * The last deploy that reached production — what the page, the brief and the
 * helper mean by "what is live". A `running` row is not it: something is being
 * deployed, and until it verifies, the previous one is still what is serving.
 */
export function lastDeploy(env = process.env) {
  return readDeploys(env).filter((row) => row.sha && row.outcome === DEPLOYED).at(-1) || null;
}

/** The last row of any outcome — including the deploy that is running now. */
export function lastAttempt(env = process.env) {
  return readDeploys(env).at(-1) || null;
}

function append(row, env) {
  const path = deploysPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const text = readFile(env);
  const header = text.trim() ? fileHeader(text) : null;
  if (!header) appendFileSync(path, `${tsvHeader()}\n`);
  appendFileSync(path, `${tsvRow(row, header || DEPLOYS_HEADER)}\n`);
  return row;
}

/**
 * The row that says a deploy has begun. Returns the key `recordEnd` completes
 * it by — `started` and `sha`, which no second deploy of the same tree in the
 * same millisecond could share, and two deploys at once cannot happen anyway
 * because the lease is held for the length of one.
 */
export function recordStart({
  sha, build = '', holder = '', started = new Date().toISOString(), note = '',
}, env = process.env) {
  const row = {
    started, ended: '', sha, build, holder, outcome: RUNNING,
    live_commit: '', live_build: '', stopped_at: '', note,
  };
  append(row, env);
  return { started, sha };
}

/**
 * Complete the row `recordStart` wrote: how it ended, what production says it
 * is now, and — when it failed — the step of `deploy.mjs` it stopped at.
 *
 * A key that matches nothing is written as a finished row of its own rather
 * than dropped. That is the case where the starting row could not be written
 * (a full disk, a read-only home) and losing the ending too would leave a
 * deploy that happened with no trace at all.
 */
export function recordEnd(key, patch = {}, env = process.env) {
  const text = readFile(env);
  const header = fileHeader(text);
  const rows = parseDeploys(text);
  const done = {
    ended: new Date().toISOString(),
    outcome: DEPLOYED,
    ...patch,
  };
  const index = rows.findLastIndex((row) => row.started === key?.started && row.sha === key?.sha);
  if (index === -1) {
    return append({ started: key?.started || done.ended, sha: key?.sha || '', ...done }, env);
  }
  rows[index] = { ...rows[index], ...done };
  const body = rows.map((row) => tsvRow(row, header)).join('\n');
  writeFileAtomic(deploysPath(env), `${header.join('\t')}\n${body}\n`);
  return rows[index];
}

/**
 * A deploy that did not start, written whole: begun and ended at the same
 * moment, with the reason in `note`. It is one row rather than a start and an
 * end because nothing happened in between.
 */
export function recordRefusal({ sha = '', holder = '', note = '', at = new Date().toISOString() }, env = process.env) {
  return append({
    started: at, ended: at, sha, build: '', holder, outcome: REFUSED,
    live_commit: '', live_build: '', stopped_at: '', note,
  }, env);
}

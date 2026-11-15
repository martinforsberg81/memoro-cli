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
 * A refusal is a row too (`recordRefusal`): a red gate, a deploy
 * already running, a repository somebody else holds. They are the deploys
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
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { processAlive } from './lease-owner.js';
import { workRoot } from './paths.js';
import { realLock } from './runner-lock.js';

/**
 * The columns. Append, never insert: a cell added at the end is one a
 * header-keyed reader of the old file ignores, where a cell inserted in the
 * middle moves `note` for every reader that has the old header memorised.
 */
export const DEPLOYS_HEADER = [
  'started', 'ended', 'sha', 'build', 'holder', 'outcome', 'live_commit', 'live_build', 'stopped_at', 'note', 'pid',
  'full_commit', 'full_verdict', 'suites', 'accepted_red', 'take_back', 'take_back_why',
  'versions_before', 'versions_made', 'versions_why',
  'check', 'check_at', 'check_why',
  'takes_back', 'takes_back_sha', 'takes_back_why',
];

/**
 * The gate's four columns (2026-11-14): the commit of the full run the deploy
 * stood on and its verdict (`green`, `red`, `stalled`, or `none` for a deploy
 * that was refused because no run measured that commit), each suite's result
 * as `name:state` joined by commas, and the reason `--accept-red` gave when a
 * red was accepted — empty otherwise, so an empty cell is a deploy that
 * accepted nothing.
 */
export const GATE_COLUMNS = ['full_commit', 'full_verdict', 'suites', 'accepted_red'];

/**
 * The take-back reading's two columns (2026-11-15): `take_back`, `yes` or `no`
 * — whether the release could be taken back, a reading that was not made being
 * `no` — and `take_back_why`, the reasons joined in one line, or
 * `reading not made: …`. Both are empty on a row written before the reading
 * was made (a refusal for a headless session or a pick that moves production
 * backwards) and on a row written before the columns existed.
 */
export const TAKE_BACK_COLUMNS = ['take_back', 'take_back_why'];

/**
 * The Worker versions of a deploy (2026-11-15), the two a take-back needs:
 * `versions_before`, the version each Worker served before the deploy, and
 * `versions_made`, the one the deploy made, each as `<worker>:<id>` joined by
 * commas, a Worker whose version is not known as `<worker>:missing`. A Worker
 * the deploy did not change has no entry in `versions_made`. `versions_why`
 * says why a version is missing, `<worker> before|made: <why>` joined by `; `,
 * or `not reported by the deploy script` when the script printed no version
 * line at all. All three are empty on a row written before the script ran and
 * on a row written before the columns existed.
 */
export const VERSION_COLUMNS = ['versions_before', 'versions_made', 'versions_why'];

/**
 * The three cells for what `readScriptOutput` read of the script's version
 * lines (`{ before, made, why }`): `{ memoro: '<id>', 'memoro-tail': null }`
 * is `memoro:<id>,memoro-tail:missing`.
 */
export function versionCells(versions) {
  const list = (found) => Object.entries(found || {}).map(([worker, id]) => `${worker}:${id ?? 'missing'}`).join(',');
  return {
    versions_before: list(versions?.before),
    versions_made: list(versions?.made),
    versions_why: (versions?.why || []).join('; '),
  };
}

/**
 * The check after a deploy (2026-11-15), three cells written by the runner's
 * check, never by the deploy: `check` — `green`, `red` or `could-not-run` —
 * `check_at`, the ISO time of the verdict, and `check_why`, each part that was
 * not green as `<part>: <reason>` joined by `; `, empty when green. All three
 * are empty on a row no check has judged, which is shown as not checked and is
 * never read as green.
 */
export const CHECK_COLUMNS = ['check', 'check_at', 'check_why'];

/**
 * The take-back's three cells (2026-11-15), written only on a take-back row — a
 * row the runner's red reaction or `mc deploy take-back` wrote: `takes_back`, the
 * `started` of the release row it took back; `takes_back_sha`, that release's
 * commit; `takes_back_why`, what asked for it (the runner: the release's
 * `check_why`; the verb: `typed: <reason>`). All three are empty on every other
 * row, which is how a take-back row is told from a release: a row with a
 * `takes_back` is one, whatever its outcome.
 */
export const TAKES_BACK_COLUMNS = ['takes_back', 'takes_back_sha', 'takes_back_why'];

/**
 * The headers earlier mc versions wrote, oldest first: before `pid`
 * (2026-10-07), before the gate's columns (2026-11-14), before the
 * take-back reading's and before the Worker versions' (both 2026-11-15),
 * before the check's (the header of 9a094dec) and before the take-back's. A file with exactly
 * one of them is given the current header the next time a row is written, its
 * old rows with the new cells empty: without `pid`, a deploy in progress could
 * never be told from one that died, which is the one thing that column is for.
 * Any other header is kept as it is, and drops what it has no room for.
 */
const PID_COLUMNS = DEPLOYS_HEADER.slice(0, DEPLOYS_HEADER.indexOf('pid') + 1);
const GATE_HEADER = DEPLOYS_HEADER.slice(0, DEPLOYS_HEADER.indexOf('accepted_red') + 1);
const TAKE_BACK_HEADER = DEPLOYS_HEADER.slice(0, DEPLOYS_HEADER.indexOf('take_back_why') + 1);
const VERSIONS_HEADER = DEPLOYS_HEADER.slice(0, DEPLOYS_HEADER.indexOf('versions_why') + 1);
const CHECK_HEADER = DEPLOYS_HEADER.slice(0, DEPLOYS_HEADER.indexOf('check_why') + 1);
const OLDER_HEADERS = [PID_COLUMNS.slice(0, -1), PID_COLUMNS, GATE_HEADER, TAKE_BACK_HEADER, VERSIONS_HEADER, CHECK_HEADER].map((header) => header.join('\t'));

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

/** The header this file has — the current one for a version of this file
 * before it — or the one it would be made with. */
function fileHeader(text) {
  const first = String(text || '').split('\n').find((line) => line.trim());
  if (!first) return DEPLOYS_HEADER;
  const header = first.split('\t');
  return OLDER_HEADERS.includes(header.join('\t')) ? DEPLOYS_HEADER : header;
}

function rewrite(env, header, rows) {
  const body = rows.map((row) => tsvRow(row, header)).join('\n');
  writeFileAtomic(deploysPath(env), `${header.join('\t')}\n${body ? `${body}\n` : ''}`);
}

export function readDeploys(env = process.env) {
  return parseDeploys(readFile(env));
}

/**
 * The last deploy that reached production — what the page, the brief and the
 * helper mean by "what is live". A `running` row is not it: something is being
 * deployed, and until it verifies, the previous one is still what is serving.
 */
/** Whether `row` is a take-back row: one the take-back wrote, whatever its outcome. */
export function isTakeBackRow(row) {
  return Boolean(row?.takes_back);
}

/**
 * The commits that were taken back — each `takes_back_sha` in the record, of any
 * outcome. A take-back that failed half-way may have moved production off that
 * commit, and one that succeeded did: either way the commit is not picked again
 * until a later commit is green (`pickCommit`'s floor).
 */
export function takenBackShas(rows) {
  return [...new Set((rows || []).filter(isTakeBackRow).map((row) => row.takes_back_sha).filter(Boolean))];
}

/** The take-back rows that name the release started at `started`, of any outcome, oldest first. */
export function takeBackRowsOf(rows, started) {
  return (rows || []).filter((row) => isTakeBackRow(row) && row.takes_back === started);
}

export function lastDeploy(env = process.env) {
  return readDeploys(env).filter((row) => row.sha && row.outcome === DEPLOYED).at(-1) || null;
}

/** The last row of any outcome — including the deploy that is running now. */
export function lastAttempt(env = process.env) {
  return readDeploys(env).at(-1) || null;
}

/**
 * Is the deploy this row records still going? `running` with no `ended`, and
 * the process that wrote it still there — asked of the kernel the way a
 * lease's owner is (`processAlive`, lease-owner.js). A row with no pid was
 * written by an mc before the column, or into a file with no room for it, and
 * nothing can say it is alive: it is what `closeAbandoned` closes.
 */
export function deployAlive(row, { alive = processAlive } = {}) {
  if (row?.outcome !== RUNNING || row.ended) return false;
  const pid = Number(row.pid);
  return Number.isInteger(pid) && pid > 0 && alive(pid) === true;
}

/**
 * The deploy in progress on this machine, or null: the last row `deployAlive`
 * says is. Since 2026-10-07 the lease no longer says a deploy is running — it
 * covers the fast-forward and the read of the sha, not the build — so this is
 * the fact two deploys are kept apart by.
 */
export function runningDeploy(env = process.env, { alive = processAlive } = {}) {
  return readDeploys(env).filter((row) => deployAlive(row, { alive })).at(-1) || null;
}

/**
 * Whether this process is inside `withDeploysLock`. `realLock` is an O_EXCL
 * file and not reentrant: a second take by the same process would wait out its
 * five seconds against itself. Every row writer asks for the lock through
 * `withDeploysLock`, and one called while the admission step of `mc deploy`
 * already holds it runs inside that hold.
 */
let holding = 0;

/**
 * Run `fn` — a read-patch-write of deploys.tsv — under the runner lock. Within
 * one process the lock is taken once and never nested: a call made while this
 * process holds it runs `fn` as it is. `lock` and `root` are the boundaries a
 * test passes (the admission step of `mc deploy` passes its own); the other
 * options are `realLock`'s (`strict`, `waitMs`, `alive`, …).
 */
export function withDeploysLock(env, fn, { lock = realLock, root = workRoot(env), name = 'deploys', ...options } = {}) {
  if (holding) return fn();
  holding += 1;
  try {
    return lock(root, fn, { name, ...options });
  } finally {
    holding -= 1;
  }
}

function append(row, env) {
  const path = deploysPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const text = readFile(env);
  const header = text.trim() ? fileHeader(text) : null;
  if (!header) appendFileSync(path, `${tsvHeader()}\n`);
  else if (header.join('\t') !== text.split('\n').find((line) => line.trim())) {
    // The file carries an older header: written once with the new one, and
    // appended to from then on.
    rewrite(env, header, parseDeploys(text));
  }
  appendFileSync(path, `${tsvRow(row, header || DEPLOYS_HEADER)}\n`);
  return row;
}

/**
 * The row that says a deploy has begun. Returns the key `recordEnd` completes
 * it by — `started` and `sha`, which no second deploy of the same tree in the
 * same millisecond could share, and two deploys at once cannot happen anyway:
 * the row is written under the lease, and the next deploy reads it under the
 * lease before it writes its own (`runningDeploy`). `pid` is the process the
 * deploy runs in, so that reader can tell a deploy going on from one that died.
 */
export function recordStart({
  sha, build = '', holder = '', started = new Date().toISOString(), note = '', pid = '', gate = {}, takeBack = {}, takesBack = {},
}, env = process.env) {
  const row = {
    started, ended: '', sha, build, holder, outcome: RUNNING,
    live_commit: '', live_build: '', stopped_at: '', note, pid, ...gateCells(gate), ...readingCells(takeBack), ...takesBackCells(takesBack),
  };
  withDeploysLock(env, () => append(row, env));
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
  return withDeploysLock(env, () => completeRow(key, patch, env));
}

function completeRow(key, patch, env) {
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
  rewrite(env, header, rows);
  return rows[index];
}

/**
 * A deploy that did not start, written whole: begun and ended at the same
 * moment, with the reason in `note`. It is one row rather than a start and an
 * end because nothing happened in between.
 */
export function recordRefusal({
  sha = '', holder = '', note = '', at = new Date().toISOString(), gate = {}, takeBack = {},
}, env = process.env) {
  return withDeploysLock(env, () => append({
    started: at, ended: at, sha, build: '', holder, outcome: REFUSED,
    live_commit: '', live_build: '', stopped_at: '', note, ...gateCells(gate), ...readingCells(takeBack),
  }, env));
}

/** The gate's cells of a row, from what the gate found; every one empty when it did not run. */
function gateCells(gate) {
  return Object.fromEntries(GATE_COLUMNS.map((name) => [name, gate?.[name] ?? '']));
}

/** The take-back row's three cells; every one empty on a row that took nothing back. */
function takesBackCells(takesBack) {
  return Object.fromEntries(TAKES_BACK_COLUMNS.map((name) => [name, takesBack?.[name] ?? '']));
}

/** The take-back cells of a row, from the reading's cells; both empty when none was made. */
function readingCells(takeBack) {
  return Object.fromEntries(TAKE_BACK_COLUMNS.map((name) => [name, takeBack?.[name] ?? '']));
}

/**
 * The rows still saying `running` whose process is gone, when a new deploy has
 * just taken the lease: the terminal closed, the laptop slept, the process was
 * killed before it could complete its row. A row whose process is alive is a
 * deploy in progress and is left alone — the caller has refused by then
 * (`runningDeploy`). They are marked `failed`, `ended` left empty — when it
 * stopped is not known — and the note says how it was found out, so the page
 * stops calling a deploy from yesterday the one that is running.
 *
 * Returns the rows it closed, as they were.
 */
export function closeAbandoned(options = {}, env = process.env) {
  return withDeploysLock(env, () => closeRows(options, env));
}

function closeRows({ at = new Date().toISOString(), alive = processAlive } = {}, env) {
  const text = readFile(env);
  const header = fileHeader(text);
  const rows = parseDeploys(text);
  const abandoned = rows.filter((row) => row.outcome === RUNNING && !row.ended && !deployAlive(row, { alive }));
  if (!abandoned.length) return [];
  const note = `never came back — its process was gone when the next deploy began at ${at}`;
  rewrite(env, header, rows.map((row) => (
    abandoned.includes(row) ? { ...row, outcome: FAILED, note: row.note ? `${row.note}; ${note}` : note } : row
  )));
  return abandoned;
}

/** What a file looked like when it was read: a write is only made over the same one. */
function fileStamp(env) {
  try { const { size, mtimeMs } = statSync(deploysPath(env)); return `${size}:${mtimeMs}`; } catch { return 'absent'; }
}

/**
 * The check's verdict, written into the row it judged: the three cells of
 * `CHECK_COLUMNS` and no other cell of any row. Returns `{ written: true, row }`,
 * or `{ written: false, why }` when the row is not there or the file changed
 * under every one of three attempts — then the verdict stays in its own file
 * (`deploy-check/<started>.verdict.json`) and the runner's chore writes it
 * into the row on a later pass.
 *
 * The lock is taken strict: a holder that does not let go in time throws, and
 * nothing is written. The file is written only if it is still the one that was
 * read (size and mtime) — a refusal appended by a writer that did not get the
 * lock in time is read again, never erased. `afterRead` is the boundary a test
 * uses to be that writer.
 */
export function recordCheck(key, cells, env = process.env, { afterRead = null, ...lockOptions } = {}) {
  return withDeploysLock(env, () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stamp = fileStamp(env);
      const text = readFile(env);
      const rows = parseDeploys(text);
      const index = rows.findLastIndex((row) => row.started === key?.started && row.sha === key?.sha);
      if (index === -1) return { written: false, why: 'the row is not in deploys.tsv' };
      afterRead?.(attempt);
      if (fileStamp(env) !== stamp) continue;
      const header = fileHeader(text);
      rows[index] = { ...rows[index], ...Object.fromEntries(CHECK_COLUMNS.map((name) => [name, cells?.[name] ?? ''])) };
      rewrite(env, header, rows);
      return { written: true, row: rows[index] };
    }
    return { written: false, why: 'deploys.tsv changed under every attempt to write the verdict' };
  }, { strict: true, ...lockOptions });
}

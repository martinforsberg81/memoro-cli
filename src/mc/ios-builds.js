/**
 * `~/mc/runner/log/ios-builds.tsv` — every iOS binary mc built, and the ones
 * built before it existed.
 *
 * The shape is `deploys.tsv`'s (`deploys.js`): a header written once when the
 * file is made, rows appended whole, a row that exists before the build does
 * (`recordStart`, `outcome: running`) and is completed however it ends
 * (`recordEnd`), read back keyed by the header the file actually carries. The
 * TSV cell and row helpers are that module's own, imported rather than copied.
 *
 * What it adds is `lastShipped`: the binary people have on their phones, which
 * is what `mc build ios` compares the commit production runs against. A
 * TestFlight upload is one, and so is a `seed` row — a build made before the
 * verb existed, recorded by hand with `mc build ios --shipped <build> <sha>`.
 *
 * Every write is under the register's lock (`realLock`, register.js): a build
 * runs in its own process, and its row is completed while the asking terminal
 * or another `mc build ios` may be writing.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { parseDeploys as parseRows, tsvRow } from './deploys.js';
import { processAlive } from './lease-owner.js';
import { workRoot } from './paths.js';
import { realLock } from './register.js';

/** The columns. Append, never insert — as in `DEPLOYS_HEADER`. */
export const IOS_BUILDS_HEADER = [
  'started', 'ended', 'sha', 'kind', 'version', 'build', 'live_commit', 'outcome', 'stopped_at', 'note',
  'artifact', 'delivery', 'pid',
];

export const SEED = 'seed';
export const DEVICE = 'device';
export const TESTFLIGHT = 'testflight';

export const RUNNING = 'running';
export const INSTALLED = 'installed';
export const BUILT = 'built';
export const UPLOADED = 'uploaded';
export const FAILED = 'failed';
export const REFUSED = 'refused';

export function iosBuildsPath(env = process.env) {
  return join(workRoot(env), 'runner', 'log', 'ios-builds.tsv');
}

export function parseIosBuilds(tsv) {
  return parseRows(tsv);
}

function readFile(env) {
  try { return readFileSync(iosBuildsPath(env), 'utf8'); } catch { return ''; }
}

function fileHeader(text) {
  const first = String(text || '').split('\n').find((line) => line.trim());
  return first ? first.split('\t') : IOS_BUILDS_HEADER;
}

function locked(env, fn) {
  return realLock(workRoot(env), fn);
}

function append(row, env) {
  const path = iosBuildsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const text = readFile(env);
  if (!text.trim()) appendFileSync(path, `${IOS_BUILDS_HEADER.join('\t')}\n`);
  appendFileSync(path, `${tsvRow(row, fileHeader(text))}\n`);
  return row;
}

export function readIosBuilds(env = process.env) {
  return parseIosBuilds(readFile(env));
}

/**
 * The row that says a build has begun, written before anything is built.
 * Returns the key `recordEnd` completes it by: `started` and `sha`.
 */
export function recordStart({
  sha, kind, version = '', build = '', live_commit = '', started = new Date().toISOString(),
  outcome = RUNNING, ended = '', note = '', artifact = '', delivery = '', pid = '',
}, env = process.env) {
  const row = {
    started, ended, sha, kind, version, build, live_commit, outcome, stopped_at: '', note, artifact, delivery, pid,
  };
  locked(env, () => append(row, env));
  return { started, sha };
}

/**
 * Complete the row `recordStart` wrote. A key that matches nothing is written
 * as a finished row of its own rather than dropped, as in deploys.js.
 */
export function recordEnd(key, fields = {}, env = process.env) {
  return locked(env, () => {
    const text = readFile(env);
    const header = fileHeader(text);
    const rows = parseIosBuilds(text);
    const done = { ended: new Date().toISOString(), ...fields };
    const index = rows.findLastIndex((row) => row.started === key?.started && row.sha === key?.sha);
    if (index === -1) return append({ started: key?.started || done.ended, sha: key?.sha || '', ...done }, env);
    rows[index] = { ...rows[index], ...done };
    const body = rows.map((row) => tsvRow(row, header)).join('\n');
    writeFileAtomic(iosBuildsPath(env), `${header.join('\t')}\n${body}\n`);
    return rows[index];
  });
}

/**
 * Name the builder's process on the row `recordStart` wrote before it was
 * started. Only a row still `running`: a builder that already completed its
 * row is not reopened. The completed row, or null when nothing was written.
 */
export function recordPid(key, pid, env = process.env) {
  return locked(env, () => {
    const text = readFile(env);
    const header = fileHeader(text);
    const rows = parseIosBuilds(text);
    const index = rows.findLastIndex((row) => row.started === key?.started && row.sha === key?.sha);
    if (index === -1 || rows[index].outcome !== RUNNING || rows[index].ended) return null;
    rows[index] = { ...rows[index], pid: String(pid) };
    const body = rows.map((row) => tsvRow(row, header)).join('\n');
    writeFileAtomic(iosBuildsPath(env), `${header.join('\t')}\n${body}\n`);
    return rows[index];
  });
}

/** The build in progress on this machine: the last `running` row with no
 * `ended` whose process is still there, or null. */
export function runningIosBuild(env = process.env, { alive = processAlive } = {}) {
  return readIosBuilds(env).filter((row) => {
    if (row.outcome !== RUNNING || row.ended) return false;
    const pid = Number(row.pid);
    return Number.isInteger(pid) && pid > 0 && alive(pid) === true;
  }).at(-1) || null;
}

/**
 * The binary that is out there: the last TestFlight upload or seed, whichever
 * was written later. A device build is not one — it is on one phone — and
 * neither is a TestFlight build that was built and never uploaded.
 */
export function lastShipped(env = process.env) {
  return readIosBuilds(env).filter((row) => row.sha && (
    (row.kind === TESTFLIGHT && row.outcome === UPLOADED) || row.kind === SEED
  )).at(-1) || null;
}

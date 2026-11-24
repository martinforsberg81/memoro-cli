/**
 * The deploy's preparation: everything `mc deploy` does before its
 * deployer, in a process of its own.
 *
 * The full run of the commit that would ship and the suites against a local
 * server of it take tens of minutes. They used to run in the process that was
 * asked to deploy — the terminal's, or the page's — and on 2026-11-14 a deploy
 * started from the page over SSH died with the connection: the round had a
 * start and no end, and the work was lost. The preparation is now a detached
 * process (`deploy-prepare-run.js`, started by `startPreparerDefault` in
 * `commands/deploy.js`) with a record on disk, `runner/deploy-prepare.json`,
 * that any later `mc deploy`, and the page, find again:
 *
 *   `{ sha, pid, started, stage, log, accept_red, holder, ended, result, error, output_dir }`
 *
 * `output_dir` is where the whole output of each suite and command of this
 * preparation is (`gate-output.js`, `<suite>.log`); a record written before
 * it was kept has none, and its suites carry no `output_path`.
 *
 * `stage` is `starting`, `full-run`, `suites` or `done`. `result` is the gate's
 * two measurements, `{ full, exercise }`, exactly as `measureGate` made them;
 * the judging — the refusals, `--accept-red`, the lines — is the asker's, so a
 * preparation measures and decides nothing. Joining one judges it the same way. A record whose pid is gone and which has no `ended` is a
 * preparation that was interrupted (its process was killed); the next
 * `mc deploy` of that commit starts a new one.
 *
 * A person stops one with `mc deploy --stop-preparation "<reason>"`, which
 * writes `ended`, `result: 'stopped'` and `reason` into the record before it
 * signals the preparer. Such a record is `stopped`, not `interrupted`: nothing
 * technical went wrong, so no mend is asked, and the preparer's own end never
 * writes over it (`patchPreparation`).
 *
 * Each preparation writes its own log, `runner/log/deploy-prepare-<started>.log`,
 * which its record names as `log`; a preparer removes such logs older than
 * `PREPARATION_LOG_DAYS` when it starts, unless the record or an open deploy
 * mend names them (`prunePreparationLogs`).
 *
 * One record, the latest preparation. A preparation superseded by a newer one
 * (main moved) goes on to the end — its full run is written to the history
 * like any other — but no longer writes the record.
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { measureGate } from './deploy-gate.js';
import { readDeployMends, UNFINISHED } from './deploy-repair.js';
import { changeRelease } from './release-return.js';
import { outputDir } from './gate-output.js';
import { processAlive } from './lease-owner.js';
import { readLinuxIdentity } from './linux-runner-service.js';
import { realLock } from './runner-lock.js';

export const PREPARATION_SCHEMA = 'mc-deploy-prepare';

/** A record with no pid yet is a start in progress for this long, then an interruption. */
export const START_GRACE_MS = 60 * 1000;

/** A preparation that has said nothing for this long says that it is still going. */
export const PREPARE_BEAT_MS = 60 * 1000;

const realBeat = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export const STAGES = Object.freeze(['starting', 'full-run', 'suites', 'done']);

/** The words the page and the terminal use for a stage. */
export const STAGE_WORDS = Object.freeze({
  starting: 'starting',
  'full-run': 'the full run',
  suites: 'the suites against a local server',
  done: 'done',
});

export function preparationPath(root) {
  return join(root, 'runner', 'deploy-prepare.json');
}

/** A preparation's log is kept this many days after its last write. */
export const PREPARATION_LOG_DAYS = 30;

const LOG_NAME = /^deploy-prepare-.+\.log$/u;

/**
 * What the preparation started at `started` says while it runs, one file per
 * preparation beside `deploy.log`. Without `started`, the one shared file the
 * preparations wrote before each had its own: a record from then names it.
 */
export function preparationLogPath(root, started = null) {
  const dir = join(root, 'runner', 'log');
  if (!started) return join(dir, 'deploy-prepare.log');
  return join(dir, `deploy-prepare-${String(started).replace(/[^0-9A-Za-z._-]/gu, '-')}.log`);
}

/** The log a preparation record names, or the shared one a record from before per-preparation logs used. */
export function recordLogPath(root, record) {
  return record?.log || preparationLogPath(root);
}

// Keep per-start details beside the log even if a newer preparation takes the
// register. A watcher must still see an intentional stop, and a stop must
// still see local suite and server groups after their starter leaves.
const detailsPath = (root, started) => `${preparationLogPath(root, started)}.json`;

export function preparationDetails(root, started) {
  try { return JSON.parse(readFileSync(detailsPath(root, started), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

/** Called while holding the preparation register. */
export function archivePreparationStop(root, record) {
  writeJsonAtomic(detailsPath(root, record.started), {
    ...preparationDetails(root, record.started), stop: record,
  }, { mode: 0o600 });
}

function recordLocalGroup(job, pgid, lock) {
  const identity = readLinuxIdentity(pgid);
  lock(job.root, () => {
    const details = preparationDetails(job.root, job.started);
    writeJsonAtomic(detailsPath(job.root, job.started), {
      ...details, groups: { ...details.groups, [pgid]: identity },
    }, { mode: 0o600 });
  }, { name: 'deploy-prepare', strict: true });
}

/**
 * Remove the preparations' own logs not written for `days` days, except the
 * one the current record names and those an open deploy mend names (the mend
 * keeps a copy, and its row names the file). Never throws: a log that stays is
 * only disk. The removed paths.
 */
export function prunePreparationLogs(root, {
  now = Date.now(), days = PREPARATION_LOG_DAYS, record = readPreparation(root), mends = null,
} = {}) {
  const dir = join(root, 'runner', 'log');
  const keep = new Set();
  if (record?.log) keep.add(basename(record.log));
  try {
    for (const entry of mends ?? readDeployMends({ root })) {
      if (!UNFINISHED.includes(entry.state)) continue;
      for (const row of entry.rows || []) for (const name of row.logs || []) keep.add(name);
    }
  } catch { /* an unreadable mend file names nothing; nothing is removed that it might */ return []; }
  const removed = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    if (!LOG_NAME.test(name) || keep.has(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs <= days * 24 * 60 * 60 * 1000) continue;
      rmSync(path, { force: true });
      rmSync(`${path}.json`, { force: true });
      removed.push(path);
    } catch { /* gone already, or not ours to remove */ }
  }
  return removed;
}

/** The record, or null: absent, unreadable or another schema all read as none. */
export function readPreparation(root) {
  try {
    const record = JSON.parse(readFileSync(preparationPath(root), 'utf8'));
    return record?.schema === PREPARATION_SCHEMA && record.sha ? record : null;
  } catch {
    return null;
  }
}

/**
 * `running`, `done`, `failed` (it ended on an error of its own), `stopped` (a
 * person stopped it, `mc deploy --stop-preparation`) or `interrupted` (no end,
 * and its process is gone) — null for no record.
 */
export function preparationState(record, { alive = processAlive, now = Date.now() } = {}) {
  if (!record) return null;
  if (record.ended) return record.result === 'stopped' ? 'stopped' : record.error ? 'failed' : 'done';
  const live = record.pid ? alive(record.pid) : now - Date.parse(record.started) < START_GRACE_MS;
  return live ? 'running' : 'interrupted';
}

/**
 * Whether a finished preparation answers an asker's flags: the suites are only
 * run for a red full run when `--accept-red` wants them, so one that skipped
 * them does not serve a deploy that accepts the red.
 */
export function preparationServes(record, { acceptRed = false } = {}) {
  const result = record?.result;
  if (!result?.full) return false;
  return !needsExercise(result.full, acceptRed) || Boolean(result.exercise);
}

/** The suites are run unless the full run already refuses the deploy (and nobody accepts that). */
export function needsExercise(full, acceptRed) {
  if (full.state === 'unmeasured' || full.state === 'moved') return false;
  if ((full.state === 'red' || full.state === 'stalled') && !acceptRed) return false;
  return true;
}

/** Write the record whole, atomically. Never throws: a record that cannot be written is a preparation nobody can join. */
export function writePreparation(root, record) {
  try {
    writeJsonAtomic(preparationPath(root), { schema: PREPARATION_SCHEMA, ...record }, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Patch the record of the preparation started at `started`. A record of another
 * start — a newer preparation took over — is left alone, and so is one a person
 * stopped: the stop is its end, and the preparer's own end writes nothing over it.
 */
export function patchPreparation(root, started, fields, { lock = realLock } = {}) {
  return lock(root, () => {
    const record = readPreparation(root);
    if (!record || record.started !== started) return false;
    if (record.result === 'stopped') return false;
    return writePreparation(root, { ...record, ...fields });
  }, { name: 'deploy-prepare', strict: true });
}

/**
 * The preparer's body, run by `deploy-prepare-run.js` in its own process (and
 * by a test, in this one). Measures the commit — the full run, then the app
 * used — saying what it does on `stdout`, which is the log, and writes the
 * result into the record. 0 when it measured (whatever it found), 1 when it
 * could not.
 *
 * `signal` is the stop: `deploy-prepare-run.js` aborts it on SIGTERM or SIGHUP,
 * which `mc deploy --stop-preparation` sends after it wrote the stop into the
 * record. The full run is ended through it, as the repository ceiling ends one,
 * and the preparation then writes nothing of its own end.
 */
export async function prepare(job, {
  stdout = process.stdout, env = process.env, deps = {}, now = () => new Date(), lock = realLock,
  beat = realBeat, beatMs = PREPARE_BEAT_MS, signal = null,
} = {}) {
  // Whatever stage it is in, a measurement that says nothing for a minute says
  // that it is going on, how long, and in which stage: a long run never looks
  // stuck to whoever watches the log or the page. The stages' own progress
  // (files done of files, reds so far) comes between these lines.
  const began = now().getTime();
  let lastSaid = began;
  let stage = 'starting';
  const say = (line) => { lastSaid = now().getTime(); stdout.write(`${line}\n`); };
  const patch = (fields) => patchPreparation(job.root, job.started, fields, { lock });
  const stop = beat(() => {
    const at = now().getTime();
    if (at - lastSaid < beatMs - 1000) return;
    say(`mc: still preparing — ${STAGE_WORDS[stage] || stage}, ${Math.round((at - began) / 60000)} min so far`);
  }, beatMs);
  const stopped = () => {
    if (!signal?.aborted) return false;
    say('mc: the preparation was stopped');
    return true;
  };
  // The logs of earlier preparations, a month old, go now.
  prunePreparationLogs(job.root, { now: began });
  try {
    // Every suite writes its whole output here as it runs; the record says where.
    const dir = outputDir(job.root, job.started);
    patch({ output_dir: dir });
    const measured = await measureGate({
      sha: job.sha, path: job.path, acceptRed: Boolean(job.acceptRed), own: Boolean(job.ownWorktree), branch: job.branch, env, say,
      outputDir: dir, recorded: job.recorded, deferMainRepair: job.deferMainRepair, signal, preparation: job.started,
      onLocalSpawn: signal ? (pgid) => recordLocalGroup(job, pgid, lock) : null,
      deps: deps.gate || {}, suites: deps.suites || {}, stage: (next, full) => {
        stage = next;
        if (job.release && next === 'suites' && full.state === 'green') {
          changeRelease(job.release, { root: job.root, env }, (r) => !r.drop_reason && r.activity
            ? { ...r, state: 'green', state_at: now().toISOString(), reds: [] } : null);
        }
        return patch({ stage: next });
      },
    });
    if (stopped()) return 1;
    patch({ stage: 'done', ended: now().toISOString(), result: measured });
    say('mc: the preparation is done');
    return 0;
  } catch (error) {
    if (stopped()) return 1;
    const message = error?.message || String(error);
    patch({ stage: 'done', ended: now().toISOString(), error: message });
    say(`mc: the preparation failed — ${message}`);
    return 1;
  } finally {
    stop();
  }
}

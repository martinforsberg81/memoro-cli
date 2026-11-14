/**
 * The deploy's preparation: everything `mc deploy` does before its one
 * question, in a process of its own.
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
 *   `{ sha, pid, started, stage, log, accept_red, holder, ended, result, error }`
 *
 * `stage` is `starting`, `full-run`, `suites` or `done`. `result` is the gate's
 * two measurements, `{ full, exercise }`, exactly as `measureGate` made them;
 * the judging — the refusals, `--accept-red`, the lines — is the asker's, so a
 * preparation measures and decides nothing. Joining one asks the same single
 * question. A record whose pid is gone and which has no `ended` is a
 * preparation that was interrupted (its process was killed); the next
 * `mc deploy` of that commit starts a new one.
 *
 * One record, the latest preparation. A preparation superseded by a newer one
 * (main moved) goes on to the end — its full run is written to the history
 * like any other — but no longer writes the record.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { measureGate } from './deploy-gate.js';
import { processAlive } from './lease-owner.js';
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

/** What the preparation says while it runs: the same file `deploy.log` is, one level down. */
export function preparationLogPath(root) {
  return join(root, 'runner', 'log', 'deploy-prepare.log');
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
 * `running`, `done`, `failed` (it ended on an error of its own) or
 * `interrupted` (no end, and its process is gone) — null for no record.
 */
export function preparationState(record, { alive = processAlive, now = Date.now() } = {}) {
  if (!record) return null;
  if (record.ended) return record.error ? 'failed' : 'done';
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
 * start — a newer preparation took over — is left alone.
 */
export function patchPreparation(root, started, fields, { lock = realLock } = {}) {
  return lock(root, () => {
    const record = readPreparation(root);
    if (!record || record.started !== started) return false;
    return writePreparation(root, { ...record, ...fields });
  }, { name: 'deploy-prepare' });
}

/**
 * The preparer's body, run by `deploy-prepare-run.js` in its own process (and
 * by a test, in this one). Measures the commit — the full run, then the app
 * used — saying what it does on `stdout`, which is the log, and writes the
 * result into the record. 0 when it measured (whatever it found), 1 when it
 * could not.
 */
export async function prepare(job, {
  stdout = process.stdout, env = process.env, deps = {}, now = () => new Date(), lock = realLock,
  beat = realBeat, beatMs = PREPARE_BEAT_MS,
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
  try {
    const measured = await measureGate({
      sha: job.sha, path: job.path, acceptRed: Boolean(job.acceptRed), env, say,
      deps: deps.gate || {}, suites: deps.suites || {}, stage: (next) => { stage = next; return patch({ stage: next }); },
    });
    patch({ stage: 'done', ended: now().toISOString(), result: measured });
    say('mc: the preparation is done');
    return 0;
  } catch (error) {
    const message = error?.message || String(error);
    patch({ stage: 'done', ended: now().toISOString(), error: message });
    say(`mc: the preparation failed — ${message}`);
    return 1;
  } finally {
    stop();
  }
}

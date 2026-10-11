/**
 * `~/mc/runner/log/language/runs/` — every `mc language run`, written as it
 * happens.
 *
 * One JSON file per run, rewritten whole (`writeFileAtomic`) on every change,
 * so a reader sees the run before or after an act, never half-way. It follows
 * the deploy record (`deploys.js`): the run exists, saying `running`, before
 * the first child starts, and an act's execute row is written `running` before
 * its child is started and completed after. A run that died half-way — the
 * terminal closed, the laptop slept — is then a record that says so, and
 * `mc language resume` knows which write it was in.
 *
 *   { manifest, lang, sha, started, ended, pid, holder, outcome, dry_run,
 *     resumes, note, acts: [{ id, phase, outcome, started, ended, observed,
 *     note, opens_gap }] }
 *
 * `outcome` is running|done|stopped|failed|refused for the run and
 * running|passed|deviated|declined|failed|done for an act. An act row carries
 * the manifest's `opens_gap` when it has one, so the page can say a gap is
 * open from the records alone (`openGap`).
 *
 * A language run and a deploy never write at the same time: each reads the
 * other's record under the register's lock before it writes its own
 * (`liveRun` here, `runningDeploy` in deploys.js).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { processAlive } from './lease-owner.js';
import { workRoot } from './paths.js';

export const RUNNING = 'running';
export const DONE = 'done';
export const STOPPED = 'stopped';
export const FAILED = 'failed';
export const REFUSED = 'refused';

function languageRoot(env) {
  return join(workRoot(env), 'runner', 'log', 'language');
}

export function runsDir(env = process.env) {
  return join(languageRoot(env), 'runs');
}

/** `<started>-<manifest>`, with the timestamp's colons and dot made plain. */
export function runStem(run) {
  return `${String(run.started).replace(/[:.]/gu, '-')}-${run.manifest}`;
}

export function runPath(run, env = process.env) {
  return join(runsDir(env), `${runStem(run)}.json`);
}

export function writeRun(run, env = process.env) {
  writeFileAtomic(runPath(run, env), `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

/** Every run on disk, oldest first. */
export function readRuns(env = process.env) {
  const dir = runsDir(env);
  let files = [];
  try { files = readdirSync(dir).filter((file) => file.endsWith('.json')); } catch { return []; }
  const runs = [];
  for (const file of files) {
    try {
      const run = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (run?.manifest && run.started) runs.push(run);
    } catch { /* a file that is not a run is not one */ }
  }
  return runs.sort((a, b) => String(a.started).localeCompare(String(b.started)));
}

/** The record of a run that has begun. Written before anything is started. */
export function startRun({
  manifest, lang, sha = '', holder = '', pid = process.pid, started = new Date().toISOString(),
  dryRun = false, resumes = null,
}, env = process.env) {
  const run = {
    manifest, lang, sha, started, ended: null, pid, holder, outcome: RUNNING,
    dry_run: dryRun, resumes, note: '', acts: [],
  };
  return writeRun(run, env);
}

/** The run, ended: its outcome and why. */
export function endRun(run, { outcome, note = '' }, env = process.env) {
  run.outcome = outcome;
  run.ended = new Date().toISOString();
  if (note) run.note = run.note ? `${run.note}; ${note}` : note;
  return writeRun(run, env);
}

/** One act's row, written `running` before its child starts. */
export function actStart(run, { id, phase, opens_gap = null }, env = process.env) {
  const row = {
    id, phase, outcome: RUNNING, started: new Date().toISOString(), ended: null, observed: {}, note: '',
  };
  if (opens_gap) row.opens_gap = opens_gap;
  run.acts.push(row);
  writeRun(run, env);
  return row;
}

/** The row `actStart` wrote, completed. */
export function actEnd(run, row, { outcome, observed, note }, env = process.env) {
  row.outcome = outcome;
  row.ended = new Date().toISOString();
  if (observed) row.observed = observed;
  if (note) row.note = note;
  writeRun(run, env);
  return row;
}

/**
 * Is this run still going? `running` with no `ended`, and the process that
 * wrote it still there — the question `deployAlive` asks of a deploy's row.
 */
export function runAlive(run, { alive = processAlive } = {}) {
  if (run?.outcome !== RUNNING || run.ended) return false;
  const pid = Number(run.pid);
  return Number.isInteger(pid) && pid > 0 && alive(pid) === true;
}

/** The language run in progress on this machine, or null. */
export function liveRun(env = process.env, { alive = processAlive } = {}) {
  return readRuns(env).filter((run) => runAlive(run, { alive })).at(-1) || null;
}

/** The newest run, of one manifest when named. */
export function lastRun(env = process.env, { manifest } = {}) {
  return readRuns(env).filter((run) => !manifest || run.manifest === manifest).at(-1) || null;
}

/**
 * The runs still saying `running` whose process is gone, marked `failed`, as
 * `closeAbandoned` in deploys.js does with a deploy's row. Returns them.
 */
export function closeAbandoned({ at = new Date().toISOString(), alive = processAlive } = {}, env = process.env) {
  const abandoned = readRuns(env).filter((run) => run.outcome === RUNNING && !run.ended && !runAlive(run, { alive }));
  const note = `never came back — its process was gone when the next run began at ${at}`;
  for (const run of abandoned) {
    // An act left `running` died with it: resume reads it as the interrupted one.
    for (const act of run.acts || []) if (act.outcome === RUNNING) act.outcome = FAILED;
    writeRun({ ...run, outcome: FAILED, note: run.note ? `${run.note}; ${note}` : note }, env);
  }
  return abandoned;
}

/** The run and the runs it resumes, newest first. */
export function runChain(run, runs) {
  const chain = [];
  let at = run;
  while (at && !chain.includes(at)) {
    chain.push(at);
    at = at.resumes ? runs.find((other) => other.started === at.resumes && other.manifest === run.manifest) : null;
  }
  return chain;
}

/** The ids whose execute is `done` anywhere in the run's chain. */
export function doneExecutes(run, runs = [run]) {
  const done = new Set();
  for (const link of runChain(run, runs)) {
    for (const act of link.acts || []) if (act.phase === 'execute' && act.outcome === DONE) done.add(act.id);
  }
  return done;
}

/**
 * The gap a run left open: the newest run that wrote anything, whose last
 * done execute is an act with `opens_gap`, and whose `until` act has no done
 * execute in that run or the runs it resumes. `{ run, act, says }` or null.
 */
export function openGap(env = process.env) {
  const runs = readRuns(env);
  const run = runs.filter((each) => !each.dry_run
    && (each.acts || []).some((act) => act.phase === 'execute' && act.outcome === DONE)).at(-1);
  if (!run) return null;
  const last = run.acts.filter((act) => act.phase === 'execute' && act.outcome === DONE).at(-1);
  if (!last?.opens_gap) return null;
  if (doneExecutes(run, runs).has(last.opens_gap.until)) return null;
  return { run, act: last.id, says: last.opens_gap.says };
}

/** Every cached `mc language status` reading, by language. */
export function cachedReadings(env = process.env) {
  const dir = languageRoot(env);
  let files = [];
  try { files = readdirSync(dir); } catch { return {}; }
  const out = {};
  for (const file of files) {
    const match = /^status-([a-z]{2,3})\.json$/u.exec(file);
    if (!match) continue;
    try { out[match[1]] = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { /* not a reading */ }
  }
  return out;
}

/** A read's field, or null when the read failed or never ran. */
const field = (read, name) => (read?.ok ? read[name] ?? null : null);

/**
 * The language side in one object, for the page and `mc deploy --dry-run`:
 * each cached reading's numbers, the newest run, and the gap a run left open.
 * File reads only — nothing is run and nothing is asked.
 */
export function languageState(env = process.env) {
  const readings = cachedReadings(env);
  const languages = Object.keys(readings).sort().map((lang) => {
    const reads = readings[lang]?.reads || {};
    return {
      lang,
      read_at: readings[lang]?.at || null,
      unresolved: field(reads.selectors, 'unresolved'),
      without_usable: field(reads.selectors, 'without_usable'),
      waiting_rows: field(reads.grammar, 'waiting'),
      forms: field(reads.forms, 'forms'),
    };
  });
  const last = lastRun(env);
  const gap = openGap(env);
  return {
    languages,
    last_run: last
      ? {
        manifest: last.manifest, lang: last.lang, outcome: last.outcome, started: last.started,
        ended: last.ended, dry_run: Boolean(last.dry_run),
      }
      : null,
    open_gap: gap ? { manifest: gap.run.manifest, act: gap.act, says: gap.says, started: gap.run.started } : null,
  };
}

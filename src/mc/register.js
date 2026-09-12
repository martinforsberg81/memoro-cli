/**
 * The register — where a project's *state* lives, as opposed to its plan.
 *
 * A `PLAN.json` on `main` is a document: goal, contract, scope, criteria and
 * the steps' instructions, written by a person and changed rarely. The state
 * of the work — which step is running, which is done, which failed and why,
 * on what branch, in which pull request — is process, changes at every step
 * boundary, and has to be visible the second it changes. Until 2026-09-12 it
 * lived inside the plan file, so every transition was a pull request through
 * the gate: a step finishing was a code PR, a step the runner could not start
 * was a docs PR the runner landed itself, a step set `ready` again was a docs
 * PR from the brief, and a step that failed had no way to main at all. Every
 * reader then needed a fetch to not lie, every session had to be checked for
 * editing more of the file than its own step, two branches editing one file
 * needed a three-way plan merge, and the runner kept `held.json`,
 * `merges.json` and `current-*.json` beside the plan for the state the file
 * could not hold between a session ending and its pull request landing.
 *
 * Martin, 2026-09-12: *"Någonting i hela designen av mc/git-integrationen/
 * runner är helt fel. Vi diskuterar detaljer som inte ska behöva diskuteras
 * med rätt design."* and, on the principle — instructions in git, state in a
 * register mc owns, one writer, never a merge — *"Ok på registret."*
 *
 * So: one file per project, `~/mc/runner/projects/<project>.json`, written
 * whole and atomically, holding one entry per step keyed by the step's index
 * in the plan. The plan on `main` is still what says what a step *is*; the
 * register says where it *stands*. Readers join the two (`overlayPlans`) and
 * see the same plan record they always saw, with the register's word for
 * `status`, `pr`, `blocked_by` and `comments` — so the picker, the page, the
 * brief and `mc status` change their source and not their shape.
 *
 * The state fields a plan file still carries are read exactly once: the first
 * time a plan is seen with no entry in the register, the entry is seeded from
 * them (`seedEntry`). After that the file's copies are ignored, and they go
 * from the schema when the last reader of them does.
 *
 * Everything below the IO line is pure over entries and plan records, so the
 * rules are tested without a file.
 */
import { closeSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { planSummary } from './plan-schema.js';

export const REGISTER_SCHEMA = 'mc-register';
export const REGISTER_VERSION = 1;
export const REGISTER_DIR = 'projects';

/**
 * Where a step stands. `ready` the runner may hand it out; `running` a
 * session is on it (`session.pid` says which); `done` its pull request
 * landed on main; `failed` its session ended without landing — the pull
 * request, if any, is open and `reason` says what happened; `blocked` it
 * waits on something named in `blocked_by`. A `failed` or `blocked` step is
 * a person's: the runner never retries one, and the way back is `mc step
 * ready` (ruling 21).
 */
export const STEP_STATES = Object.freeze(['ready', 'running', 'done', 'failed', 'blocked']);

export function registerDir(root) {
  return join(root, 'runner', REGISTER_DIR);
}

export function registerPath(root, project) {
  return join(registerDir(root), `${project}.json`);
}

/* --------------------------------------------------------------- entries */

/** A step nobody has touched: ready, on nothing, with nothing to say. */
export function emptyStep() {
  return {
    status: 'ready', pr: null, branch: null, blocked_by: null, reason: null, comments: [],
    session: null, attempts: 0, landed: null, updated: null,
  };
}

const int = (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const prose = (value) => (Array.isArray(value) ? value.filter((p) => typeof p === 'string' && p.trim()).map(String) : []);

/** One step, whatever an older file or a hand edit left in it. */
function normaliseStep(step) {
  const base = emptyStep();
  if (!plain(step)) return base;
  const status = STEP_STATES.includes(step.status) ? step.status : 'ready';
  return {
    ...base,
    status,
    pr: int(step.pr),
    branch: typeof step.branch === 'string' && step.branch ? step.branch : null,
    blocked_by: plain(step.blocked_by) && typeof step.blocked_by.kind === 'string' && typeof step.blocked_by.name === 'string'
      ? { kind: step.blocked_by.kind, name: step.blocked_by.name }
      : null,
    reason: typeof step.reason === 'string' && step.reason.trim() ? step.reason : null,
    comments: prose(step.comments),
    session: plain(step.session) ? { ...step.session } : null,
    attempts: Number.isInteger(step.attempts) && step.attempts >= 0 ? step.attempts : 0,
    landed: plain(step.landed) ? { ...step.landed } : null,
    updated: typeof step.updated === 'string' ? step.updated : null,
  };
}

/** A whole entry, normalised. Null for anything that is not one. */
export function normaliseEntry(value) {
  if (!plain(value) || typeof value.project !== 'string' || !value.project) return null;
  return {
    schema: REGISTER_SCHEMA,
    version: REGISTER_VERSION,
    project: value.project,
    repo: typeof value.repo === 'string' ? value.repo : null,
    programme: typeof value.programme === 'string' ? value.programme : null,
    plan: typeof value.plan === 'string' ? value.plan : null,
    updated: typeof value.updated === 'string' ? value.updated : null,
    steps: Array.isArray(value.steps) ? value.steps.map(normaliseStep) : [],
  };
}

/** The file's text, read the way every reader reads it: unreadable is no entry. */
export function parseEntry(text) {
  if (text == null) return null;
  try { return normaliseEntry(JSON.parse(text)); } catch { return null; }
}

/**
 * The status a plan file's step carries, as the register's word for it. The
 * file knows `ready`, `done` and `blocked`; anything else it might carry from
 * an older schema reads as `ready`, which is what the runner did with it.
 */
function stateOf(fileStep) {
  const status = fileStep?.status;
  if (status === 'done' || status === 'blocked') return status;
  return 'ready';
}

/** One step, as the plan file describes it — the seed for a step the register has never seen. */
function stepFromPlan(fileStep, now) {
  const status = stateOf(fileStep);
  return {
    ...emptyStep(),
    status,
    pr: int(fileStep?.pr),
    blocked_by: status === 'blocked' && plain(fileStep?.blocked_by) ? { kind: String(fileStep.blocked_by.kind), name: String(fileStep.blocked_by.name) } : null,
    comments: prose(fileStep?.comments),
    updated: now,
  };
}

/**
 * The entry a plan seen for the first time gets: its own steps' state, read
 * off the file once. `record` is a `listPlans` record — `repo`, `programme`,
 * `project`, `path` and the parsed `plan`.
 */
export function seedEntry(record, now = null) {
  const steps = Array.isArray(record?.plan?.steps) ? record.plan.steps : [];
  return {
    schema: REGISTER_SCHEMA,
    version: REGISTER_VERSION,
    project: record.project,
    repo: record.repo ?? null,
    programme: record.programme ?? null,
    plan: record.path ?? null,
    updated: now,
    steps: steps.map((step) => stepFromPlan(step, now)),
  };
}

/**
 * An entry brought up to the plan it describes: a step the plan has and the
 * entry does not — a planning session added one — is seeded from the file;
 * a step the entry has and the plan no longer does is dropped, because the
 * runner cannot hand out a step that is not written. Steps are matched by
 * index, which is what a plan's `steps[]` is: an order.
 *
 * Returns `{ entry, changed }` so the caller writes only when something moved.
 */
export function reconcileEntry(entry, record, now = null) {
  const steps = Array.isArray(record?.plan?.steps) ? record.plan.steps : [];
  const had = entry.steps.length;
  const next = steps.map((step, index) => entry.steps[index] || stepFromPlan(step, now));
  const changed = had !== steps.length
    || entry.plan !== (record.path ?? null) || entry.repo !== (record.repo ?? null) || entry.programme !== (record.programme ?? null);
  return {
    entry: changed ? { ...entry, repo: record.repo ?? entry.repo, programme: record.programme ?? entry.programme, plan: record.path ?? entry.plan, updated: now ?? entry.updated, steps: next } : entry,
    changed,
  };
}

/**
 * The plan record as every reader wants it, with the register's state laid
 * over the file's: `status`, `pr`, `blocked_by` and `comments` on each step
 * come from the entry, and the summary (`status`, `next`, `title`, `step`,
 * `steps` — `planSummary`'s fields, spread into the record by `listPlans`)
 * is recomputed over the result. A record with no parsed plan is returned as
 * it is.
 */
export function applyEntry(record, entry) {
  if (!record?.plan || !entry) return record;
  const steps = record.plan.steps.map((step, index) => {
    const state = entry.steps[index];
    if (!state) return step;
    return {
      ...step,
      status: state.status,
      pr: state.pr,
      blocked_by: state.status === 'blocked' ? state.blocked_by : null,
      comments: state.comments,
    };
  });
  const plan = { ...record.plan, steps };
  return { ...record, plan, ...planSummary(plan) };
}

/**
 * One step's state changed. `patch` carries the fields that move; the rest
 * of the step stays. A status that is not one of `STEP_STATES` is refused,
 * as is `blocked` without a `blocked_by` and `failed` without a `reason` —
 * a failed step nobody explained is a person's hour spent finding out why.
 * `comment`, when given, is appended to the step's comments.
 */
export function patchStep(entry, index, patch = {}, now = null) {
  if (!Number.isInteger(index) || index < 0 || index >= entry.steps.length) {
    throw new Error(`${entry.project}: no step ${index + 1} — the plan has ${entry.steps.length}`);
  }
  const was = entry.steps[index];
  const { comment, ...rest } = patch;
  const next = { ...was, ...rest };
  if (rest.status !== undefined && !STEP_STATES.includes(rest.status)) {
    throw new Error(`${entry.project} step ${index + 1}: status must be one of ${STEP_STATES.join(', ')}`);
  }
  if (next.status === 'blocked' && !(plain(next.blocked_by) && next.blocked_by.kind && next.blocked_by.name)) {
    throw new Error(`${entry.project} step ${index + 1}: a blocked step names what it waits for (blocked_by)`);
  }
  if (next.status === 'failed' && !(typeof next.reason === 'string' && next.reason.trim())) {
    throw new Error(`${entry.project} step ${index + 1}: a failed step says why (reason)`);
  }
  if (next.status !== 'blocked') next.blocked_by = null;
  if (next.status !== 'running') next.session = null;
  if (comment) next.comments = [...(next.comments || []), String(comment)];
  next.updated = now;
  const steps = entry.steps.map((step, i) => (i === index ? next : step));
  return { ...entry, updated: now, steps };
}

/** The first step that is not done, or -1: the one `mc step` means when no index is given. */
export function currentIndex(entry) {
  const running = entry.steps.findIndex((step) => step.status === 'running');
  if (running >= 0) return running;
  return entry.steps.findIndex((step) => step.status !== 'done');
}

/**
 * `MC_STEP=<project>:<index>` — what the runner tells a session it is, so
 * `mc step` and `mc merge` inside it need no argument. Null when unset or
 * not of that shape.
 */
export function parseStepEnv(value) {
  const found = /^([a-z0-9][a-z0-9-]*):(\d+)$/u.exec(String(value || '').trim());
  return found ? { project: found[1], index: Number(found[2]) } : null;
}

/* -------------------------------------------------------------------- IO */

const realRead = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const realWrite = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 });
const realList = (dir) => { try { return readdirSync(dir); } catch { return []; } };

export function readEntry(root, project, { read = realRead } = {}) {
  return parseEntry(read(registerPath(root, project)));
}

export function writeEntry(root, entry, { write = realWrite } = {}) {
  write(registerPath(root, entry.project), entry);
  return entry;
}

/** Every entry in the register, by project name. */
export function listEntries(root, { list = realList, read = realRead } = {}) {
  return list(registerDir(root))
    .filter((name) => name.endsWith('.json'))
    .map((name) => parseEntry(read(join(registerDir(root), name))))
    .filter(Boolean);
}

/**
 * The plans as every reader sees them: each record with its register entry
 * laid over it, the entry seeded from the file when the register has none
 * and brought up to the plan when the plan has moved. A record with no
 * parsed plan (legacy, unreadable) passes through untouched.
 *
 * `root` null means no register — the fixtures that hand a reader plans
 * without a work root get the file's own state, as they always did.
 */
export function overlayPlans(plans, { root = null, read = realRead, write = realWrite, now = null } = {}) {
  if (!root) return plans;
  return plans.map((record) => {
    if (!record?.plan || record.legacy) return record;
    let entry = readEntry(root, record.project, { read });
    if (!entry) {
      entry = seedEntry(record, now);
      write(registerPath(root, record.project), entry);
    } else {
      const brought = reconcileEntry(entry, record, now);
      if (brought.changed) { entry = brought.entry; write(registerPath(root, record.project), entry); }
    }
    return applyEntry(record, entry);
  });
}

/**
 * One step's state changed, on disk: read, patch, write, under the
 * register's lock. Returns the entry as written. Throws when there is no
 * entry — a project the register has never seen is not one a caller may
 * move a step of by hand; a reader seeds it first.
 */
export function updateStep({ root, project, index, patch, read = realRead, write = realWrite, lock = realLock, now = null }) {
  return lock(root, () => {
    const entry = readEntry(root, project, { read });
    if (!entry) throw new Error(`${project}: not in the register at ${registerPath(root, project)}`);
    const next = patchStep(entry, index, patch, now);
    write(registerPath(root, project), next);
    return next;
  });
}

/**
 * One writer at a time across the register: a lock file with the writer's
 * pid, taken with `O_EXCL`, held for the milliseconds a read-patch-write
 * takes. A file naming a dead pid is litter from a killed writer and is
 * taken over; a live one is waited on, briefly, and then the write goes
 * ahead anyway — a register that cannot be written is worse than one written
 * a moment early, and every write is whole (`writeJsonAtomic`).
 */
export const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;

export function realLock(root, fn, { alive = pidAlive, waitMs = LOCK_WAIT_MS } = {}) {
  const path = join(registerDir(root), '.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd = null;
    try {
      fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // The directory is not there yet: the first write makes it.
        writeJsonAtomic(join(registerDir(root), '.keep'), {});
        continue;
      }
      if (error?.code !== 'EEXIST') break;
      const holder = Number(realRead(path));
      if (!alive(holder)) { try { rmSync(path, { force: true }); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) break;
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try { if (Number(realRead(path)) === process.pid) rmSync(path, { force: true }); } catch { /* gone */ }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

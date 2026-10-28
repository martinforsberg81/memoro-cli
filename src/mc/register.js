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
 * So: one file per project, `~/mc/runner/projects/<project>.json` — in layout
 * 2 (ruling 51, 3) `~/mc/programs/<programme>/<project>/STATE.json`, beside
 * its plan, the same JSON (`registerPath`) — written whole and atomically, holding one entry per step, in the plan's order and
 * matched to it by the step's key (`stepKey`). The plan on `main` is still
 * what says what a step *is*; the register says where it *stands*. Readers join the two (`overlayPlans`) and
 * see the same plan record they always saw, with the register's word for
 * `status`, `pr`, `blocked_by` and `comments` — so the picker, the page, the
 * brief and `mc status` change their source and not their shape.
 *
 * The state fields a plan file still carries are read exactly once: the first
 * time a plan is seen with no entry in the register, the entry is seeded from
 * them (`seedEntry`). After that the file's copies are ignored, and they go
 * from the schema when the last reader of them does.
 *
 * The register also holds whether each success criterion is met (ruling 48):
 * the plan says what a criterion *is*, the register whether it *holds*. An
 * entry's `criteria` are matched to the plan's criteria by their text, and written
 * by `mc project criterion met` (`updateCriterion`), and dropped by `mc project
 * criterion drop` (`dropCriterion`). The plan file's `met` is not read: a criterion
 * the register has not seen is not met.
 *
 * Every write to the register also appends one line to `runner/log/register.log`
 * (`registerLogPath`): what changed and which process made it — its pid, its
 * parent's command, its run id, the shape of its arguments (`invocationShape`,
 * which keeps flag names and drops their values and free text) and its
 * directory. The register keeps no history, and on 2026-10-12 `log-page` step 1
 * landed as memoro #13590 and stood `ready` again that evening, so the runner
 * ran it twice; the only record of the hand-typed `mc step ready` that moved it
 * was `mc.log`, which keeps no parent process and rotates. The file is not a
 * session log, so `mc tidy` keeps it when it removes a project's own files. A
 * log that cannot be written never fails the write.
 *
 * Everything below the IO line is pure over entries and plan records, so the
 * rules are tested without a file.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { invocationShape, rotateIfLarge, runId } from './logger.js';
import { ARCHIVE_HOME, ARCHIVED_PROJECTS, PROGRAMS_HOME, RUNNER_HOME, layoutVersion } from './paths.js';
import { findArchivedProjectDir, findProjectDir } from './plan-write.js';
import { BLOCKER_KINDS, NAME_RE, blockerFieldProblems, planSummary } from './plan-schema.js';

export const REGISTER_SCHEMA = 'mc-register';
export const REGISTER_VERSION = 1;
export const REGISTER_DIR = 'projects';
/** Layout 2's register of a project, beside its plan (ruling 51, 3). */
export const STATE_FILE = 'STATE.json';
export const REGISTER_LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Where a step stands. `ready` the runner may hand it out; `running` a
 * session is on it (`session.pid` says which); `done` its pull request
 * landed on main; `failed` its session ended without landing — the pull
 * request, if any, is open and `reason` says what happened; `blocked` it
 * waits on something named in `blocked_by`; `landing` its pull request is
 * in the merger's queue (`merge-queue.js`, ruling 30) and the merger writes
 * what comes of it. A `built` step (the branch flow) has its work on the
 * project's branch, behind the plan, and its pull request is the review step's:
 * that step's landing makes it `done`. A `failed` or `blocked` step is a person's: the runner
 * never retries one, and the way back is `mc step ready` (ruling 21). The
 * one exception is a `time`, `deploy` or `project` blocker whose wait is
 * over, which the runner releases itself (`releaseDue`, ruling 35); a
 * `decision` or `workarea` blocker is still a person's. A red
 * round the merger sends back is `ready` with its `pr` and `reason` kept,
 * up to `MAX_MERGE_ATTEMPTS` (merge-step.js).
 *
 * An interrupted step is a `ready` step carrying an `interrupted` record: its
 * session died under it — the machine restarted, the runner was killed, the
 * process was killed by a signal the runner did not send — and the record
 * says which session it was (id, tool, model, log, last activity, context
 * size, branch, how many times in a row, when). It is not a state of its own
 * (ruling 33): every reader that draws `ready` keeps working, and the record
 * stays while the step is `ready` or `running` and goes on any other status.
 */
export const STEP_STATES = Object.freeze(['ready', 'running', 'landing', 'done', 'failed', 'blocked', 'built']);

/**
 * Layout 1's register directory, `runner/projects/`. Null in layout 2, where
 * there is none: each project's register is its own directory's `STATE.json`,
 * and nothing may list or create a register directory.
 */
export function registerDir(root, { read } = {}) {
  return layoutVersion({ root, read }) === 2 ? null : join(root, RUNNER_HOME, REGISTER_DIR);
}

/**
 * Where a project's register is: `runner/projects/<project>.json` in layout 1;
 * in layout 2 `programs/<programme>/<project>/STATE.json`, beside its plan or
 * draft (`findProjectDir`), or, once the runner has moved the project, beside
 * its plan under `archive/projects/` (`findArchivedProjectDir`). Null when there
 * is no such project. `read` is the one the layout file is read with; `exists`
 * and `list` the ones the project's directory is found with.
 */
export function registerPath(root, project, { read, exists, list } = {}) {
  if (layoutVersion({ root, read }) !== 2) return join(root, RUNNER_HOME, REGISTER_DIR, `${project}.json`);
  const found = findProjectDir(join(root, PROGRAMS_HOME), project, { list, exists })
    ?? findArchivedProjectDir(join(root, ARCHIVE_HOME, ARCHIVED_PROJECTS), project, { list, exists });
  return found ? join(found.dir, STATE_FILE) : null;
}

/** `registerPath`, for a write: a project with nowhere to keep a register is refused. */
function writablePath(root, project, options = {}) {
  const path = registerPath(root, project, options);
  if (!path) throw new Error(`no project ${project} under ~/mc/programs — its register has nowhere to be`);
  return path;
}

/** The register's own log, one JSON line per write (see the header). */
export function registerLogPath(root) {
  return join(root, 'runner', 'log', 'register.log');
}

/* --------------------------------------------------------------- entries */

/** A step nobody has touched: ready, on nothing, with nothing to say. */
export function emptyStep() {
  return {
    key: null, status: 'ready', pr: null, branch: null, blocked_by: null, reason: null, comments: [],
    session: null, attempts: 0, landed: null, built: null, stacked_on: null, interrupted: null, red: null, answered: null, updated: null,
  };
}

/**
 * A key without a leading ordinal: `5. The close`, `8) The close` and
 * `Step 3: The close` are `The close`. A planning session renumbers steps when
 * it inserts some, and the state has to follow the step.
 */
export function keyOf(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  return text.replace(/^(?:step\s+)?\d+[.:)]\s+/iu, '').trim() || null;
}

/**
 * What a step is called when its place in `steps[]` moves: the label its
 * title opens with (`W4.1.2 — actions: …` is `W4.1.2`, `Step 3: Wire it — …`
 * is `Wire it`), or the whole title when it has none, without a leading
 * ordinal (`keyOf`). A planning session inserts and reorders steps; the state
 * has to follow the step and not the slot it stood in.
 */
export function stepKey(fileStep) {
  const title = typeof fileStep?.title === 'string' ? fileStep.title.trim() : '';
  return keyOf(title.split(/\s+[—–-]\s+/u)[0]);
}

const int = (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const prose = (value) => (Array.isArray(value) ? value.filter((p) => typeof p === 'string' && p.trim()).map(String) : []);

/**
 * A blocker as the register keeps it: `kind` and `name`, and the fields a
 * `time` or `deploy` blocker waits by (ruling 35) — `at` when it is a string,
 * `step` when it is an integer, `hours` when it is a finite number — each
 * dropped otherwise. A runner on older code keeps only `kind` and `name`, and
 * drops these three at a handover (as ruling 30's rollout showed: old code
 * drops register fields it does not know). Such a step then reads as blocked
 * on a `time` or `deploy` name with nothing to release it, and `mc step`
 * shows that name, so a person sees it.
 */
function blockerOf(value) {
  if (!plain(value) || typeof value.kind !== 'string' || typeof value.name !== 'string') return null;
  const blocker = { kind: value.kind, name: value.name };
  if (typeof value.at === 'string') blocker.at = value.at;
  if (Number.isInteger(value.step)) blocker.step = value.step;
  if (Number.isFinite(value.hours)) blocker.hours = value.hours;
  return blocker;
}

/** One step, whatever an older file or a hand edit left in it. */
function normaliseStep(step) {
  const base = emptyStep();
  if (!plain(step)) return base;
  const status = STEP_STATES.includes(step.status) ? step.status : 'ready';
  return {
    ...base,
    key: typeof step.key === 'string' && step.key ? step.key : null,
    status,
    pr: int(step.pr),
    branch: typeof step.branch === 'string' && step.branch ? step.branch : null,
    blocked_by: blockerOf(step.blocked_by),
    reason: typeof step.reason === 'string' && step.reason.trim() ? step.reason : null,
    comments: prose(step.comments),
    session: plain(step.session) ? { ...step.session } : null,
    attempts: Number.isInteger(step.attempts) && step.attempts >= 0 ? step.attempts : 0,
    landed: plain(step.landed) ? { ...step.landed } : null,
    // The step this one's branch started on top of while that one was still
    // landing (ruling 30): `{ index, pr, sha }`, the sha being that branch's
    // tip when this one began. The merger lands this one only after that one,
    // and moves it onto main past `sha` first.
    stacked_on: plain(step.stacked_on) && Number.isInteger(step.stacked_on.index) && typeof step.stacked_on.sha === 'string'
      ? { index: step.stacked_on.index, pr: int(step.stacked_on.pr), sha: step.stacked_on.sha }
      : null,
    // The session that died under this step (see `STEP_STATES`).
    interrupted: plain(step.interrupted) ? { ...step.interrupted } : null,
    // What the merger's last red round handed on (ruling 44): `{ files,
    // detail, names }` — its red files, its file under `runner/merge-red/`
    // and its red tests' names, for the retry preamble.
    red: plain(step.red) && Array.isArray(step.red.files) && step.red.files.length
      ? {
        files: step.red.files.map(String),
        detail: typeof step.red.detail === 'string' ? step.red.detail : null,
        names: Array.isArray(step.red.names) ? step.red.names.map(String) : [],
      }
      : null,
    // The answer a person gave a step parked on a question, when its pull
    // request was kept (`mc step ready`): `{ name, answer, at }`, for the
    // preamble of the session that goes on from that pull request.
    answered: plain(step.answered) && typeof step.answered.at === 'string'
      ? {
        name: typeof step.answered.name === 'string' ? step.answered.name : null,
        answer: typeof step.answered.answer === 'string' ? step.answered.answer : null,
        at: step.answered.at,
      }
      : null,
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
    done_at: typeof value.done_at === 'string' ? value.done_at : null,
    steps: Array.isArray(value.steps) ? value.steps.map(normaliseStep) : [],
    criteria: Array.isArray(value.criteria)
      ? value.criteria.filter(plain).map((c) => ({ criterion: String(c.criterion ?? ''), met: c.met === true, at: typeof c.at === 'string' ? c.at : null }))
      : null,
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
    key: stepKey(fileStep),
    status,
    pr: int(fileStep?.pr),
    blocked_by: status === 'blocked' && plain(fileStep?.blocked_by)
      ? blockerOf({ ...fileStep.blocked_by, kind: String(fileStep.blocked_by.kind), name: String(fileStep.blocked_by.name) })
      : null,
    comments: prose(fileStep?.comments),
    updated: now,
  };
}

/**
 * The criteria as the plan file says them: the seed for an entry that has none.
 * The file's `met` is not read — a criterion the register has not seen is not
 * met; only `mc project criterion met` makes one met.
 */
export function criteriaFromPlan(plan) {
  return (Array.isArray(plan?.success_criteria) ? plan.success_criteria : []).map((c) => ({ criterion: String(c?.criterion ?? ''), met: false, at: null }));
}

/**
 * The criteria an entry holds, brought up to the plan's: each criterion of the
 * plan takes the held one with its text (the first not yet taken, so a text
 * the plan repeats is matched in order), and a text the register has not seen
 * is not met. A held criterion the plan no longer has is dropped.
 */
function reconcileCriteria(held, plan) {
  const fromFile = criteriaFromPlan(plan);
  if (!Array.isArray(held)) return fromFile;
  const free = [...held];
  return fromFile.map((criterion) => {
    const at = free.findIndex((c) => c.criterion === criterion.criterion);
    return at < 0 ? criterion : free.splice(at, 1)[0];
  });
}

/**
 * The entry a plan seen for the first time gets: its own steps' state, read
 * off the file once. `record` is a `listPlans` record — `repo`, `programme`,
 * `project`, `path` and the parsed `plan`.
 */
export function seedEntry(record, now = null) {
  const steps = Array.isArray(record?.plan?.steps) ? record.plan.steps : [];
  return withDoneAt({
    schema: REGISTER_SCHEMA,
    version: REGISTER_VERSION,
    project: record.project,
    repo: record.repo ?? null,
    programme: record.programme ?? null,
    plan: record.path ?? null,
    updated: now,
    steps: steps.map((step) => stepFromPlan(step, now)),
    criteria: criteriaFromPlan(record?.plan),
  }, now);
}

/**
 * An entry brought up to the plan it describes. Steps are matched by their
 * key (`stepKey`, which drops a leading ordinal, so `5. The close` is
 * `The close`), so a step a planning session moved or renumbered keeps its
 * state, a step it inserted is seeded from the file, and one it removed is
 * dropped — the runner cannot hand out a step that is not written. Until
 * 2026-09-18 the match was by index, and moving W4.1.2 behind W4.1.8
 * re-labelled six steps' state until the register file was edited by hand.
 *
 * A key the entry does not know, in a slot whose old key the plan no longer
 * has, is a step put in that slot. It keeps the slot's status, as a re-planned
 * blocked step is not released (Martin, 2026-10-03), but not its pull request,
 * branch, stack or red, which were the replaced step's (photo-viewer, memoro
 * #13580, 2026-10-12: a renumbered close inherited `blocked` and a closed pull
 * request). Each such slot gets a comment and is listed in `carried`. An entry
 * written before keys takes them from the plan by index, which is what it
 * asserted anyway; a plan whose keys are not unique is matched by index as
 * before.
 *
 * A `running` step that would move is left where it is, with the rest of the
 * entry, until its session ends: the session knows itself as
 * `MC_STEP=<project>:<index>`, and a write to that index has to reach it.
 *
 * Returns `{ entry, changed, carried }` so the caller writes only when something moved; `carried` lists `{ index, from, to }` for each slot carried by position.
 */
export function reconcileEntry(entry, record, now = null) {
  const steps = Array.isArray(record?.plan?.steps) ? record.plan.steps : [];
  const keys = steps.map(stepKey);
  const unique = keys.every(Boolean) && new Set(keys).size === keys.length;
  const keyed = entry.steps.map((state, index) => {
    if (!state.key) return { ...state, key: keys[index] ?? null };
    const key = keyOf(state.key);
    return key === state.key ? state : { ...state, key };
  });
  const carried = [];
  let next;
  if (!unique) {
    next = steps.map((step, index) => keyed[index] || stepFromPlan(step, now));
  } else {
    const known = new Map(keyed.map((state, index) => [state.key, index]));
    const wanted = new Set(keys);
    next = steps.map((step, index) => {
      if (known.has(keys[index])) return keyed[known.get(keys[index])];
      const here = keyed[index];
      if (here && !wanted.has(here.key)) {
        carried.push({ index, from: here.key, to: keys[index] });
        const done = here.status === 'done';
        return {
          ...here,
          key: keys[index],
          pr: done ? here.pr : null,
          branch: null,
          attempts: 0,
          stacked_on: null,
          red: null,
          interrupted: null,
          comments: [...(here.comments || []), `Carried by position on ${now ?? 'an unknown time'} from '${here.key}': a re-plan put '${keys[index]}' in this slot. Its status stays (Martin, 2026-10-03); the branch, attempts, stack, red and pull request of the step it replaced are cleared${done ? ' except the landed pull request' : ''}.`],
        };
      }
      return stepFromPlan(step, now);
    });
    const running = keyed.findIndex((state) => state.status === 'running');
    if (running >= 0 && next[running]?.key !== keyed[running].key) return { entry, changed: false, carried: [] };
  }
  const criteria = reconcileCriteria(entry.criteria, record?.plan);
  const changed = next.length !== entry.steps.length || next.some((state, index) => state !== entry.steps[index])
    || entry.plan !== (record.path ?? null) || entry.repo !== (record.repo ?? null) || entry.programme !== (record.programme ?? null)
    || JSON.stringify(criteria) !== JSON.stringify(entry.criteria);
  return {
    entry: changed ? withDoneAt({ ...entry, repo: record.repo ?? entry.repo, programme: record.programme ?? entry.programme, plan: record.path ?? entry.plan, updated: now ?? entry.updated, steps: next, criteria }, now) : entry,
    changed,
    carried,
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
  if (record.plan.version !== undefined && record.plan.version !== 1) return record;
  const steps = record.plan.steps.map((step, index) => {
    const state = entry.steps[index];
    if (!state) return step;
    return {
      ...step,
      status: state.status,
      pr: state.pr,
      reason: state.reason ?? null,
      blocked_by: state.status === 'blocked' ? state.blocked_by : null,
      comments: state.comments,
    };
  });
  const plan = { ...record.plan, steps };
  if (Array.isArray(entry.criteria) && Array.isArray(record.plan.success_criteria)) {
    // Matched by text, not index: `run.js`'s `standing` applies an entry it has not reconciled.
    plan.success_criteria = record.plan.success_criteria.map((c) => {
      const held = entry.criteria.find((e) => e.criterion === c?.criterion);
      return held ? { ...c, met: held.met } : c;
    });
  }
  return { ...record, plan, ...planSummary(plan) };
}

/**
 * Whether an entry is done — it has steps, every step is `done`, and every
 * criterion it holds (when `criteria` is an array) is met — and when it became
 * so. A done entry keeps the `done_at` it has, or takes `now` the first time a
 * write finds it done; one that is not done holds none, so a step moved back
 * off `done` starts the clock again when it is done once more. Nothing else
 * writes `done_at`: the archive's 24 hours run from it (project-archive.js).
 */
export function withDoneAt(entry, now = null) {
  const steps = Array.isArray(entry.steps) ? entry.steps : [];
  const criteria = Array.isArray(entry.criteria) ? entry.criteria : [];
  const done = steps.length > 0 && steps.every((step) => step.status === 'done') && criteria.every((criterion) => criterion.met === true);
  return { ...entry, done_at: done ? entry.done_at || now : null };
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
  if (rest.blocked_by && next.status === 'blocked' && !(BLOCKER_KINDS.includes(next.blocked_by.kind) && NAME_RE.test(next.blocked_by.name))) {
    throw new Error(`${entry.project} step ${index + 1}: blocked_by is { kind: ${BLOCKER_KINDS.join(' | ')}, name } and the name is a name, not a sentence`);
  }
  if (rest.blocked_by && next.status === 'blocked') {
    const problems = blockerFieldProblems(next.blocked_by, index + 1);
    if (problems.length) throw new Error(`${entry.project} step ${index + 1}: blocked_by.${problems.join('; blocked_by.')}`);
    next.blocked_by = blockerOf(next.blocked_by);
  }
  if (next.status === 'failed' && !(typeof next.reason === 'string' && next.reason.trim())) {
    throw new Error(`${entry.project} step ${index + 1}: a failed step says why (reason)`);
  }
  if (next.status !== 'blocked') next.blocked_by = null;
  if (next.status !== 'running') next.session = null;
  if (next.status !== 'ready' && next.status !== 'running') next.interrupted = null;
  if (['blocked', 'failed', 'landing', 'done', 'built'].includes(next.status)) next.answered = null;
  if (comment) next.comments = [...(next.comments || []), String(comment)];
  next.updated = now;
  const steps = entry.steps.map((step, i) => (i === index ? next : step));
  return withDoneAt({ ...entry, updated: now, steps }, now);
}

/**
 * One success criterion's `met` and when it was set. `number` is the
 * criterion's place in the plan, from 1. An entry the register has never
 * seeded holds no criteria, and a number outside the ones it holds is refused.
 */
export function markCriterion(entry, number, met, now = null) {
  const criteria = Array.isArray(entry.criteria) ? entry.criteria : null;
  const n = criteria ? criteria.length : 0;
  if (!Number.isInteger(number) || number < 1 || number > n) {
    throw new Error(`${entry.project}: no success criterion ${number} — the register holds ${n}`);
  }
  return withDoneAt({
    ...entry,
    updated: now,
    criteria: criteria.map((c, i) => (i === number - 1 ? { ...c, met: met === true, at: now } : c)),
  }, now);
}

/** The first step that is neither done nor built, or -1: the one `mc step` means when no index is given. */
export function currentIndex(entry) {
  const running = entry.steps.findIndex((step) => step.status === 'running');
  if (running >= 0) return running;
  return entry.steps.findIndex((step) => step.status !== 'done' && step.status !== 'built');
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
const realAppend = (path, line) => {
  mkdirSync(dirname(path), { recursive: true });
  rotateIfLarge(path, REGISTER_LOG_MAX_BYTES);
  appendFileSync(path, line, { mode: 0o644 });
};

let parentSeen;
/** The command of this process's parent, asked of `ps` once per process. */
function parentName() {
  if (parentSeen !== undefined) return parentSeen;
  try {
    const found = spawnSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 });
    parentSeen = found.status === 0 ? String(found.stdout || '').trim() || null : null;
  } catch { parentSeen = null; }
  return parentSeen;
}

/**
 * Who is making a register write: this process, its parent's command, its
 * run id, the shape of its invocation (`invocationShape`: flag names, no
 * values, no free text) and its directory. `mc_step` is `MC_STEP`, when a
 * session has one.
 */
export function whoAmI() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    parent: parentName(),
    run: runId(),
    argv: invocationShape(process.argv.slice(2)),
    cwd: process.cwd(),
    mc_step: process.env.MC_STEP || null,
  };
}

/**
 * One line to `register.log`, after a write that has happened. Never throws:
 * a log that cannot be written never fails the write it describes.
 */
function logWrite(root, append, by, fields) {
  try {
    append(registerLogPath(root), `${JSON.stringify({ at: new Date().toISOString(), ...fields, by: by() })}\n`);
  } catch { /* the log never fails the write */ }
}

/** A project's entry; null when it has none, or nowhere to keep one. */
export function readEntry(root, project, { read = realRead, exists, list } = {}) {
  const path = registerPath(root, project, { read, exists, list });
  return path ? parseEntry(read(path)) : null;
}

export function writeEntry(root, entry, { write = realWrite, read, exists, list } = {}) {
  write(writablePath(root, entry.project, { read, exists, list }), entry);
  return entry;
}

/**
 * Every entry in the register, by project name: layout 1's `runner/projects/*.json`,
 * or every `programs/<programme>/<project>/STATE.json` that parses in layout 2 —
 * archived projects included in both.
 */
export function listEntries(root, { list = realList, read = realRead } = {}) {
  const dir = registerDir(root, { read });
  if (dir) {
    return list(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => parseEntry(read(join(dir, name))))
      .filter(Boolean);
  }
  const home = join(root, PROGRAMS_HOME);
  return [...list(home)].sort()
    .flatMap((programme) => [...list(join(home, programme))].sort().map((project) => join(home, programme, project, STATE_FILE)))
    .map((path) => parseEntry(read(path)))
    .filter(Boolean);
}

/**
 * Every archived project's entry: each `archive/projects/<programme>/<project>/STATE.json`
 * that parses, in layout 2 — the projects the runner has moved out of
 * `programs/`. Layout 1 has no archive of registers, so it has none. `listEntries`
 * lists the live projects and never these.
 */
export function listArchivedEntries(root, { list = realList, read = realRead } = {}) {
  if (layoutVersion({ root, read }) !== 2) return [];
  const home = join(root, ARCHIVE_HOME, ARCHIVED_PROJECTS);
  return [...list(home)].sort()
    .flatMap((programme) => [...list(join(home, programme))].sort().map((project) => join(home, programme, project, STATE_FILE)))
    .map((path) => parseEntry(read(path)))
    .filter(Boolean);
}

/**
 * The plans as every reader sees them: each record with its register entry
 * laid over it, the entry seeded from the file when the register has none
 * and brought up to the plan when the plan has moved. A record with no
 * parsed plan (legacy, unreadable) passes through untouched.
 *
 * `root` null means no register — the fixtures that hand a reader plans
 * without a work root get the file's own state, as they always did. So does a
 * plan with no project directory under `~/mc/programs/` in layout 2, which has
 * nowhere to keep a register (`registerPath`). A seed,
 * and a re-plan that moved something, is appended to `register.log` (`logWrite`).
 *
 * A seed and a reconcile are written under `lock`, with the entry read again
 * inside it, so a concurrent `updateStep` is not overwritten by an entry read
 * before it; a plan the register already agrees with takes no lock.
 */
export function overlayPlans(plans, {
  root = null, read = realRead, write = realWrite, now = null, append = realAppend, by = whoAmI, lock = (_root, fn) => fn(), exists, list,
} = {}) {
  if (!root) return plans;
  return plans.map((record) => {
    if (!record?.plan || record.legacy || (record.plan.version !== undefined && record.plan.version !== 1)) return record;
    const path = registerPath(root, record.project, { read, exists, list });
    if (!path) return record;
    const settle = (entry) => {
      if (!entry) {
        const seeded = seedEntry(record, now);
        return { entry: seeded, event: { event: 'seed', project: record.project, steps: seeded.steps.length, statuses: seeded.steps.map((s) => s.status) } };
      }
      const brought = reconcileEntry(entry, record, now);
      return brought.changed
        ? { entry: brought.entry, event: { event: 'reconcile', project: record.project, carried: brought.carried || [] } }
        : { entry, event: null };
    };
    let { entry, event } = settle(parseEntry(read(path)));
    if (event) {
      entry = lock(root, () => {
        const again = settle(parseEntry(read(path)));
        if (again.event) {
          write(path, again.entry);
          logWrite(root, append, by, again.event);
        }
        return again.entry;
      });
    }
    return applyEntry(record, entry);
  });
}

/**
 * One step's state changed, on disk: read, patch, write, under the
 * register's lock. Returns the entry as written. Throws when there is no
 * entry — a project the register has never seen is not one a caller may
 * move a step of by hand; a reader seeds it first. Each write appends a line
 * to `register.log` naming this process (`logWrite`).
 */
export function updateStep({ root, project, index, patch, read = realRead, write = realWrite, lock = realLock, now = null, append = realAppend, by = whoAmI }) {
  const path = writablePath(root, project, { read });
  return lock(root, () => {
    const entry = parseEntry(read(path));
    if (!entry) throw new Error(`${project}: not in the register at ${path}`);
    const next = patchStep(entry, index, patch, now);
    write(path, next);
    const was = entry.steps[index];
    const made = next.steps[index];
    logWrite(root, append, by, { event: 'step', project, index, key: made.key, from: was.status, to: made.status, pr: made.pr ?? null, fields: Object.keys(patch) });
    return next;
  });
}

/**
 * One criterion's `met` changed, on disk: read, mark, write, under the
 * register's lock — `updateStep` for a criterion, and the same refusals. Each
 * write appends a `criterion` line to `register.log` (`logWrite`).
 */
export function updateCriterion({ root, project, number, met, read = realRead, write = realWrite, lock = realLock, now = null, append = realAppend, by = whoAmI }) {
  const path = writablePath(root, project, { read });
  return lock(root, () => {
    const entry = parseEntry(read(path));
    if (!entry) throw new Error(`${project}: not in the register at ${path}`);
    const next = markCriterion(entry, number, met, now);
    write(path, next);
    logWrite(root, append, by, { event: 'criterion', project, number, from: entry.criteria[number - 1].met, to: next.criteria[number - 1].met });
    return next;
  });
}

/**
 * One criterion removed, on disk: the first held criterion whose text is `text`,
 * read, removed, written, under the register's lock — `updateCriterion`'s shape.
 * A text the register does not hold leaves the entry as it is, and writes
 * nothing. Each drop appends a `criterion-drop` line to `register.log` naming
 * the reason (`logWrite`).
 */
export function dropCriterion({ root, project, text, reason, read = realRead, write = realWrite, lock = realLock, now = null, append = realAppend, by = whoAmI }) {
  const path = writablePath(root, project, { read });
  return lock(root, () => {
    const entry = parseEntry(read(path));
    if (!entry) throw new Error(`${project}: not in the register at ${path}`);
    const at = entry.criteria.findIndex((c) => c.criterion === text);
    if (at === -1) return entry;
    const next = withDoneAt({ ...entry, criteria: entry.criteria.filter((_, i) => i !== at), updated: now }, now);
    write(path, next);
    logWrite(root, append, by, { event: 'criterion-drop', project, criterion: text, reason });
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
 *
 * The file stays under `runner/`, whatever the layout, because it also guards
 * `merges.json`, deploys, language runs and iOS builds: `runner/projects/.lock`
 * in layout 1 (so a process on older code and one on newer still exclude each
 * other), `runner/register.lock` in layout 2 (`lockPath`).
 * A plan amendment uses `strict: true`: it must not commit without the lock.
 * Existing register callers retain their timeout policy.
 */
export const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;

export function lockPath(root) {
  return layoutVersion({ root }) === 2 ? join(root, RUNNER_HOME, 'register.lock') : join(root, RUNNER_HOME, REGISTER_DIR, '.lock');
}

export function realLock(root, fn, { alive = pidAlive, waitMs = LOCK_WAIT_MS, strict = false } = {}) {
  const path = lockPath(root);
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
        // The directory is not there yet: the first lock makes it.
        try { mkdirSync(dirname(path), { recursive: true }); } catch (mkdirError) { if (strict) throw mkdirError; break; }
        continue;
      }
      if (error?.code !== 'EEXIST') { if (strict) throw error; break; }
      const holder = Number(realRead(path));
      if (!alive(holder)) { try { rmSync(path, { force: true }); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) {
        if (strict) throw new Error(`register is being written by pid ${holder} — try again`);
        break;
      }
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

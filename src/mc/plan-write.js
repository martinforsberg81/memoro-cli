/**
 * `plan-write.js` — the pure core of the `mc project` verbs (ruling 48). No
 * session writes a plan file: mc does, through those verbs, each of which reads
 * the plan, changes it and writes it back whole, under a lock.
 *
 * Until a plan is sent it is a draft, `DRAFT.json`, beside where `PLAN.json`
 * will be: `~/mc/programs/<programme>/<project>/DRAFT.json`. No reader of plans
 * reads a draft — `programsPlans` (`plan-source.js`) reads only `PLAN.json` — so
 * a draft is seen by the verbs and by nobody else. `mc project send` runs the
 * whole check (`sendProblems`) and renames the draft to `PLAN.json`; that rename
 * is the handover to the runner.
 *
 * Pure given what it is handed: the directory reads, the file reads and the
 * writes are arguments, so the tests run against a scratch directory and the
 * verbs in `commands/project.js` run against the real one.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { PLAN_FILE } from './plan-source.js';
import { NAME_RE, validatePlan } from './plan-schema.js';

/**
 * The file a plan is written to until `mc project send` renames it. It sits
 * beside `PLAN.json` and no reader of plans opens it, so a half-written plan is
 * never handed to the runner.
 */
export const DRAFT_FILE = 'DRAFT.json';

/**
 * The only models a step written by a verb may name (ruling 42, `mc-project.md`
 * § Decisions). A step names its own model; the plan does not name one for it.
 */
export const MODELS = Object.freeze(['haiku', 'opus']);

/**
 * Words that name a person where a check or a step's end has to be a command.
 * "Martin looks at it" is not something mc can run, so it is refused at the
 * verb that would write it. Matched on word boundaries: `a person` does not
 * match `a personal`.
 */
export const BANNED_WORDS = /\b(Martin|by hand|manually|a person)\b/iu;

/**
 * Words that say a check runs where the last step's own branch cannot reach:
 * after a deploy, in production, on a person's phone or at a person's terminal.
 * The merge door refuses the last step until every criterion is `met` in the
 * register, so such a check never passes from that branch. A check the last
 * step's own branch cannot reach is not a criterion; the three plans sent on
 * 2026-10-19 with "Martin's own check after the deploy; not a step's" as their
 * last criterion are the case.
 */
export const CHECK_WORDS = /\b(after the deploy|after deploy|once deployed|in production|not a step's|his (?:phone|iPhone|mobile)|at his terminal)\b/iu;

/**
 * A dependency written in prose instead of through `--after <repo>:<project>`.
 * `--after` is resolved over every project mc knows, archived ones included;
 * prose names a project that the next reader would have to guess at, and
 * `blocked_by` is written by `mc project step add`, not by a step's own words.
 */
export const DEPENDENCY_WORDS = /--on-project|\bblocked_by\b/u;

/** Every distinct match of `pattern` in `text`, in the order they appear; none for a non-string. */
function matchesOf(pattern, text) {
  if (typeof text !== 'string') return [];
  return [...new Set(text.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [])];
}

/**
 * The distinct banned words `text` names, as written in it — `Martin`,
 * `by hand`, `Manually`, `a person` — or an empty array for none, and for a
 * text that is not a string.
 */
export function bannedWords(text) {
  return matchesOf(BANNED_WORDS, text);
}

/**
 * The distinct check words `text` names — `after the deploy`, `in production`,
 * `not a step's` — or an empty array for none, and for a text that is not a
 * string. The same shape as `bannedWords`, for a check that cannot run from the
 * step's own branch.
 */
export function checkWords(text) {
  return matchesOf(CHECK_WORDS, text);
}

/**
 * The distinct dependency words `text` names — `--on-project`, `blocked_by` —
 * or an empty array for none, and for a text that is not a string. The same
 * shape as `bannedWords`, for the other thing a verb refuses in prose.
 */
export function dependencyWords(text) {
  return matchesOf(DEPENDENCY_WORDS, text);
}

/** The names of the directories in `path`, sorted, dot-directories left out; none when it cannot be read. */
function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Where a project's plan is, whether it is sent or still a draft: the first
 * `<home>/<programme>/<project>/` that holds `PLAN.json` (`sent: true`) or
 * `DRAFT.json` (`sent: false`), the programmes walked in order. `file` is the
 * path of whichever of the two was found. Null when neither exists, and for a
 * project name that is not a name — a `..` must not walk out of `home`.
 */
export function findProjectDir(home, project, { list = listDirs, exists = existsSync } = {}) {
  if (!NAME_RE.test(project)) return null;
  for (const programme of list(home)) {
    const dir = join(home, programme, project);
    const sent = join(dir, PLAN_FILE);
    if (exists(sent)) return { programme, dir, file: sent, sent: true };
    const draft = join(dir, DRAFT_FILE);
    if (exists(draft)) return { programme, dir, file: draft, sent: false };
  }
  return null;
}

/**
 * What is wrong with a draft that is not yet a plan to send, which is all of
 * `validatePlan`'s problems except the two that only say a draft is unfinished:
 * no success criteria yet, and no steps yet. Those two are reported only while
 * their array is empty; a criterion or a step that is there and wrong is still
 * a problem.
 */
export function draftProblems(plan) {
  const noCriteria = Array.isArray(plan?.success_criteria) && plan.success_criteria.length === 0;
  const noSteps = Array.isArray(plan?.steps) && plan.steps.length === 0;
  return validatePlan(plan).problems.filter((problem) => !(noCriteria && problem.startsWith('success_criteria:'))
    && !(noSteps && problem.startsWith('steps:')));
}

/** A step's instruction paragraphs, or none when it has no array of them. */
function instructionOf(step) {
  return Array.isArray(step?.instruction) ? step.instruction : [];
}

/**
 * Everything that stops a draft from being sent, as strings a person can act
 * on: all of `validatePlan`'s problems, then what only a verb refuses — a plan
 * that names a model for itself rather than for each step (ruling 42), a step
 * whose model is not `MODELS`, a banned word in a step's `done_when` or a
 * criterion's `check`, and a dependency in prose where `--after` belongs. An
 * empty array is a plan `mc project send` may rename to `PLAN.json`.
 */
export function sendProblems(plan) {
  const problems = [...validatePlan(plan).problems];
  if (plan?.runner?.model) {
    problems.push('runner.model: a plan names no model — each step names its own (ruling 42)');
  }
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  steps.forEach((step, index) => {
    const n = index + 1;
    if (!MODELS.includes(step?.runner?.model)) problems.push(`steps[${n}].runner.model: haiku or opus`);
    const names = bannedWords(step?.done_when);
    if (names.length) problems.push(`steps[${n}].done_when: names ${names.join(', ')} — a step's end is a check, never a person's`);
    const prose = [step?.done_when, ...instructionOf(step)];
    if (prose.some((text) => dependencyWords(text).length > 0)) {
      problems.push(`steps[${n}]: a dependency goes in --after <repo>:<project>`);
    }
  });
  const criteria = Array.isArray(plan?.success_criteria) ? plan.success_criteria : [];
  criteria.forEach((criterion, index) => {
    const n = index + 1;
    const named = bannedWords(criterion?.criterion);
    if (named.length) problems.push(`success_criteria[${n}].criterion: names ${named.join(', ')} — a criterion is measured by its check, never by a person`);
    const names = bannedWords(criterion?.check);
    if (names.length) problems.push(`success_criteria[${n}].check: names ${names.join(', ')} — a check is a command`);
    const says = checkWords(criterion?.check);
    if (says.length) problems.push(`success_criteria[${n}].check: says ${says.join(', ')} — a check runs from the step's own branch, before the merge (ruling 35 waits on a deploy with mc step blocked --after-deploy, not with a criterion)`);
  });
  return problems;
}

const LOCK_FILE = '.lock';
const LOCK_POLL_MS = 25;

/** A lock file's text, trimmed, or null when it is not there (it was released between two reads). */
function readLock(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Whether `pid` names a live process: a process that exists, or one this user may not signal. */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * One writer at a time on a project directory: `fn` runs holding `<dir>/.lock`,
 * which names the writer's pid, taken with `O_EXCL`. A lock that names a pid
 * `alive` says is dead is litter from a killed writer and is taken over. A live
 * one is waited on for `waitMs`, and then the call throws rather than write
 * over it — unlike the register's lock (`realLock`), which goes ahead, a plan
 * is a document a person reads, and a verb that loses a race says so and is run
 * again. The lock is removed after `fn`, if it still names this pid.
 */
export function withPlanLock(dir, fn, { alive = pidAlive, waitMs = 5000, pid = process.pid } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const holder = readLock(path);
      if (holder === null) continue;
      if (!alive(Number(holder))) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${dir} is being written by pid ${holder} — try again`);
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (readLock(path) === String(pid)) rmSync(path, { force: true });
  }
}

/**
 * A draft or a plan file, parsed. A file that is not JSON throws, naming the
 * file and the parser's complaint, because the verb that asked cannot say
 * anything more useful about it than where it is and what is wrong.
 */
export function readDraftOrPlan(file, { read = (path) => readFileSync(path, 'utf8') } = {}) {
  const text = read(file);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`);
  }
}

/**
 * The plan written whole to `file`, atomically (`writeJsonAtomic`), and returned.
 * A verb calls this with the plan it has just changed; nothing is merged into
 * what the file held before.
 */
export function writePlanFile(file, plan, { write = writeJsonAtomic } = {}) {
  write(file, plan);
  return plan;
}

/**
 * The paragraphs of a markdown instruction: the text cut at blank lines, each
 * trimmed, empty ones dropped. A list or a code block with no blank line inside
 * it is one paragraph. This is how `--instruction-file` becomes a step's
 * `instruction`, which the schema keeps as an array of paragraphs.
 */
export function instructionParagraphs(text) {
  return String(text ?? '').split(/\n[ \t]*\n/u).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph !== '');
}

/**
 * The model catalog (ruling 59): the candidates a fast or a large step may run
 * on, in the order they are preferred, and the one model review always uses.
 *
 * It is a file the person owns — `~/mc/runner/models.json` — and mc writes it
 * only through `mc model`. An absent file reads as the defaults below. A file
 * that is there and is not a catalog mc can read is refused, never quietly
 * replaced by the defaults: a catalog that silently became the defaults would
 * send work to models nobody chose.
 *
 * Nothing here looks at capacity. Which candidate a step gets is the choice
 * module's; a catalog says only what may be chosen.
 *
 * A model is any name the plan schema's model syntax accepts, not an entry on
 * an allowlist, so a model released next month is one `mc model add` away. The
 * tool and the effort are checked, because mc has to launch them.
 *
 * A write takes a lock of its own (`models.json.lock`), named by the writer's
 * pid, so two `mc model` calls cannot interleave their read and their write.
 * The file itself is written whole or not at all (writeJsonAtomic).
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { runnerDir } from './paths.js';
import { EFFORT_LEVELS, MODEL_RE } from './plan-schema.js';
import { pidAlive } from './status-collect.js';

export const MODELS_SCHEMA = 'mc-models';
export const MODELS_VERSION = 1;
export const MODELS_FILE = 'models.json';
export const CLASSES = Object.freeze(['fast', 'large']);
export const TOOLS = Object.freeze(['claude', 'codex']);
const DOCUMENT_KEYS = Object.freeze(['schema', 'version', 'fast', 'large', 'review']);
const CANDIDATE_KEYS = Object.freeze(['tool', 'model', 'effort']);
const LOCK_POLL_MS = 50;

/** A catalog that cannot be read, or a change the catalog refuses. The message is for a person. */
export class ModelConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

const candidate = (tool, model, effort) => Object.freeze({ tool, model, effort });

/** What an absent catalog reads as. Review is one candidate: a review is never routed. */
export const DEFAULT_CATALOG = Object.freeze({
  fast: Object.freeze([candidate('claude', 'haiku', 'high'), candidate('codex', 'gpt-6-luna', 'high')]),
  large: Object.freeze([candidate('claude', 'opus', 'medium'), candidate('codex', 'gpt-6.1-sol', 'high')]),
  review: candidate('claude', 'opus', 'high'),
});

export function modelsPath(env = process.env) {
  return join(runnerDir(env), MODELS_FILE);
}

/** `tool:model:effort`, as the catalog and the command line both spell a candidate. */
export function candidateSpec(value) {
  return `${value.tool}:${value.model}:${value.effort}`;
}

const identity = (value) => `${value.tool}:${value.model}`;
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function identityProblems(tool, model) {
  const problems = [];
  if (!TOOLS.includes(tool)) problems.push(`tool: one of ${TOOLS.join(', ')}`);
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    problems.push('model: a model name, lower-case letters, digits, dots, hyphens and underscores');
  }
  return problems;
}

/** What is wrong with a candidate object, as `<field>: <problem>`. Empty when it is a candidate. */
function candidateProblems(value) {
  if (!plain(value)) return ['a candidate is tool, model and effort'];
  const problems = Object.keys(value).filter((key) => !CANDIDATE_KEYS.includes(key)).map((key) => `${key}: unknown key`);
  problems.push(...identityProblems(value.tool, value.model));
  if (!EFFORT_LEVELS.includes(value.effort)) problems.push(`effort: one of ${EFFORT_LEVELS.join(', ')}`);
  return problems;
}

/** A candidate typed on the command line, `tool:model:effort`, checked whole. */
export function parseCandidate(text) {
  const parts = String(text).split(':');
  if (parts.length !== 3) throw new ModelConfigError(`"${text}" is not tool:model:effort, e.g. claude:haiku:high`);
  const value = { tool: parts[0], model: parts[1], effort: parts[2] };
  const problems = candidateProblems(value);
  if (problems.length) throw new ModelConfigError(`"${text}": ${problems.join('; ')}`);
  return candidate(value.tool, value.model, value.effort);
}

/** Which candidate a `remove` names, `tool:model`, checked whole. */
export function parseTarget(text) {
  const parts = String(text).split(':');
  if (parts.length !== 2) throw new ModelConfigError(`"${text}" is not tool:model, e.g. codex:gpt-6-luna`);
  const problems = identityProblems(parts[0], parts[1]);
  if (problems.length) throw new ModelConfigError(`"${text}": ${problems.join('; ')}`);
  return { tool: parts[0], model: parts[1] };
}

/** A list's first repeated tool:model, as a problem. A class names each model once. */
function duplicateProblems(cls, list) {
  const seen = new Set();
  const problems = [];
  for (const value of list) {
    if (!plain(value)) continue;
    if (seen.has(identity(value))) problems.push(`${cls}: ${identity(value)} is listed twice`);
    seen.add(identity(value));
  }
  return problems;
}

/** What is wrong with a whole catalog document as read from the file. */
function documentProblems(value) {
  if (!plain(value)) return ['the file is not a JSON object'];
  const problems = Object.keys(value).filter((key) => !DOCUMENT_KEYS.includes(key)).map((key) => `${key}: unknown key`);
  if (value.schema !== MODELS_SCHEMA) problems.push(`schema: must be "${MODELS_SCHEMA}"`);
  if (value.version !== MODELS_VERSION) problems.push(`version: ${MODELS_VERSION} is the only version this mc reads`);
  for (const cls of CLASSES) {
    const list = value[cls];
    if (!Array.isArray(list) || list.length === 0) {
      problems.push(`${cls}: a list of at least one candidate`);
      continue;
    }
    list.forEach((item, index) => {
      for (const problem of candidateProblems(item)) problems.push(`${cls}[${index}].${problem}`);
    });
    problems.push(...duplicateProblems(cls, list));
  }
  for (const problem of candidateProblems(value.review)) problems.push(`review.${problem}`);
  return problems;
}

const RECOVERY = 'fix it, or move it aside to read the defaults';

/** The catalog as an object of its own: a copy whose candidates a change may edit. */
function cloneCatalog({ fast, large, review }) {
  return { fast: fast.map((value) => ({ ...value })), large: large.map((value) => ({ ...value })), review: { ...review } };
}

/**
 * The catalog as it stands: `source` says whether it came from the file or from
 * the defaults. Throws a ModelConfigError when the file is there and is not a
 * catalog mc can read — it does not fall back to the defaults.
 */
export function readModels(env = process.env) {
  const path = modelsPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { source: 'defaults', path, ...cloneCatalog(DEFAULT_CATALOG) };
    throw new ModelConfigError(`${path} cannot be read (${error?.code || error?.message}) — ${RECOVERY}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ModelConfigError(`${path} is not JSON (${error.message}) — ${RECOVERY}`);
  }
  const problems = documentProblems(value);
  if (problems.length) throw new ModelConfigError(`${path} is not a model catalog mc can read: ${problems.join('; ')} — ${RECOVERY}`);
  return {
    source: 'config',
    path,
    fast: value.fast.map((item) => candidate(item.tool, item.model, item.effort)),
    large: value.large.map((item) => candidate(item.tool, item.model, item.effort)),
    review: candidate(value.review.tool, value.review.model, value.review.effort),
  };
}

function classList(catalog, cls) {
  if (!CLASSES.includes(cls)) throw new ModelConfigError(`"${cls}" is not a class: add and remove take fast or large`);
  return catalog[cls];
}

/** Appended to the class's order. A model is listed once per class, whatever its effort. */
export function addCandidate(catalog, cls, value) {
  const list = classList(catalog, cls);
  const existing = list.find((item) => identity(item) === identity(value));
  if (existing) {
    throw new ModelConfigError(`${cls} already has ${identity(value)} at ${candidateSpec(existing)} — remove it first to change its effort`);
  }
  list.push(candidate(value.tool, value.model, value.effort));
  return catalog;
}

/** Exactly `tool:model`. The class keeps at least one candidate. */
export function removeCandidate(catalog, cls, { tool, model }) {
  const list = classList(catalog, cls);
  const index = list.findIndex((item) => item.tool === tool && item.model === model);
  if (index < 0) throw new ModelConfigError(`${cls} has no ${tool}:${model} to remove — mc model lists what it has`);
  if (list.length === 1) {
    throw new ModelConfigError(`${tool}:${model} is the only ${cls} candidate, and a class needs one — add its replacement first`);
  }
  list.splice(index, 1);
  return catalog;
}

export function setReview(catalog, value) {
  catalog.review = candidate(value.tool, value.model, value.effort);
  return catalog;
}

/** Sleeps on the calling thread, as plan-write's lock does: a verb this short waits in place. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The pid a lock file names; null when there is no lock file. */
function lockHolder(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return Number(text);
}

/**
 * One writer at a time on the catalog: `fn` runs holding `<dir>/models.json.lock`,
 * taken with `O_EXCL` and naming the writer's pid. A lock whose pid is dead is
 * litter from a killed writer and is taken over. A live one is waited on for
 * `waitMs`, then the call throws rather than write over it.
 */
export function withCatalogLock(dir, fn, { waitMs = 5000, pid = process.pid } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${MODELS_FILE}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const holder = lockHolder(path);
      if (holder === null) continue;
      if (!pidAlive(holder)) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new ModelConfigError(`${MODELS_FILE} is being changed by pid ${holder} — try again`);
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (lockHolder(path) === pid) rmSync(path, { force: true });
  }
}

/**
 * Read, change, write — under the lock. `change` edits a copy; when it throws,
 * nothing is written. Returns the catalog as written.
 */
export function changeModels(env = process.env, change) {
  return withCatalogLock(runnerDir(env), () => {
    const current = readModels(env);
    const catalog = cloneCatalog(current);
    change(catalog);
    const document = {
      schema: MODELS_SCHEMA,
      version: MODELS_VERSION,
      fast: catalog.fast,
      large: catalog.large,
      review: catalog.review,
    };
    writeJsonAtomic(current.path, document);
    return { source: 'config', path: current.path, ...catalog };
  });
}

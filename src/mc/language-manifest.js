/**
 * memoro's language cutover manifests, as far as `mc language` reads them.
 *
 * A manifest is memoro's: one production cutover written as data in
 * `scripts/language-library/cutovers/<name>.json`, validated in full by
 * memoro's own `scripts/language-library/lib/cutover-manifest.js`. This reader
 * checks only the fields mc uses, so that mc never runs an act whose shape it
 * would misread — and nothing more: a manifest editor or a second validator
 * is not mc's (ruling 31).
 *
 * The shape is a contract with memoro: `schema` and `version` say which one.
 * A manifest with another is listed as unreadable, by name, and never run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA = 'memoro-language-cutover';
export const VERSION = 1;
export const CUTOVER_DIR = 'scripts/language-library/cutovers';

const isString = (value) => typeof value === 'string' && value.trim() !== '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isArgv = (value) => Array.isArray(value) && value.length > 0 && value.every(isString);
const isStrings = (value) => Array.isArray(value) && value.every(isString);

function expectationProblem(item, where) {
  if (!isObject(item) || !isString(item.path)) return `${where}: an expectation needs a path`;
  const exact = Object.hasOwn(item, 'exact');
  const advisory = Object.hasOwn(item, 'advisory');
  if (exact === advisory) return `${where} ${item.path}: an expectation is exact or advisory, not ${exact ? 'both' : 'neither'}`;
  return null;
}

function actProblems(act, index) {
  if (!isObject(act)) return [`acts[${index}] is not an object`];
  const where = isString(act.id) ? `act ${act.id}` : `acts[${index}]`;
  const problems = [];
  if (!isString(act.id)) problems.push(`${where}: no id`);
  if (!isString(act.title)) problems.push(`${where}: no title`);
  if (!isString(act.target)) problems.push(`${where}: no target`);
  if (!isArgv(act.check)) problems.push(`${where}: check must be an argument array`);
  if (act.execute !== null && !isArgv(act.execute)) problems.push(`${where}: execute must be an argument array or null`);
  if (!isStrings(act.credentials)) problems.push(`${where}: credentials must be an array`);
  if (!isStrings(act.requires_runnable)) problems.push(`${where}: requires_runnable must be an array`);
  if (!isObject(act.expect)) {
    problems.push(`${where}: no expect`);
  } else {
    for (const phase of ['check', 'execute']) {
      if (!Array.isArray(act.expect[phase])) { problems.push(`${where}: expect.${phase} must be an array`); continue; }
      for (const item of act.expect[phase]) {
        const problem = expectationProblem(item, `${where} expect.${phase}`);
        if (problem) problems.push(problem);
      }
    }
  }
  if (!isString(act.if_not)) problems.push(`${where}: no if_not`);
  if (act.opens_gap !== undefined && !(isObject(act.opens_gap) && isString(act.opens_gap.until) && isString(act.opens_gap.says))) {
    problems.push(`${where}: opens_gap must be { until, says }`);
  }
  return problems;
}

/**
 * One manifest's text → `{ ok: true, manifest }` or `{ ok: false, name,
 * problems }`. Never throws. `file` names it when the text says nothing.
 */
export function readManifest(text, { file = '' } = {}) {
  const fallback = String(file).replace(/^.*\//u, '').replace(/\.json$/u, '');
  let manifest;
  try {
    manifest = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, name: fallback, problems: [`not JSON: ${error.message}`] };
  }
  if (!isObject(manifest)) return { ok: false, name: fallback, problems: ['not a JSON object'] };
  const name = isString(manifest.name) ? manifest.name : fallback;
  // Another schema or version is another contract: nothing past it is read.
  if (manifest.schema !== SCHEMA) return { ok: false, name, problems: [`schema is ${JSON.stringify(manifest.schema)}, not ${SCHEMA}`] };
  if (manifest.version !== VERSION) return { ok: false, name, problems: [`version is ${JSON.stringify(manifest.version)}, not ${VERSION}`] };

  const problems = [];
  if (!isString(manifest.name)) problems.push('no name');
  if (!isString(manifest.lang)) problems.push('no lang');
  if (!isStrings(manifest.closes)) problems.push('closes must be an array');
  if (!Array.isArray(manifest.acts) || manifest.acts.length === 0) problems.push('acts must be a non-empty array');
  else manifest.acts.forEach((act, index) => problems.push(...actProblems(act, index)));
  if (manifest.ran !== undefined && !(isObject(manifest.ran) && isString(manifest.ran.on) && isString(manifest.ran.note))) {
    problems.push('ran must be { on, note }');
  }
  if (problems.length) return { ok: false, name, problems };
  return { ok: true, manifest };
}

/**
 * Every manifest in a memoro worktree: `{ manifests, unreadable }`, each in
 * file-name order. A directory that is not there is no manifests, not an
 * error — a memoro from before `language-manifest` has none.
 */
export function readManifests(worktree, { readDir = readdirSync, readFile = readFileSync } = {}) {
  let files;
  try {
    files = readDir(join(worktree, CUTOVER_DIR)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return { manifests: [], unreadable: [] };
  }
  const manifests = [];
  const unreadable = [];
  for (const file of files) {
    let text;
    try {
      text = readFile(join(worktree, CUTOVER_DIR, file), 'utf8');
    } catch (error) {
      unreadable.push({ name: file.replace(/\.json$/u, ''), problems: [`could not read: ${error.message}`] });
      continue;
    }
    const read = readManifest(text, { file });
    if (read.ok) manifests.push(read.manifest);
    else unreadable.push({ name: read.name, problems: read.problems });
  }
  return { manifests, unreadable };
}

/** The names of the manifests for `lang` whose `closes` names `use`. */
export function closingManifests(manifests, lang, use) {
  return manifests.filter((manifest) => manifest.lang === lang && manifest.closes.includes(use)).map((manifest) => manifest.name);
}

/**
 * A programme's record: `PROGRAMME.json` directly in its directory under the
 * programmes home. It says which horizon the programme serves, when it is
 * done and whether its document is signed. A programme without the file is a
 * programme as it always was.
 *
 * Written by the programme verbs (the pre-tool
 * hook keeps a session's hand off it, as it does GOAL.json); read by `mc
 * programs show`, the list and the page. Each write is validated before it is
 * made. Creation never replaces a file; all read/change/replace writers take the
 * runner's strict lock around their fresh read and atomic write.
 */
import { linkSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic-write.js';
import { canonRoot } from './canon.js';
import { NAME_RE } from './plan-schema.js';
import { workRoot } from './paths.js';
import { realLock } from './runner-lock.js';

export const RECORD_FILE = 'PROGRAMME.json';
export const RECORD_SCHEMA = 'mc-programme';
export const RECORD_VERSION = 2;
export const RECORD_STATES = Object.freeze(['draft', 'open', 'done', 'dropped']);
export const RECORD_AUTHORS = Object.freeze(['person', 'martin', 'manager']);
const V1_KEYS = Object.freeze(['schema', 'version', 'horizon', 'area', 'end', 'state', 'created', 'created_by', 'phases']);
const SIGNATURE_KEYS = Object.freeze(['signed_at', 'signed_by', 'signed_text']);
const KEYS = Object.freeze([...V1_KEYS, ...SIGNATURE_KEYS, 'cut_text', 'legacy']);
const UNSIGNED = Object.freeze({ signed_at: null, signed_by: null, signed_text: null, cut_text: null });
/** The one value of `area`: `<repo>/<id>`, an area a repository declares; the programme repairs that area's text and serves no horizon. */
export const AREA_RE = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z][a-z0-9-]*$/u;
/** The one value of `phases.order`: the programme's phases wait for what the record says and for nothing else. */
export const PHASES_ORDER = 'stated';
const PHASE_NUMBER = /^[1-9]\d*$/u;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u;
const SIGNED_INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const isInstant = (value) => typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const instant = (date) => date.toISOString().replace(/\.\d+Z$/u, 'Z');

/** Reading old records is not a migration. Only an actual write persists this representation. */
function normalized(record) {
  return record.version === 1 ? { ...record, version: RECORD_VERSION, ...UNSIGNED, legacy: true } : record;
}

/**
 * A cycle in `after` (`{ "<phase>": [phases it waits for] }`), as the phases of
 * one cycle in the order they wait for each other, or null.
 */
export function cycleOf(after) {
  const waits = (phase) => (Array.isArray(after?.[phase]) ? after[phase] : []);
  const done = new Set();
  const walk = (phase, path) => {
    if (path.includes(phase)) return path.slice(path.indexOf(phase));
    if (done.has(phase)) return null;
    for (const next of waits(phase)) {
      const found = walk(String(next), [...path, phase]);
      if (found) return found;
    }
    done.add(phase);
    return null;
  };
  for (const phase of Object.keys(after ?? {})) {
    const found = walk(phase, []);
    if (found) return found.map(Number).sort((a, b) => a - b);
  }
  return null;
}

/** The problems of a parsed `phases` value; none when it is of the form of the record. */
function phasesProblems(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['phases: an object { "order": "stated", "after": { "<phase>": [<phases it waits for>] } }'];
  const problems = [];
  for (const key of Object.keys(value)) if (key !== 'order' && key !== 'after') problems.push(`phases.${key}: unknown key`);
  if (value.order !== PHASES_ORDER) problems.push(`phases.order: must be "${PHASES_ORDER}"`);
  if (value.after === undefined) return problems;
  const { after } = value;
  if (after === null || typeof after !== 'object' || Array.isArray(after)) { problems.push('phases.after: an object with a key for each phase that waits'); return problems; }
  for (const [key, list] of Object.entries(after)) {
    if (!PHASE_NUMBER.test(key)) { problems.push(`phases.after.${key}: the key must be a phase number, a whole number from 1`); continue; }
    const ok = Array.isArray(list) && list.length > 0 && list.every((n) => Number.isSafeInteger(n) && n >= 1)
      && list.every((n, at) => at === 0 || n > list[at - 1]);
    if (!ok) { problems.push(`phases.after.${key}: the phases it waits for, whole numbers from 1, ascending, none twice, at least one`); continue; }
    if (list.includes(Number(key))) problems.push(`phases.after.${key}: phase ${key} cannot wait for itself`);
  }
  if (!problems.length) {
    const cycle = cycleOf(after);
    if (cycle) problems.push(`phases.after: phases ${cycle.join(', ')} wait for one another in a cycle`);
  }
  return problems;
}

/** The problems of a parsed value; none when it is a record. */
export function validateRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['the record must be a JSON object'];
  const problems = [];
  const keys = value.version === 1 ? V1_KEYS : KEYS;
  for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push(`${key}: unknown key`);
  if (value.schema !== RECORD_SCHEMA) problems.push(`schema: must be "${RECORD_SCHEMA}"`);
  if (value.version !== 1 && value.version !== RECORD_VERSION) problems.push(`version: must be 1 or ${RECORD_VERSION}`);
  if (value.horizon !== null && !(typeof value.horizon === 'string' && NAME_RE.test(value.horizon))) problems.push('horizon: a slug (lower-case letters, digits and hyphens), or null');
  if (value.area !== undefined) {
    if (typeof value.area !== 'string' || !AREA_RE.test(value.area)) problems.push('area: <repo>/<id>, an area a repository declares');
    if (value.horizon !== null) problems.push('area: allowed only with horizon null — a programme serves a horizon or repairs an area, not both');
  }
  if (typeof value.end !== 'string' || !value.end.trim()) problems.push('end: a non-empty sentence saying when the programme is done');
  const states = value.version === 1 ? ['open', 'done'] : RECORD_STATES;
  if (!states.includes(value.state)) problems.push(`state: one of ${states.join(', ')}`);
  if (!isInstant(value.created)) problems.push('created: an ISO instant in UTC to the second');
  if (!RECORD_AUTHORS.includes(value.created_by)) problems.push(`created_by: one of ${RECORD_AUTHORS.join(', ')}`);
  if (value.phases !== undefined) problems.push(...phasesProblems(value.phases));
  if (value.version === RECORD_VERSION) {
    if (value.legacy !== undefined && typeof value.legacy !== 'boolean') problems.push('legacy: a boolean when present');
    if (value.signed_at !== null && !(typeof value.signed_at === 'string' && SIGNED_INSTANT.test(value.signed_at) && Number.isFinite(Date.parse(value.signed_at)))) problems.push('signed_at: an ISO instant in UTC, or null');
    if (value.signed_by !== null && value.signed_by !== 'martin') problems.push('signed_by: martin, or null');
    for (const key of ['signed_text', 'cut_text']) {
      if (value[key] !== null && !(typeof value[key] === 'string' && SHA256.test(value[key]))) problems.push(`${key}: a sha256 hex digest, or null`);
    }
    const empty = SIGNATURE_KEYS.every((key) => value[key] === null);
    const full = SIGNATURE_KEYS.every((key) => value[key] !== null && value[key] !== undefined);
    if (value.state === 'draft' || value.state === 'dropped') {
      if (!empty) problems.push('signed_at/signed_by/signed_text: must be null in draft and dropped');
    } else if (value.state === 'open' || value.state === 'done') {
      if (!(full || (empty && (value.area || value.legacy === true)))) problems.push('signed_at/signed_by/signed_text: required together in open and done, except an unsigned area repair or legacy record');
    }
  }
  return problems;
}

/** A new record, the keys in their order; `stated` opts the programme's phases in (`mc programs create`). */
export function newRecord({ horizon = null, area = null, end, createdBy, now = new Date(), stated = false }) {
  return {
    schema: RECORD_SCHEMA,
    version: RECORD_VERSION,
    horizon,
    ...(area ? { area } : {}),
    end,
    state: area ? 'open' : 'draft',
    created: instant(now),
    created_by: createdBy,
    ...UNSIGNED,
    ...(stated ? { phases: { order: PHASES_ORDER } } : {}),
  };
}

/**
 * What one programme directory holds: `{ status: 'none' }`, `{ status: 'valid',
 * record }` or `{ status: 'invalid', problems }`. A file that is not JSON is a
 * problem, never an error thrown.
 */
export function readRecord(dir, { read = (path) => readFileSync(path, 'utf8') } = {}) {
  let text;
  try { text = read(join(dir, RECORD_FILE)); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 'none' };
    return { status: 'invalid', problems: [`${RECORD_FILE} cannot be read: ${error.message}`] };
  }
  if (text === null || text === undefined) return { status: 'none' };
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { return { status: 'invalid', problems: [`not JSON: ${error.message}`] }; }
  const problems = validateRecord(parsed);
  return problems.length ? { status: 'invalid', problems } : { status: 'valid', record: normalized(parsed) };
}

/** The record as `mc programs list --json` and `show --json` give it: null, its facts, or its problems. */
export function recordView(read, { dir } = {}) {
  if (read.status === 'valid') {
    const { horizon, end, state, created, created_by: createdBy } = read.record;
    const { signed_at, signed_by, signed_text, cut_text, legacy } = read.record;
    return { horizon, ...(read.record.area ? { area: read.record.area } : {}), end, state, created, created_by: createdBy,
      signed_at, signed_by, signed_text, cut_text, ...(legacy !== undefined ? { legacy } : {}),
      ...(dir && signed_text ? { designs_changed: designsChanged(dir) } : {}),
      ...(read.record.phases ? { phases: read.record.phases } : {}) };
  }
  return read.status === 'invalid' ? { problems: read.problems } : null;
}

/** The directories under `home` that hold a PROGRAMME.json, valid or not. */
export function recordedProgrammes(home) {
  let entries;
  try { entries = readdirSync(home, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name) && readRecord(join(home, entry.name)).status !== 'none')
    .map((entry) => entry.name)
    .sort();
}

/**
 * Create only: the record is validated, written whole to a temporary file
 * beside its place and linked there, which fails when the file exists — so a
 * record is never replaced, not even by a caller that raced this one.
 */
export function writeRecord(dir, record) {
  const problems = validateRecord(record);
  if (problems.length) throw new Error(`not a programme record: ${problems.join('; ')}`);
  const path = join(dir, RECORD_FILE);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalized(record), null, 2)}\n`, { mode: 0o600 });
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
  return path;
}

/**
 * The one change to a record that is there: its `phases`. `change` is given the
 * current `phases` (undefined when the record has none) and returns the new
 * one; the whole result is validated and written whole (`write`, atomic), every other key as it
 * was, in its place. An invalid record or none is never touched. Returns
 * `{ ok: true, record, changed }` or `{ ok: false, status, problems }`.
 */
export function changePhases(dir, change, options = {}) {
  return replaceRecord(dir, (record) => {
    const phases = change(record.phases);
    return phases === undefined ? record : { ...record, phases };
  }, options, 'programme-phases');
}

/**
 * The one other change to a record that is there: its `state`. The runner sets it to `done` once it has archived a
 * programme (archive-turn.js); `writeRecord` stays create-only. Validated and written whole and atomically (`write`), every
 * other key as it was, in its place; a record already in that state is not written again. An invalid record or none is never
 * touched. Returns `{ ok: true, record, changed }` or `{ ok: false, status, problems }`.
 */
export function setRecordState(dir, state, options = {}) {
  return replaceRecord(dir, (record) => ({ ...record, state }), options, 'programme-state');
}

/** Stable file order and the bytes of every design, including nested files. Missing designs is an empty list. */
function designHashes(dir) {
  const entries = [];
  const visit = (path, prefix) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(path, entry.name), `${name}/`);
      else entries.push({ path: name, sha256: sha256(readFileSync(join(path, entry.name))) });
    }
  };
  const designs = join(dir, 'designs');
  try { visit(designs, 'designs/'); } catch (error) {
    // Only the absent root is optional; a missing/unreadable entry is not an empty design set.
    if (error.code !== 'ENOENT' || error.path !== designs) throw error;
  }
  return entries;
}

/** Compare the complete signed inventory, so additions and removals also count as drift. */
function designsChanged(dir) {
  try {
    const signed = readFileSync(join(dir, 'SIGNED.md'), 'utf8');
    const marker = '\n## Signed designs\n\n';
    const start = signed.lastIndexOf(marker);
    if (start < 0) return true;
    const current = designHashes(dir).map((file) => `${file.sha256}  ${file.path}\n`).join('');
    return signed.slice(start + marker.length) !== current;
  } catch { return true; }
}

/** Capture the working document and design hashes before opening the record. The command supplies reading/structure checks. */
export function signRecord(dir, { at = new Date(), check = () => [], ...options } = {}) {
  let signed;
  return replaceRecord(dir, (record) => {
    const text = readFileSync(join(dir, 'README.md'), 'utf8');
    const problems = check({ record, text });
    if (problems.length) return { problems };
    const designs = designHashes(dir);
    signed = `${text}${text.endsWith('\n') ? '' : '\n'}\n## Signed designs\n\n${designs.map((file) => `${file.sha256}  ${file.path}\n`).join('')}`;
    const { legacy, ...rest } = record;
    return { ...rest, state: 'open', signed_at: instant(at), signed_by: 'martin', signed_text: sha256(signed) };
  }, options, 'programme-sign', {
    state: 'draft',
    beforeWrite: (write) => write(join(dir, 'SIGNED.md'), signed),
  });
}

/** Keep the previous signed copy and consumed signature: a re-sign must be cut again. */
export function returnRecord(dir, options = {}) {
  return replaceRecord(dir, (record) => ({ ...record, state: 'draft', signed_at: null, signed_by: null, signed_text: null }), options, 'programme-return', { state: 'open' });
}

/** Shelving and its reason belong to the command; this writer never moves or deletes a directory. */
export function dropRecord(dir, options = {}) {
  return replaceRecord(dir, (record) => ({ ...record, state: 'dropped' }), options, 'programme-drop', { state: 'draft' });
}

/** Fresh read, validation and atomic replacement share the runner's strict lock. Create stays create-only. */
function replaceRecord(dir, change, { root = workRoot(), lock = realLock, read, write = writeFileAtomic }, name, { state, beforeWrite } = {}) {
  return lock(root, () => {
    const found = readRecord(dir, read ? { read } : {});
    if (found.status !== 'valid') return { ok: false, status: found.status, problems: found.problems ?? [] };
    if (state && found.record.state !== state) return { ok: false, status: 'refused', problems: [`state: must be ${state}, reads ${found.record.state}`] };
    const record = change(found.record);
    if (record.problems) return { ok: false, status: 'refused', problems: record.problems };
    const problems = validateRecord(record);
    if (problems.length) return { ok: false, status: 'refused', problems };
    const changed = JSON.stringify(record) !== JSON.stringify(found.record);
    if (changed) {
      beforeWrite?.(write);
      write(join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
    }
    return { ok: true, record, changed };
  }, { strict: true, name });
}

/** The record page's fenced markdown block in the packaged canon, or null when it cannot be read. */
export function recordPageTemplate({ canon = canonRoot(), area = null } = {}) {
  let source;
  try { source = readFileSync(join(canon, 'tasks', 'references', area ? 'repair-page.md' : 'programme-document.md'), 'utf8'); } catch { return null; }
  return source.match(/^```markdown\r?\n([\s\S]*?)\r?\n```/mu)?.[1] ?? null;
}

const DOCUMENT_HEADINGS = Object.freeze(['What it is for', 'End', 'Why', 'What runs today', 'Parts', 'Order', 'Decided by signing', 'Not built', 'Read before sign-off', 'Where things are']);
const PART_LABELS = Object.freeze(['Closes', 'Solution', 'Design', 'Proved by', 'Not in this part']);

/** Structure only: code does not judge prose, design quality, or whether a proposal is good enough. */
export function documentProblems(text) {
  // Quoted examples inside fences cannot stand in for the document's own headings/entries.
  const lines = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gmu, '').split(/\r?\n/u);
  const problems = [];
  const title = lines.findIndex((line) => line.trim());
  if (title < 0 || !/^# \S/u.test(lines[title])) problems.push('title: missing nonempty # <programme> title');
  const firstSection = lines.findIndex((line) => /^## /u.test(line));
  const preamble = lines.slice(title + 1, firstSection < 0 ? lines.length : firstSection);
  const repos = preamble.findIndex((line) => /^Repositories:/u.test(line));
  if (repos < 0 || !preamble[repos].slice('Repositories:'.length).trim()) problems.push('Repositories: missing nonempty repository line before What it is for');
  if (!preamble.slice(0, repos < 0 ? preamble.length : repos).some((line) => line.trim() && !/^#/u.test(line))) problems.push('scope: missing paragraph after title and before Repositories:');
  let previous = firstSection - 1;
  for (const heading of DOCUMENT_HEADINGS) {
    const start = lines.indexOf(`## ${heading}`);
    if (start < 0 || start <= previous) {
      problems.push(`## ${heading}: missing or out of order`);
      continue;
    }
    previous = start;
    let end = lines.findIndex((line, at) => at > start && /^## /u.test(line));
    if (end < 0) end = lines.length;
    const body = lines.slice(start + 1, end);
    if (!body.some((line) => line.trim() && !/^#/u.test(line))) problems.push(`## ${heading}: empty entry`);
    if (heading !== 'Parts') continue;
    const parts = body.flatMap((line, at) => (/^### Part [1-9]\d*\s+—\s+\S/u.test(line) ? [at] : []));
    if (!parts.length) problems.push('## Parts: missing ### Part n — <name>');
    for (const [index, at] of parts.entries()) {
      const part = body.slice(at + 1, parts[index + 1] ?? body.length);
      let last = -1;
      for (const label of PART_LABELS) {
        const position = part.findIndex((line) => new RegExp(`^${label}\\b`, 'u').test(line));
        if (position < 0 || position <= last) {
          problems.push(`${body[at]}: ${label} missing or out of order`);
          continue;
        }
        last = position;
        let next = part.findIndex((line, n) => n > position && PART_LABELS.some((other) => new RegExp(`^${other}\\b`, 'u').test(line)));
        if (next < 0) next = part.length;
        const content = [part[position].slice(label.length).replace(/^[\s:,—-]+/u, ''), ...part.slice(position + 1, next)];
        if (!content.some((line) => line.trim())) problems.push(`${body[at]}: ${label} empty entry`);
      }
    }
  }
  return problems;
}

/** `text` with the body of its `## heading` section replaced; unchanged when there is no such section. */
function withSection(text, heading, body) {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return text;
  let end = lines.findIndex((line, at) => at > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start + 1), '', ...body.split('\n'), '', ...lines.slice(end)].join('\n');
}

/**
 * The page of a new programme with a record: the template with the name in its
 * first line, the end sentence under End and, when there is one, the horizon
 * under What it is for (or the area it repairs), followed by `purpose` when one is given. What the plan
 * session writes is left as placeholders.
 */
export function recordPage(template, { name, end, horizon, area = null, purpose = null }) {
  let page = template.replace(/^# <programme>/mu, `# ${name}`);
  page = withSection(page, 'End', end.trim().replace(/^#/gmu, '\\#'));
  const said = purpose?.trim() ? purpose.trim().replace(/^#/gmu, '\\#') : null;
  if (horizon) page = withSection(page, 'What it is for', `Serves the horizon \`${horizon}\`. ${said ?? '<The part of that horizon this programme delivers.>'}`);
  else if (area) page = withSection(page, 'What it is for', `Repairs the text of the area \`${area}\`, a programme without a horizon. ${said ?? '<What in that area text is wrong or missing.>'}`);
  else if (said) page = withSection(page, 'What it is for', said);
  return page.endsWith('\n') ? page : `${page}\n`;
}

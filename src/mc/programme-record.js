/**
 * A programme's record: `PROGRAMME.json` directly in its directory under the
 * programmes home. It says which horizon the programme serves, when it is
 * done and whether it is still open. A programme without the file is a
 * programme as it always was.
 *
 * Written by `mc programs create` and `mc programs record` only (the pre-tool
 * hook keeps a session's hand off it, as it does GOAL.json); read by `mc
 * programs show`, the list and the page. Each write is validated before it is
 * made and never replaces a file that is there.
 */
import { linkSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonRoot } from './canon.js';
import { NAME_RE } from './plan-schema.js';

export const RECORD_FILE = 'PROGRAMME.json';
export const RECORD_SCHEMA = 'mc-programme';
export const RECORD_VERSION = 1;
export const RECORD_STATES = Object.freeze(['open', 'done']);
export const RECORD_AUTHORS = Object.freeze(['person', 'martin', 'manager']);
const KEYS = Object.freeze(['schema', 'version', 'horizon', 'end', 'state', 'created', 'created_by']);
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u;

/** The problems of a parsed value; none when it is a record. */
export function validateRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['the record must be a JSON object'];
  const problems = [];
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) problems.push(`${key}: unknown key`);
  if (value.schema !== RECORD_SCHEMA) problems.push(`schema: must be "${RECORD_SCHEMA}"`);
  if (value.version !== RECORD_VERSION) problems.push(`version: must be ${RECORD_VERSION}`);
  if (value.horizon !== null && !(typeof value.horizon === 'string' && NAME_RE.test(value.horizon))) problems.push('horizon: a slug (lower-case letters, digits and hyphens), or null');
  if (typeof value.end !== 'string' || !value.end.trim()) problems.push('end: a non-empty sentence saying when the programme is done');
  if (!RECORD_STATES.includes(value.state)) problems.push(`state: one of ${RECORD_STATES.join(', ')}`);
  if (typeof value.created !== 'string' || !INSTANT.test(value.created) || !Number.isFinite(Date.parse(value.created))) problems.push('created: an ISO instant in UTC to the second');
  if (!RECORD_AUTHORS.includes(value.created_by)) problems.push(`created_by: one of ${RECORD_AUTHORS.join(', ')}`);
  return problems;
}

/** A new record, the keys in their order. */
export function newRecord({ horizon = null, end, createdBy, now = new Date() }) {
  return {
    schema: RECORD_SCHEMA,
    version: RECORD_VERSION,
    horizon,
    end,
    state: 'open',
    created: now.toISOString().replace(/\.\d+Z$/u, 'Z'),
    created_by: createdBy,
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
  return problems.length ? { status: 'invalid', problems } : { status: 'valid', record: parsed };
}

/** The record as `mc programs list --json` and `show --json` give it: null, its facts, or its problems. */
export function recordView(read) {
  if (read.status === 'valid') {
    const { horizon, end, state, created, created_by: createdBy } = read.record;
    return { horizon, end, state, created, created_by: createdBy };
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
 * The only writer: the record is validated, written whole to a temporary file
 * beside its place and linked there, which fails when the file exists — so a
 * record is never replaced, not even by a caller that raced this one.
 */
export function writeRecord(dir, record) {
  const problems = validateRecord(record);
  if (problems.length) throw new Error(`not a programme record: ${problems.join('; ')}`);
  const path = join(dir, RECORD_FILE);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
  return path;
}

/** The record page's fenced markdown block in the packaged canon, or null when it cannot be read. */
export function recordPageTemplate({ canon = canonRoot() } = {}) {
  let source;
  try { source = readFileSync(join(canon, 'tasks', 'references', 'programme-record-readme.md'), 'utf8'); } catch { return null; }
  return source.match(/^```markdown\r?\n([\s\S]*?)\r?\n```/mu)?.[1] ?? null;
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
 * under What it is for. What the plan session writes is left as placeholders.
 */
export function recordPage(template, { name, end, horizon }) {
  let page = template.replace(/^# <programme>/mu, `# ${name}`);
  page = withSection(page, 'End', end.trim().replace(/^#/gmu, '\\#'));
  if (horizon) page = withSection(page, 'What it is for', `Serves the horizon \`${horizon}\`. <The part of that horizon this programme delivers.>`);
  return page.endsWith('\n') ? page : `${page}\n`;
}

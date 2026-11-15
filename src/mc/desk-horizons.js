/**
 * Model-free store of the horizons the desk holds: `~/mc/martin/horizons/<slug>/` with `horizon.json`,
 * `playback.md` and, once reached, `reached.md`. The order of the open horizons is the priority.
 * Every write is one read-modify-write under the strict runner lock (`updateDeskHorizons`); reads take none.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from './atomic-write.js';
import { martinDir, workRoot } from './paths.js';
import { NAME_RE } from './plan-schema.js';
import { realLock } from './runner-lock.js';

export const HORIZON_STATES = ['open', 'reached', 'dropped'];
export const HORIZON_SCHEMA = 'mc-desk-horizon';
/** The playback's five parts: the key `show --json` gives, and the heading. */
export const PLAYBACK_PARTS = [
  ['read', 'How it is read'],
  ['reached', 'How one sees it is reached'],
  ['first', 'What is built first'],
  ['not_built', 'What is not built'],
  ['strangest', 'The strangest thing the wording permits'],
];

export function horizonsDir(env = process.env) { return join(martinDir(env), 'horizons'); }
export function validSlug(slug) { return typeof slug === 'string' && NAME_RE.test(slug); }

const text = (path) => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } };

/** The body of `horizon set --file`: the five headings, in order, each with text. Returns `{ parts }` or `{ error }`. */
export function parsePlaybackInput(input) {
  const lines = String(input ?? '').split('\n');
  const expected = PLAYBACK_PARTS.map(([, title]) => `## ${title}`);
  const seen = lines.filter((line) => /^## /u.test(line)).map((line) => line.trim());
  if (seen.length !== expected.length || expected.some((heading, index) => seen[index] !== heading)) {
    return { error: `a playback has exactly five parts, in this order: ${expected.join(', ')}` };
  }
  const parts = playbackParts(input);
  const missing = PLAYBACK_PARTS.filter(([key]) => !parts[key]).map(([, title]) => title);
  return missing.length ? { error: `empty part: ${missing.join(', ')}` } : { parts };
}

/** The text under each of the five headings, trimmed; an absent heading reads as empty. */
function playbackParts(input) {
  const parts = Object.fromEntries(PLAYBACK_PARTS.map(([key]) => [key, '']));
  const lines = String(input ?? '').split('\n');
  let key = null; let buffer = [];
  const flush = () => { if (key) parts[key] = buffer.join('\n').trim(); buffer = []; };
  for (const line of lines) {
    const heading = /^## /u.test(line) ? PLAYBACK_PARTS.find(([, title]) => `## ${title}` === line.trim()) : null;
    if (heading) { flush(); key = heading[0]; } else if (key) buffer.push(line);
  }
  flush();
  return parts;
}

/** A record that holds the schema, a valid slug equal to its directory's name and a known state; else null. */
function recordOf(raw, name) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema !== HORIZON_SCHEMA || !validSlug(value.slug) || value.slug !== name || !HORIZON_STATES.includes(value.state)) return null;
  return value;
}

const at = (value) => (Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0);
const place = (record) => (Number.isInteger(record.position) ? record.position : Infinity);
const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
/** The order the readers use: open ones by position, then set time, then slug, so an interrupted write still has one order. */
const priority = (a, b) => place(a) - place(b) || at(a.set_at) - at(b.set_at) || bySlug(a, b);
const newest = (field) => (a, b) => at(b[field]) - at(a[field]) || bySlug(a, b);

/** Every horizon, open ones first in order, then reached, then dropped (newest first); and the directories whose record cannot be read. Takes no lock. */
export function readHorizons({ env = process.env, state = null } = {}) {
  const dir = horizonsDir(env);
  let names = [];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort(); } catch { names = []; }
  const found = []; const unreadable = [];
  for (const name of names) {
    let raw;
    try { raw = text(join(dir, name, 'horizon.json')); } catch { unreadable.push(name); continue; }
    if (raw === null) continue; // an interrupted `set`: no record, no horizon
    const record = recordOf(raw, name);
    if (record) found.push(record); else unreadable.push(name);
  }
  const ordered = [
    ...found.filter((x) => x.state === 'open').sort(priority),
    ...found.filter((x) => x.state === 'reached').sort(newest('reached_at')),
    ...found.filter((x) => x.state === 'dropped').sort(newest('dropped_at')),
  ];
  return { horizons: state ? ordered.filter((x) => x.state === state) : ordered, unreadable };
}

/** One horizon whole: its record, the playback by part and, when reached, what is now true. Null when there is no readable record of that slug. */
export function readHorizon(slug, { env = process.env } = {}) {
  if (!validSlug(slug)) return null;
  const record = readHorizons({ env }).horizons.find((x) => x.slug === slug);
  if (!record) return null;
  const dir = join(horizonsDir(env), slug);
  let playback; let nowTrue = null;
  try { playback = playbackParts(text(join(dir, 'playback.md'))); } catch { playback = playbackParts(''); }
  if (record.state === 'reached') { try { nowTrue = text(join(dir, 'reached.md')); } catch { nowTrue = null; } }
  return { ...record, playback, now_true: nowTrue };
}

/**
 * The one writer: takes the strict runner lock once, reads the records inside the hold and hands them to `change`, which
 * returns `{ files, records, ... }` (what to write) or `{ error }` (a refusal, nothing written). Returns that plan.
 */
export function updateDeskHorizons(change, { env = process.env, lock = realLock } = {}) {
  return lock(workRoot(env), () => {
    const next = change(readHorizons({ env }));
    if (next.error) return next;
    const dir = horizonsDir(env);
    // A file the record points at is written before the record.
    for (const file of next.files) writeFileAtomic(join(dir, file.slug, file.name), file.text);
    for (const record of next.records) writeJsonAtomic(join(dir, record.slug, 'horizon.json'), record);
    return next;
  }, { strict: true, name: 'desk-horizon' });
}

// ---- What each verb decides, on the records read inside the hold -----------------------------

const rank = (list) => list.map((record, index) => (record.position === index + 1 ? null : { ...record, position: index + 1 })).filter(Boolean);
/** The open horizons in the order given, numbered 1..n; the records whose position changes. `keep` are records already written by the verb itself. */
function renumber(open, fresh) {
  const changed = new Map(rank(open).map((record) => [record.slug, record]));
  const records = [];
  for (const record of fresh) records.push(changed.get(record.slug) ?? record);
  for (const [slug, record] of changed) if (!fresh.some((x) => x.slug === slug)) records.push(record);
  return records;
}
const insertAt = (list, record, position) => { const next = list.filter((x) => x.slug !== record.slug); next.splice(position - 1, 0, record); return next; };
const openOf = (horizons) => horizons.filter((x) => x.state === 'open');
const lookup = (held, slug) => {
  if (held.unreadable.includes(slug)) return { error: `horizon ${slug} has a record that cannot be read; it is left as it is` };
  const record = held.horizons.find((x) => x.slug === slug);
  return record ? { record } : { error: `unknown horizon ${slug}` };
};
const outOfRange = (position, last) => `--position must be a whole number from 1 to ${last}`;

export function planSet(held, { slug, title, playback, position, by, now }) {
  if (held.unreadable.includes(slug)) return { error: `horizon ${slug} has a record that cannot be read; it is left as it is` };
  const taken = held.horizons.find((x) => x.slug === slug);
  if (taken) return { error: `horizon ${slug} exists (${taken.state}); a slug is not used twice` };
  const open = openOf(held.horizons);
  const place_ = position ?? open.length + 1;
  if (place_ > open.length + 1) return { error: outOfRange(position, open.length + 1) };
  const record = {
    schema: HORIZON_SCHEMA, version: 1, slug, title, state: 'open', position: place_, set_at: now, set_by: by,
    reached_at: null, reached_by: null, reopened_at: null, reopened_by: null, reopen_reason: null, dropped_at: null, dropped_by: null, drop_reason: null,
  };
  const records = renumber(insertAt(open, record, place_), [record]);
  return { files: [{ slug, name: 'playback.md', text: playback }], records, position: place_ };
}

export function planMove(held, { slug, position }) {
  const found = lookup(held, slug); if (found.error) return found;
  if (found.record.state !== 'open') return { error: `horizon ${slug} is ${found.record.state}; only an open horizon is moved` };
  const open = openOf(held.horizons);
  if (position > open.length) return { error: outOfRange(position, open.length) };
  return { files: [], records: renumber(insertAt(open, found.record, position), []), position };
}

export function planReached(held, { slug, statement, by, now }) {
  const found = lookup(held, slug); if (found.error) return found;
  if (found.record.state !== 'open') return { error: `horizon ${slug} is ${found.record.state}; only an open horizon is marked reached` };
  const record = { ...found.record, state: 'reached', position: null, reached_at: now, reached_by: by };
  const open = openOf(held.horizons).filter((x) => x.slug !== slug);
  return { files: [{ slug, name: 'reached.md', text: statement }], records: renumber(open, [record]) };
}

export function planReopen(held, { slug, reason, position, by, now }) {
  const found = lookup(held, slug); if (found.error) return found;
  if (found.record.state !== 'reached') return { error: `horizon ${slug} is ${found.record.state}; only a reached horizon is reopened` };
  const open = openOf(held.horizons);
  const place_ = position ?? open.length + 1;
  if (place_ > open.length + 1) return { error: outOfRange(position, open.length + 1) };
  const record = { ...found.record, state: 'open', position: place_, reached_at: null, reached_by: null, reopened_at: now, reopened_by: by, reopen_reason: reason };
  return { files: [], records: renumber(insertAt(open, record, place_), [record]), position: place_ };
}

export function planDrop(held, { slug, reason, by, now }) {
  const found = lookup(held, slug); if (found.error) return found;
  if (found.record.state !== 'open') return { error: `horizon ${slug} is ${found.record.state}; only an open horizon is dropped` };
  const record = { ...found.record, state: 'dropped', position: null, dropped_at: now, dropped_by: by, drop_reason: reason };
  return { files: [], records: renumber(openOf(held.horizons).filter((x) => x.slug !== slug), [record]) };
}

// ---- The opening's part ----------------------------------------------------------------------

/**
 * The horizons part of the opening as data, or null when the store holds neither a horizon nor an unreadable record.
 * `reached` are those marked reached in `(since, now]`, oldest first, each with the first three non-empty lines of what is now true.
 */
export function horizonsOpening({ env = process.env, since, now }) {
  const { horizons, unreadable } = readHorizons({ env });
  if (!horizons.length && !unreadable.length) return null;
  const sinceMs = at(since), nowMs = now.getTime();
  const reached = horizons.filter((x) => x.state === 'reached' && at(x.reached_at) > sinceMs && at(x.reached_at) <= nowMs)
    .sort((a, b) => at(a.reached_at) - at(b.reached_at) || bySlug(a, b))
    .map((x) => {
      let statement = null;
      try { statement = text(join(horizonsDir(env), x.slug, 'reached.md')); } catch { statement = null; }
      const first_lines = String(statement ?? '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3);
      return { slug: x.slug, title: x.title, reached_at: x.reached_at, reached_by: x.reached_by, first_lines };
    });
  const open = horizons.filter((x) => x.state === 'open').map((x) => ({ slug: x.slug, title: x.title, position: x.position }));
  return { reached, open, unreadable };
}

/** The part as lines, from its heading to its last line. */
export function renderHorizons(data) {
  const out = ['## Horizons', ''];
  if (data.reached.length) {
    out.push('Reached since the last opening:', '');
    for (const x of data.reached) {
      out.push(`- ${x.title} (${x.slug}) · reached ${x.reached_at} by ${x.reached_by}`);
      for (const line of x.first_lines) out.push(`  ${line}`);
    }
    out.push('');
  }
  if (data.open.length) {
    out.push('Open, in order:', '');
    data.open.forEach((x, index) => out.push(`${index + 1}. ${x.title} (${x.slug})`));
  } else out.push('No horizon is open.');
  if (data.unreadable.length) out.push('', `Records that cannot be read, left as they are: ${data.unreadable.join(', ')}.`);
  return out;
}

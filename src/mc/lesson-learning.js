/** Area learning records sit beside the original lesson; legacy writers do not rewrite them. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { itemDirectory, readDeskItem } from './desk-items.js';
import { martinDir } from './paths.js';

export const LEARNING_STATES = ['publishing', 'publication-pending', 'publication-failed', 'corrected',
  'already-accurate', 'insufficient-evidence', 'repair-proposal', 'held-decision'];
const read = (path) => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const root = (env) => join(martinDir(env), 'lessons', '.learning');
const pathOf = (name, env) => join(root(env), `${name}.json`);

/** Only evidence, never disposition, time of evaluation, repository HEAD or file mtime. */
export function lessonVersion(lesson, env) {
  const item = /^[a-f\d]{24}$/u.test(lesson.item ?? '') ? readDeskItem(lesson.item, { env }) : null;
  const dir = item && itemDirectory(item, env);
  const source = item && [item.text, item.state, item.outcome, item.chose, read(join(dir, 'brief.md')), read(join(dir, 'prepared.md'))];
  const prose = (value) => value?.trim().replace(/\s+/gu, ' ') ?? null;
  return createHash('sha256').update(JSON.stringify([
    lesson.kind, lesson.item, lesson.programme, lesson.place, Object.values(lesson.parts).map(prose), source?.map(x => typeof x === 'string' ? prose(x) : x),
  ])).digest('hex');
}

export function readLearning(lesson, env) {
  const raw = read(pathOf(lesson.name, env));
  if (raw !== null) {
    const value = JSON.parse(raw);
    if (value?.schema !== 1 || !LEARNING_STATES.includes(value.state)) throw new Error(`invalid area learning record for ${lesson.name}`);
    return value;
  }
  // Older lesson brief used dismissal to link this same text item.
  const legacy = lesson.state === 'dismissed' && /brought to him as a change to a text \(item ([a-f\d]{24})\)$/u.exec(lesson.reason ?? '');
  return legacy ? { state: 'held-decision', reference: legacy[1], links: { 'held-decision': legacy[1] }, legacy: true } : null;
}

export function writeLearning(lesson, entry, env) {
  mkdirSync(root(env), { recursive: true });
  writeJsonAtomic(pathOf(lesson.name, env), { ...entry, schema: 1 });
}

export function learningEligible(lesson, { manual = false } = {}) {
  const entry = lesson.learning;
  if (['publishing', 'publication-pending'].includes(entry?.state)) return false;
  if (!entry || entry.legacy) return lesson.state === 'open';
  if (lesson.state !== 'open' && !entry.legacyBrief) return false;
  if (entry.evidence !== lesson.evidence) return true;
  return entry.state === 'publication-failed' && (manual || entry.attempts < 2);
}

export function projectedLessonState(lesson) {
  const entry = lesson.learning;
  if (!entry || (lesson.state !== 'open' && !entry.legacy && !entry.legacyBrief)) return lesson.state;
  if (entry.legacy) return 'held-decision';
  if (!['publishing', 'publication-pending'].includes(entry.state) && entry.evidence !== lesson.evidence) return 'open';
  if (entry.state === 'publishing') return 'publication-pending';
  if (entry.state === 'insufficient-evidence') return 'open';
  if (entry.state === 'corrected') return 'landed';
  return entry.state;
}

export function lessonLandedAt(lesson) {
  return lesson.state === 'landed' ? lesson.landed_at : lesson.learning?.at;
}

export function learningLine(entry) {
  const ref = entry.url || entry.reference;
  const area = entry.area?.split('/').at(-1);
  if (entry.state === 'publishing') return `mc: ${area} — publication unconfirmed; correction pending`;
  if (entry.state === 'corrected') return `mc: ${area} — update on main in ${ref}`;
  if (entry.state === 'publication-pending' && ref) return `mc: ${area} — update published in ${ref}`;
  if (entry.state === 'publication-failed') return `mc: ${area} — publication failed; correction pending`
    + (entry.attempts >= 2 ? `\nmc: ${area} — retry pending; run mc learning` : '');
  if (entry.state === 'repair-proposal') return `mc: repair proposal ${ref}`;
  if (entry.state === 'held-decision') return `mc: holding decision at the desk ${ref}`;
  return null;
}

/**
 * A proposed change to a text Martin holds: the form it is brought in, and the one writer of its item.
 *
 * The form is stated once, in docs/technical/mc-martin.md (Durable desk items). Three writers bring it —
 * `mc martin propose`, the decision pass's `brief --sort text` and `lesson brief` — and all three call
 * `textForm`, so one function judges it. A text item has no source: only a close ends it, and no clock does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { deskItemId, itemDirectory, listDeskItems, updateDeskItem } from './desk-items.js';

/** The three parts of a text change's brief, in order. The headings are Swedish: what is written to Martin is. */
export const TEXT_PARTS = ['Vad den säger', 'Vad som föreslås', 'Vad som hittades'];

/** Sorts that name a text change: `text`, and the two old names a stored item or an old session may still use. */
export const TEXT_SORTS = ['text', 'product', 'judgement'];
export const isTextSort = (sort) => TEXT_SORTS.includes(sort);

/**
 * The form of a text change's brief: exactly three `##` parts, in order, each non-empty, no option and no
 * recommendation. `{ parts: { says, proposed, found } }` or `{ error }`, the error naming what is wrong.
 */
export function textForm(brief) {
  const text = String(brief ?? '').replace(/\r\n?/gu, '\n');
  const found = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.*?)\s*$/u.exec(line);
    if (heading) { current = { heading: heading[1], body: [] }; found.push(current); continue; }
    if (current) current.body.push(line);
    else if (line.trim()) return { error: 'the brief has text before its first ## part: it is exactly three ## parts, "## Vad den säger", "## Vad som föreslås", "## Vad som hittades"' };
  }
  const names = found.map((part) => part.heading);
  const missing = TEXT_PARTS.filter((name) => !names.includes(name));
  if (missing.length) return { error: `the brief lacks the part ${missing.map((name) => `"## ${name}"`).join(', ')}: it is exactly three ## parts, in order, "## ${TEXT_PARTS.join('", "## ')}"` };
  const extra = names.filter((name) => !TEXT_PARTS.includes(name));
  if (extra.length) return { error: `the brief has the part "## ${extra[0]}", which is not one of the three: it is exactly "## ${TEXT_PARTS.join('", "## ')}"` };
  if (names.length !== TEXT_PARTS.length) return { error: `the brief repeats a part: it is exactly three ## parts, "## ${TEXT_PARTS.join('", "## ')}"` };
  if (names.some((name, index) => name !== TEXT_PARTS[index])) return { error: `the brief's parts are out of order: they are "## ${TEXT_PARTS.join('", "## ')}"` };
  const bodies = found.map((part) => part.body.join('\n').trim());
  const empty = TEXT_PARTS.filter((name, index) => !bodies[index]);
  if (empty.length) return { error: `the part "## ${empty[0]}" is empty: each of the three has content` };
  return { parts: { says: bodies[0], proposed: bodies[1], found: bodies[2] } };
}

/** The text a proposal names: one non-empty line. `{ text }` or `{ error }`. */
export function textName(value) {
  if (typeof value !== 'string' || !value.trim()) return { error: '--text names the text to change, in one line (a path with its section, horizon:<slug>, or where a dated decision of his is recorded)' };
  if (/[\r\n]/u.test(value.trim())) return { error: '--text is one line' };
  return { text: value.trim() };
}

const squash = (value) => String(value).replace(/\s+/gu, ' ').trim();

/**
 * An open text item that already proposes this wording for this text: same `text`, same "Vad som föreslås" part,
 * whitespace aside. `read` takes an item directory and returns its brief.md or null.
 */
export function openProposal({ env, text, proposed, items = listDeskItems({ env }), read }) {
  return items.find((item) => item.kind === 'text' && item.state !== 'closed' && item.text === text && sameProposal(read(itemDirectory(item, env)), proposed)) ?? null;
}
function sameProposal(brief, proposed) {
  if (brief == null) return false;
  const form = textForm(brief);
  return Boolean(form.parts) && squash(form.parts.proposed) === squash(proposed);
}

/**
 * Write a text item straight to for-martin, in one hold of the strict runner lock: the duplicate is looked for and the
 * record and its brief written in that hold, so two proposals of one wording make one item. Nothing existing is
 * changed. `{ item, duplicate }`, or `{ error }` for a brief not in the form; a lock that cannot be had throws.
 */
export function proposeText({ env = process.env, text, brief, goal = null, now = new Date(), lock, read }) {
  const form = textForm(brief);
  if (form.error) return { error: form.error };
  const reference = `text:${text}`;
  const stamp = now.toISOString();
  const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('text', reference, stamp), kind: 'text', reference, text, goal,
    source_at: stamp, opened_at: stamp, state: 'for-martin', sort: 'text', reversible: null, due_at: null, outcome: null };
  let duplicate = null;
  const { written } = updateDeskItem(item.id, (current) => {
    const same = openProposal({ env, text, proposed: form.parts.proposed, read: read || readBrief });
    if (same) { duplicate = same; return null; }
    if (current) return null;
    writeFileAtomic(join(itemDirectory(item, env), 'brief.md'), `${String(brief).trim()}\n`);
    return item;
  }, { env, ...(lock ? { lock } : {}) });
  if (duplicate) return { item: duplicate, duplicate: true };
  if (!written) return { error: `an item for this text already exists at this second (${item.id}); propose again` };
  return { item, duplicate: false };
}

function readBrief(dir) { try { return readFileSync(join(dir, 'brief.md'), 'utf8'); } catch { return null; } }

/**
 * `goal-parts.js` — the parts of a version 2 goal (`goals.js`): the brief as
 * numbered parts instead of the free prose of version 1, so that each part can be
 * checked, amended and judged by itself.
 *
 *   aim, outcome, latitude, protection   prose: arrays of paragraphs, possibly empty
 *   problem B…  premises P…  decisions D…  change C…  preserve V…  risks R…  out_of_scope X…
 *                                        numbered items, each with the fields of its part
 *   obligations                          one per rule area, named by the area, not numbered
 *   ids                                  the highest number ever given per letter, never lowered
 *
 * `success_criteria` and `documents` are version 1's (`criteria.js`), a criterion
 * with an optional `evidence`. An id is the part's letter and `ids` plus one, so a
 * removed id is never given again. Everything here is pure: the verbs
 * (`commands/goal.js`) read a goal, call these and write it through `updateGoal`.
 */
import { criteriaCount, plain, prose, text, unknownKeys } from './criteria.js';

/** The prose parts, in the order a version 2 goal prints them (`goal set <part> --text`). */
export const PROSE_PARTS = Object.freeze(['aim', 'outcome', 'latitude', 'protection']);
/** The word `mc goal set` takes for each prose part of version 1, which a version 2 goal does not have. */
export const V1_PROSE_WORDS = Object.freeze(['goal', 'contract', 'out-of-scope']);

/** What a problem's basis may be: where its measurement came from. */
export const PROBLEM_BASES = Object.freeze(['measured', 'reported', 'inferred']);
/** What a premise's basis may be: how the claim was come by. */
export const PREMISE_BASES = Object.freeze(['read', 'measured', 'inferred']);
/** What an obligation's stand may be: whether the work touches the area. */
export const STANDS = Object.freeze(['touched', 'untouched']);

/**
 * The numbered parts, by the word `mc goal item add` takes: `key` the part's key
 * in GOAL.json, `letter` its ids', `order` the keys of an item as written,
 * `textKey` the one `--text` sets, `fields` the others, `choices` the values a
 * field is limited to. A field's flag is its key with `-` for `_`.
 */
function itemPart(word, key, letter, order, textKey, choices = {}) {
  return Object.freeze({ word, key, letter, order, textKey, fields: order.filter((name) => name !== 'id' && name !== textKey), choices });
}
export const ITEM_PARTS = Object.freeze({
  problem: itemPart('problem', 'problem', 'B', ['id', 'text', 'basis'], 'text', { basis: PROBLEM_BASES }),
  premise: itemPart('premise', 'premises', 'P', ['id', 'claim', 'source', 'basis', 'at'], 'claim', { basis: PREMISE_BASES }),
  decision: itemPart('decision', 'decisions', 'D', ['id', 'text', 'by', 'on'], 'text'),
  change: itemPart('change', 'change', 'C', ['id', 'where', 'what'], 'what'),
  preserve: itemPart('preserve', 'preserve', 'V', ['id', 'text', 'upheld_by'], 'text'),
  risk: itemPart('risk', 'risks', 'R', ['id', 'text', 'settled_by'], 'text'),
  'out-of-scope': itemPart('out-of-scope', 'out_of_scope', 'X', ['id', 'text', 'owner'], 'text'),
});
/** The words `item add` takes, in order. */
export const ITEM_WORDS = Object.freeze(Object.keys(ITEM_PARTS));
const PART_OF_LETTER = Object.freeze(Object.fromEntries(Object.values(ITEM_PARTS).map((part) => [part.letter, part])));
/** The id letters, in the order `ids` is written. */
export const ID_LETTERS = Object.freeze(['B', 'P', 'D', 'C', 'V', 'R', 'X']);
/** The keys of an obligation. */
export const OBLIGATION_KEYS = Object.freeze(['area', 'stand', 'text', 'standard']);

/** A version 2 GOAL.json's keys, in the order it is written. */
export const GOAL_KEYS_V2 = Object.freeze([
  'schema', 'version', 'stage', 'status', 'phase', 'repos', 'class', 'created', 'prs',
  'title', 'aim', 'outcome', 'problem', 'premises', 'decisions', 'change', 'latitude', 'preserve', 'obligations', 'risks',
  'success_criteria', 'protection', 'out_of_scope', 'documents', 'ids',
]);

/** `{ B: 0, P: 0, … }`: the `ids` of a goal that has given none. */
export function emptyIds() {
  return Object.fromEntries(ID_LETTERS.map((letter) => [letter, 0]));
}

/** The flag name of an item field: `upheld_by` is `upheld-by`. */
export function flagOf(field) {
  return field.replaceAll('_', '-');
}

const ID_RE = /^([A-Z])([1-9]\d*)$/u;

/** The part an id belongs to (by its letter), or null. */
export function partOfId(id) {
  const match = ID_RE.exec(String(id));
  return match ? PART_OF_LETTER[match[1]] ?? null : null;
}

/**
 * The problems of a version 2 goal's parts, pushed onto `problems`: each prose
 * part an array of paragraphs; each numbered part an array of items with its own
 * keys, non-blank texts, a basis from its list, an id of its letter once and not
 * above the part's number in `ids`; obligations with a stand and one per area;
 * and `ids` itself.
 */
export function validateParts(value, problems) {
  for (const key of PROSE_PARTS) {
    if (value[key] !== undefined && !prose(value[key], { min: 0 })) problems.push(`${key}: an array of paragraphs, possibly empty`);
  }
  const ids = plain(value.ids) ? value.ids : null;
  if (!ids) problems.push('ids: { B, P, D, C, V, R, X }, the highest number ever given in each part');
  else {
    for (const key of unknownKeys(ids, ID_LETTERS)) problems.push(`ids.${key}: unknown key`);
    for (const letter of ID_LETTERS) if (!Number.isInteger(ids[letter]) || ids[letter] < 0) problems.push(`ids.${letter}: a whole number from 0, not ${JSON.stringify(ids[letter])}`);
  }
  for (const part of Object.values(ITEM_PARTS)) validateItems(value[part.key], part, ids, problems);
  validateObligations(value.obligations, problems);
}

function validateItems(list, part, ids, problems) {
  if (list === undefined) return;
  if (!Array.isArray(list)) { problems.push(`${part.key}: an array, possibly empty`); return; }
  const seen = new Set();
  list.forEach((item, index) => {
    const at = `${part.key}[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    for (const key of unknownKeys(item, part.order)) problems.push(`${at}.${key}: unknown key`);
    const match = typeof item.id === 'string' ? ID_RE.exec(item.id) : null;
    if (!match || match[1] !== part.letter) problems.push(`${at}.id: ${part.letter} and a number, like ${part.letter}1`);
    else if (seen.has(item.id)) problems.push(`${at}.id: ${item.id} is given twice`);
    else {
      seen.add(item.id);
      if (ids && Number.isInteger(ids[part.letter]) && Number(match[2]) > ids[part.letter]) problems.push(`${at}.id: ${item.id} is above ${part.letter} in ids (${ids[part.letter]}) — ids holds the highest number given`);
    }
    for (const field of part.order.filter((name) => name !== 'id')) {
      if (!text(item[field])) problems.push(`${at}.${field}: ${field === part.textKey ? 'the text' : 'a non-blank text'}`);
      else if (part.choices[field] && !part.choices[field].includes(item[field])) problems.push(`${at}.${field}: one of ${part.choices[field].join(', ')}, not ${item[field]}`);
    }
  });
}

function validateObligations(list, problems) {
  if (list === undefined) return;
  if (!Array.isArray(list)) { problems.push('obligations: an array, possibly empty'); return; }
  const seen = new Set();
  list.forEach((item, index) => {
    const at = `obligations[${index}]`;
    if (!plain(item)) { problems.push(`${at}: must be an object`); return; }
    for (const key of unknownKeys(item, OBLIGATION_KEYS)) problems.push(`${at}.${key}: unknown key`);
    if (!text(item.area)) problems.push(`${at}.area: the rule area the obligation is about`);
    else if (seen.has(item.area)) problems.push(`${at}.area: ${item.area} has a second obligation — one per area`);
    else seen.add(item.area);
    if (!STANDS.includes(item.stand)) problems.push(`${at}.stand: one of ${STANDS.join(', ')}, not ${item.stand ?? 'missing'}`);
    if (!text(item.text)) problems.push(`${at}.text: what the goal does about the area`);
    if (item.standard !== undefined && !text(item.standard)) problems.push(`${at}.standard: <repo>/<path>#<section>, or leave it out`);
  });
}

/** A version 2 goal's parts from a validated value, each defaulted to empty: what `parseGoal` returns beside the administrative keys. */
export function partsOf(value) {
  const parts = {};
  for (const key of PROSE_PARTS) parts[key] = value[key] ?? [];
  for (const part of Object.values(ITEM_PARTS)) parts[part.key] = value[part.key] ?? [];
  parts.obligations = value.obligations ?? [];
  parts.success_criteria = value.success_criteria;
  parts.documents = value.documents ?? [];
  parts.ids = { ...value.ids };
  return parts;
}

/** The version 2 keys of a goal as `renderGoal` writes them, in file order, after `title`. */
export function partsToWrite(goal) {
  const out = {};
  for (const key of ['aim', 'outcome']) out[key] = goal[key] ?? [];
  for (const word of ['problem', 'premise', 'decision', 'change']) out[ITEM_PARTS[word].key] = goal[ITEM_PARTS[word].key] ?? [];
  out.latitude = goal.latitude ?? [];
  out.preserve = goal.preserve ?? [];
  out.obligations = goal.obligations ?? [];
  out.risks = goal.risks ?? [];
  out.success_criteria = goal.success_criteria ?? [];
  out.protection = goal.protection ?? [];
  out.out_of_scope = goal.out_of_scope ?? [];
  out.documents = goal.documents ?? [];
  out.ids = goal.ids ?? emptyIds();
  return out;
}

/* ------------------------------------------------------------------ the verbs' changes */

/** An item as written: its keys in the part's order, each text trimmed. */
function itemOf(part, id, given) {
  return Object.fromEntries(part.order.map((key) => [key, key === 'id' ? id : String(given[key]).trim()]));
}

/**
 * `{ goal, id, item }`: `goal` with a new item in the part `word` names, the
 * id being the part's letter and `ids` plus one, and `ids` raised to it.
 * `given` has the part's `textKey` and every field.
 */
export function addItem(goal, word, given) {
  const part = ITEM_PARTS[word];
  const number = (goal.ids?.[part.letter] ?? 0) + 1;
  const item = itemOf(part, `${part.letter}${number}`, given);
  return { goal: { ...goal, [part.key]: [...goal[part.key], item], ids: { ...goal.ids, [part.letter]: number } }, id: item.id, item };
}

/** The item `id` of `goal` with the part it is in, or null. */
export function findItem(goal, id) {
  const part = partOfId(id);
  const item = part ? (goal[part.key] ?? []).find((one) => one.id === id) : undefined;
  return item ? { part, item } : null;
}

/** `{ goal, part, was, item }`: item `id` with the fields in `given` changed and the rest kept, or null when there is no such item. */
export function setItem(goal, id, given) {
  const found = findItem(goal, id);
  if (!found) return null;
  const { part, item: was } = found;
  const item = itemOf(part, id, { ...was, ...given });
  return { goal: { ...goal, [part.key]: goal[part.key].map((one) => (one.id === id ? item : one)) }, part, was, item };
}

/** `{ goal, part, was }`: item `id` taken out, `ids` as it was (so the id is not given again), or null. */
export function removeItem(goal, id) {
  const found = findItem(goal, id);
  if (!found) return null;
  return { goal: { ...goal, [found.part.key]: goal[found.part.key].filter((one) => one.id !== id) }, part: found.part, was: found.item };
}

/** `{ goal, was }`: the obligation for `area` set — replacing the one it had, in its place, `was` being that one or null. */
export function setObligation(goal, area, { stand, text: said, standard }) {
  const obligation = { area, stand, text: said.trim(), ...(standard ? { standard: standard.trim() } : {}) };
  const was = (goal.obligations ?? []).find((one) => one.area === area) ?? null;
  const obligations = was ? goal.obligations.map((one) => (one === was ? obligation : one)) : [...(goal.obligations ?? []), obligation];
  return { goal: { ...goal, obligations }, was };
}

/** `{ goal, was }`: the obligation for `area` taken out, or null when there is none. */
export function removeObligation(goal, area) {
  const was = (goal.obligations ?? []).find((one) => one.area === area) ?? null;
  return was ? { goal: { ...goal, obligations: goal.obligations.filter((one) => one !== was) }, was } : null;
}

/** An item or obligation on one line, as the log says what it was: its fields named. */
export function itemWords(item) {
  return Object.entries(item).map(([key, value]) => `${flagOf(key)} "${String(value).replace(/\s*\n\s*/gu, ' ')}"`).join(', ');
}

/* ------------------------------------------------------------------ the text */

/**
 * A version 2 goal as text, in the order of `PROBLEM … DOCUMENTS`: the prose
 * parts as paragraphs, a numbered item as one line (its id and text) and one
 * indented line with its other fields named, an obligation as `<area> ·
 * <stand> — <text>` and an indented `standard:`, a criterion numbered with ✓ or
 * ✗, its check and its `evidence`. `OUTCOME`, `CHANGE`, `OBLIGATIONS` and
 * `CRITERIA` say `none yet` when empty; any other empty part is left out.
 */
export function renderGoalTextV2(goal) {
  const lines = [`# ${goal.title}`];
  const part = (heading, body, required) => {
    if (body.length) lines.push('', heading, ...body);
    else if (required) lines.push('', heading, '  none yet');
  };
  const paragraphs = (list) => list.flatMap((paragraph, i) => [...(i ? [''] : []), ...paragraph.split('\n').map((line) => `  ${line}`)]);
  const items = (word) => {
    const spec = ITEM_PARTS[word];
    return (goal[spec.key] ?? []).flatMap((item) => {
      const [first, ...more] = String(item[spec.textKey]).split('\n');
      const rest = spec.fields.map((field) => `${flagOf(field)}: ${item[field]}`).join(' · ');
      return [`  ${item.id} ${first}`, ...more.map((line) => `      ${line}`), ...(rest ? [`      ${rest}`] : [])];
    });
  };
  part('AIM', paragraphs(goal.aim ?? []), false);
  part('OUTCOME', paragraphs(goal.outcome ?? []), true);
  part('PROBLEM', items('problem'), false);
  part('PREMISES', items('premise'), false);
  part('DECISIONS', items('decision'), false);
  part('CHANGE', items('change'), true);
  part('LATITUDE', paragraphs(goal.latitude ?? []), false);
  part('PRESERVE', items('preserve'), false);
  part('OBLIGATIONS', (goal.obligations ?? []).flatMap((item) => [`  ${item.area} · ${item.stand} — ${item.text}`, ...(item.standard ? [`      standard: ${item.standard}`] : [])]), true);
  part('RISKS', items('risk'), false);
  const criteria = goal.success_criteria ?? [];
  const { met, all } = criteriaCount(goal);
  part(`CRITERIA ${met}/${all}`, criteria.length
    ? criteria.flatMap((item, i) => [`  ${i + 1} ${item.met ? '✓' : '✗'} ${item.criterion}`, `      check: ${item.check}`, ...(item.evidence ? [`      evidence: ${item.evidence}`] : [])])
    : ['  none yet — mc goal criterion add <programme>/<goal> --criterion "…" --check "…"'], true);
  part('PROTECTION', paragraphs(goal.protection ?? []), false);
  part('OUT OF SCOPE', items('out-of-scope'), false);
  part('DOCUMENTS', (goal.documents ?? []).map((doc) => `  ${doc.label} — ${doc.path}`), false);
  return `${lines.join('\n')}\n`;
}

/**
 * The cut of a ready order into goals, model-free (mc-run.md, "The cut of a ready order").
 *
 * A ready programme whose README.md has a part no goal names is cut by the runner itself, with no session and no
 * model: one goal per part (`cutParts`), marked with the part's number and holding no text of its own, and one more,
 * last, that writes `docs/technical/` (`documentationBrief`). Every session
 * on a part's goal is given its part as README.md has it at that moment (`partOfOrder`, `partBrief`). A part waits for
 * the part before it unless it says it runs in parallel with it (`partsOrder`), which `mc programs state <programme>
 * ready` writes into the record.
 * Everything here is what the runner decides without a model: whether a programme is due (`programmeDue`), the state
 * file that counts the cuts that failed, and the desk item the second failure opens. The runner (`run.js`) supplies
 * its own file reads and lock, so a fixture drives all of it in memory.
 */
import { join, resolve } from 'node:path';
import { deskItemId } from './desk-items.js';
import { cutFromOrder } from './goal-parts.js';
import { appendLog, ARCHIVE_DIR, GOAL_FILE, GOALS_DIR, LOG_FILE, logStamp, parseGoal, renderGoal } from './goals.js';
import { NAME_RE } from './plan-schema.js';
import { readRecord } from './programme-record.js';
import { repairReleaseState } from './repair-release.js';

export const TURN_SCHEMA = 'mc-programme-turn';
export const TURN_VERSION = 1;
export const TURN_ITEM_KIND = 'programme';
/** The failures that open a desk item: the first lets the next pass cut again, the second is the item. */
export const FAILURES_TO_ITEM = 2;

/** `programme:<programme>`: what the cut is called in the runner's lines, and an item's reference. */
export const turnName = (programme) => `programme:${programme}`;
export const turnReference = turnName;

/** `runner/programme-turn/<programme>.json` under the work root. */
export const turnStatePath = (root, programme) => join(root, 'runner', 'programme-turn', `${programme}.json`);

/**
 * The state file: `{ status: 'none' }` when it is not there (no failures),
 * `{ status: 'valid', state }`, or `{ status: 'unreadable', problem }`. A file
 * that is there and is not the schema is unreadable, never "no failures".
 */
export function readTurnState({ root, programme, read }) {
  let text;
  try { text = read(turnStatePath(root, programme)); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'none' };
    return { status: 'unreadable', problem: `cannot be read: ${error.message}` };
  }
  if (text === null || text === undefined) return { status: 'none' };
  let state;
  try { state = JSON.parse(text); } catch (error) { return { status: 'unreadable', problem: `not JSON: ${error.message}` }; }
  const problems = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) problems.push('not an object');
  else {
    if (state.schema !== TURN_SCHEMA) problems.push(`schema is not ${TURN_SCHEMA}`);
    if (state.version !== TURN_VERSION) problems.push(`version is not ${TURN_VERSION}`);
    if (state.programme !== programme) problems.push(`programme is not ${programme}`);
    if (!Array.isArray(state.failures) || !state.failures.every((f) => f && typeof f.at === 'string' && typeof f.reason === 'string')) problems.push('failures is not a list of { at, reason, log }');
    if (!Array.isArray(state.items) || !state.items.every((item) => item && typeof item.id === 'string' && typeof item.opened_at === 'string')) problems.push('items is not a list of { id, opened_at }');
  }
  return problems.length ? { status: 'unreadable', problem: problems.join('; ') } : { status: 'valid', state };
}

/** The failures since the last item opened: the count the second-failure rule reads. */
export function failuresSinceItem(state) {
  const since = state.items.map((item) => item.opened_at).sort().at(-1) ?? null;
  return state.failures.filter((failure) => since === null || failure.at > since);
}

/** The names of the programme directories under `home`. */
export const programmeDirs = ({ home, list }) => list(home).filter((name) => NAME_RE.test(name)).sort();

/** The `### Part n —` headings of the programme document's `## Parts` entry (fenced examples do not count), as numbers. */
export function documentParts(text) {
  return partSections(text).map(([number]) => number);
}

export function partSections(text) {
  return splitProgrammeParts(text).parts;
}

export function splitProgrammeParts(text) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const headings = String(text ?? '').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gmu, fence => fence.replace(/[^\n]/gu, ' ')).split(/\r?\n/u);
  const start = headings.indexOf('## Parts');
  if (start < 0) return { parts: [], shared: lines.join('\n'), sharedContract: '' };
  let end = headings.findIndex((line, at) => at > start && /^## /u.test(line));
  if (end < 0) end = lines.length;
  const parts = headings.slice(start + 1, end).flatMap((line, i) => {
    const found = /^### Part ([1-9]\d*)\s+—\s+\S/u.exec(line);
    return found ? [{ number: Number(found[1]), start: start + 1 + i }] : [];
  });
  const cutoff = parts[0]?.start ?? end;
  const shared = [...lines.slice(0, cutoff), '', ...lines.slice(end)].join('\n');
  // Read and Where things are can accumulate review reasoning and provenance
  // without changing a goal contract. Named binding inputs still count.
  let audit = false;
  const sharedContract = lines.filter((_, i) => {
    if (i >= cutoff && i < end) return false;
    if (/^## /u.test(headings[i])) audit = /^## (?:Read|Where things are)\s*$/u.test(headings[i]);
    return !audit;
  }).join('\n').trimEnd();
  return {
    parts: parts.map((part, i) => [part.number, lines.slice(part.start, parts[i + 1]?.start ?? end).join('\n').trimEnd()]),
    shared,
    sharedContract,
  };
}

const FENCES = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gmu;

/** The name of a part: the text after `### Part n — ` in the heading its section begins with. */
export function partName(section) {
  return /^### Part [1-9]\d*\s+—\s+(\S.*)$/u.exec(String(section ?? '').split(/\r?\n/u)[0])?.[1].trim() ?? '';
}

/** The one line that lets a part start beside the part before it; whitespace around it, letter case and the final full stop are read leniently. */
const PARALLEL_LINE = /^\s*in parallel with the previous part\.?\s*$/iu;

/**
 * The order the parts of a document give: `{ after }`, the record's `phases.after` (`{ <part>: [parts it waits for] }`,
 * a part that waits for nothing left out), or null for a document with no part. A part waits for the part before it,
 * unless its section holds the line `In parallel with the previous part.` (a fenced example is no line): such a part
 * joins the group of the part before it and waits for what that group waits for, and any other part waits for every
 * part of the group before it. The first part waits for nothing. The programme's last goal, Documentation, is in the
 * phase after the highest part and waits for the last group.
 */
export function partsOrder(text) {
  const parts = [...partSections(text)].sort(([a], [b]) => a - b);
  if (!parts.length) return null;
  const after = {};
  let group = [];
  let waits = [];
  for (const [number, section] of parts) {
    if (group.includes(number)) continue;
    const parallel = group.length > 0 && String(section).replace(FENCES, '').split(/\r?\n/u).some((line) => PARALLEL_LINE.test(line));
    if (!parallel) { waits = group; group = []; }
    group.push(number);
    if (waits.length) after[number] = [...waits];
  }
  after[parts.at(-1)[0] + 1] = group;
  return { after };
}

/**
 * Part `number` of an order as its document `text` has it: `{ number, name, heading, section, shared }`, where
 * `section` is the part verbatim, heading to the next heading, `shared` the order's sections outside its parts, and
 * `heading` the line `mc goal show` and a session's prompt put above them. Null when the document has no such part.
 */
export function partOfOrder(text, number) {
  if (text === null || text === undefined) return null;
  const { parts, shared } = splitProgrammeParts(text);
  const section = parts.find(([one]) => one === number)?.[1];
  if (section === undefined) return null;
  const name = partName(section);
  return { number, name, heading: `PART ${number} — ${name}, as README.md has it now`, section, shared: shared.trim() };
}

/** What a session on a goal that is a part is given, and what `mc goal show` prints: the heading line, the part, the shared sections. */
export function partBrief(part) {
  return `${part.heading}\n\n${part.section}\n\n${part.shared}\n`;
}

/** The title of the programme's last goal, the one that writes `docs/technical/`. */
export const DOCUMENTATION_TITLE = 'Documentation';

/**
 * What a session on the programme's last goal is given, and what `mc goal show` prints: a fixed text, then the order
 * (`text`, its README.md) whole. `dir` is the programme's directory.
 */
export function documentationBrief({ programme, dir, text }) {
  return `DOCUMENTATION — the last goal of programme ${programme}\n\n`
    + `Every part of the order has landed. Read the order below, the LOG.md of every goal of the programme (in ${dir}/goals/.archive/ and goals/), with its "Read as:" lines, and what landed: the pull requests named in ${dir}/goals/goal_log.md and their commits on origin/main.\n\n`
    + 'Write docs/technical/ in each repository of the programme so that it describes what now runs: correct each page the programme made untrue and add what it made true where a reader would look for it. Write what runs, not how it was built, and change no page the programme did not touch. Then publish and hand over to review as for any goal. If no page needs a change, say why in the log and end.\n\n'
    + `${String(text).trimEnd()}\n`;
}

/**
 * What a session on a goal cut from an order is given in place of a goal's text: its part (`partBrief`), or for the
 * last goal the documentation text (`documentationBrief`), from the order's document `text`. Null when the document
 * is missing or no longer has the part.
 */
export function orderBrief({ goal, programme, home, text }) {
  if (text === null || text === undefined) return null;
  if (goal.documentation === true) return documentationBrief({ programme, dir: join(home, programme), text });
  const part = partOfOrder(text, goal.part);
  return part ? partBrief(part) : null;
}

/**
 * The document a programme's parts are read from now: the released snapshot of a repair programme with a current
 * release, else README.md as it stands. Null when there is none.
 */
export function orderText({ home, programme, read }) {
  const dir = join(home, programme);
  const record = readRecord(dir, { read });
  const release = record.status === 'valid' ? repairReleaseState(dir, record.record) : null;
  if (release?.snapshot) return release.snapshot.text;
  try { return read(join(dir, 'README.md')) ?? null; } catch { return null; }
}

/** The line `mc goal list` and the runner say for a goal whose part is no longer a heading of its order. */
export const partLeftWords = (number) => `its part has left the order — restore Part ${number} in README.md or drop the goal`;

/** The part numbers one document label names: `Part 1; Part 2`, `Parts 1, 2 and 4`. No range is read. */
export function partsNamed(label) {
  const named = new Set();
  for (const found of String(label ?? '').matchAll(/\bParts?\s+(\d+(?:\s*(?:,|;|&|and)\s*\d+)*)/giu)) {
    for (const number of found[1].match(/\d+/gu)) named.add(Number(number));
  }
  return named;
}

/**
 * Each goal of the programme, live and archived, that reads as a goal: its name and the parts of the programme's
 * `README.md` it names (mc-goals.md, "Part association"): a document whose path is that README.md, labelled with
 * explicit `Part n` references. A goal file that is missing, does not parse or does not validate is left out.
 */
export function goalParts({ home, programme, list, read }) {
  const readme = resolve(join(home, programme, 'README.md'));
  const goals = join(home, programme, GOALS_DIR);
  const dirs = [...list(goals).filter((name) => !name.startsWith('.')).map((name) => [name, join(goals, name), false]),
    ...list(join(goals, ARCHIVE_DIR)).map((name) => [name, join(goals, ARCHIVE_DIR, name), true])];
  const found = [];
  for (const [name, dir, archived] of dirs) {
    let text;
    try { text = read(join(dir, GOAL_FILE)); } catch { continue; }
    if (text == null) continue;
    const parsed = parseGoal(text);
    if (parsed.problems) continue;
    const named = new Set();
    for (const document of parsed.documents ?? []) {
      const docPath = typeof document?.path === 'string' ? resolve(join(home, programme), document.path) : null;
      if (docPath !== readme) continue;
      for (const part of partsNamed(document.label)) named.add(part);
    }
    found.push({ name, named, dir, archived, goal: parsed });
  }
  return found;
}

/** The parts of the programme's `README.md` its goals name, live and archived. */
export function partsCut({ home, programme, list, read }) {
  return new Set(goalParts({ home, programme, list, read }).flatMap(({ named }) => [...named]));
}

/**
 * The goals, live and archived, that name no part of the programme's `README.md`: goals written by hand or cut
 * from another document. A programme holding one is written by hand and is not cut. The programme's last goal,
 * Documentation, is cut from the order and is not one of them.
 */
export function goalsNamingNoPart({ home, programme, list, read }) {
  return goalParts({ home, programme, list, read }).filter(({ named, goal }) => !named.size && goal.documentation !== true).map(({ name }) => name).sort();
}

/**
 * The problems that keep a programme document uncut: none when every one of its parts is named by a goal.
 */
export function cutProblems({ home, programme, list, read }) {
  let text;
  try { text = read(join(home, programme, 'README.md')); } catch { text = null; }
  if (text == null) return ['README.md is missing'];
  const parts = documentParts(text);
  if (!parts.length) return ['README.md names no part'];
  const named = partsCut({ home, programme, list, read });
  const missing = parts.filter((part) => !named.has(part));
  return missing.length ? [`no goal names part${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`] : [];
}

/** A record the cut reads: valid and ready. */
export const cuttable = (record, dir) => record?.state === 'ready' && (!record.repair || Boolean(dir && repairReleaseState(dir, record)?.release));

/** Why a released repair order is not cut by code: its reconciliation compares authored goal contracts, which a goal that is a part does not have. */
export const REPAIR_NOT_CUT = 'not cut: repair releases are cut by hand until reconciliation reads goals that are parts';

/**
 * Whether `programme` is due the cut now: `{ due: true, record }`, or `{ due: false, reason, notice }`. It is due
 * while its record reads ready, a part of README.md is named by no goal or the programme has no documentation goal,
 * and the record states the order the parts give (`partsOrder`). A programme whose every part is named and none of
 * whose goals was cut from the order is of the old form: its goals write `docs/technical/` themselves, and it gets no
 * documentation goal. A `notice` is what the runner says once while it lasts. A programme
 * holding a goal that names no part is written by hand and is not cut; a released repair order is not cut by code.
 */
export function programmeDue({ programme, home, list, read, items = [], horizon = () => null, state }) {
  const dir = join(home, programme);
  const record = readRecord(dir, { read });
  if (record.status === 'none') return { due: false, reason: 'no record', notice: null };
  if (record.status === 'invalid') return { due: false, reason: 'its record is invalid', notice: null };
  const repair = repairReleaseState(dir, record.record);
  const refusal = repair?.problems?.[0];
  if (refusal) return { due: false, reason: refusal, notice: null };
  if (record.record.state !== 'ready') return { due: false, reason: `its record reads ${record.record.state}`, notice: null };
  let readme;
  try { readme = repair ? repair.snapshot.text : read(join(dir, 'README.md')); } catch { readme = null; }
  if (readme == null) return { due: false, reason: 'it has no README.md', notice: null };
  const parts = documentParts(readme);
  if (!parts.length) return { due: false, reason: 'README.md names no part', notice: null };
  if (repair) {
    if (record.record.repair.reconciled?.revision === repair.release.revision) return { due: false, reason: 'its release is reconciled', notice: null };
    return { due: false, reason: REPAIR_NOT_CUT, notice: `${programme}: ${REPAIR_NOT_CUT}` };
  }
  const goals = goalParts({ home, programme, list, read }).map(({ goal }) => goal);
  const lastCut = goals.some((goal) => goal.documentation === true) || !goals.some(cutFromOrder);
  if (lastCut && cutProblems({ home, programme, list, read }).length === 0) return { due: false, reason: 'its goals are already cut', notice: null };
  const unnamed = goalsNamingNoPart({ home, programme, list, read });
  if (unnamed.length) {
    const named = unnamed.length > 3 ? `${unnamed.slice(0, 3).join(', ')} and ${unnamed.length - 3} more` : unnamed.join(', ');
    return { due: false, reason: `its goal${unnamed.length === 1 ? '' : 's'} ${named} name${unnamed.length === 1 ? 's' : ''} no part of README.md`, notice: null };
  }
  const recorded = record.record.phases?.order === 'stated' ? record.record.phases.after ?? {} : null;
  if (recorded === null || !sameAfter(partsOrder(readme).after, recorded)) {
    return { due: false, reason: 'its record does not state the order its parts give', notice: `${programme}: its record does not state the order its parts give — the desk sets it ready again` };
  }
  if (items.some((item) => item.kind === TURN_ITEM_KIND && item.reference === turnReference(programme) && item.state !== 'closed')) {
    return { due: false, reason: 'a programme desk item is open', notice: null };
  }
  if (state.status === 'unreadable') {
    return { due: false, reason: 'its turn state is unreadable', notice: `${programme}: ${turnStatePath('<work root>', programme).replace('<work root>/', '')} is unreadable (${state.problem}) — the programme is not cut until it is repaired or removed` };
  }
  const slug = record.record.horizon;
  if (slug) {
    const found = horizon(slug);
    if (!found || found.state !== 'open') {
      return { due: false, reason: 'its horizon is not open', notice: `${programme}: its horizon ${slug} ${found ? `reads ${found.state}` : 'is missing or unreadable'} — the programme is not cut while that lasts` };
    }
  }
  return { due: true, record: record.record };
}

/** Whether two `after` maps state the same dependencies, whatever the order of their keys. */
function sameAfter(a, b) {
  const canon = (after) => JSON.stringify(Object.keys(after).map(Number).sort((x, y) => x - y).map((key) => [key, [...after[key]].sort((x, y) => x - y)]));
  return canon(a) === canon(b);
}

/**
 * A goal's directory name from its part's heading name: lower-case letters, digits and hyphens (`NAME_RE`), `part-<n>`
 * when the name leaves nothing, and a number added while the name is in `taken`.
 */
export function goalSlug(title, number, taken = new Set()) {
  const base = String(title).normalize('NFKD').replace(/[̀-ͯ]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 56).replace(/-+$/u, '') || `part-${number}`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

/**
 * The cut: for each part of `programme`'s README.md that no goal names, live or archived, one goal — its directory
 * named from the part's heading, GOAL.json (version 2) in `build · ready` with `part` and `phase` the part's number,
 * the title the heading's name, the repositories of the README's `Repositories:` line (`repositories(text)` is the
 * caller's reading of it: `{ repos: [{ repo }] }` or `{ error }`), a document that points at README.md labelled
 * `Part <n>`, no criterion and no other text — and LOG.md with the runner's first entry. Then, where the programme has
 * none, live or archived, one more goal, last: `<programme>-documentation`, titled Documentation, marked
 * `documentation` in place of `part`, in the phase after the highest part; one that is live is moved to that phase
 * when a part has been added since. A name is unique among the
 * programme's goals, live and archived, and among the live goals of every other programme, since a goal's branch
 * `goal/<goal>` is one per repository. Returns the goals made as `[{ name, part }]`, the last one as
 * `{ name, documentation: true }`; throws when the cut cannot be made.
 */
export function cutParts({ programme, home, list, read, write, repositories, now }) {
  const dir = join(home, programme);
  const readme = join(dir, 'README.md');
  const text = read(readme);
  if (text === null || text === undefined) throw new Error('README.md is missing');
  const found = repositories(text);
  if (found.error) throw new Error(found.error);
  const goals = goalParts({ home, programme, list, read });
  const named = new Set(goals.flatMap((one) => [...one.named]));
  const live = (one) => list(join(home, one, GOALS_DIR)).filter((name) => !name.startsWith('.'));
  const taken = new Set([
    ...list(home).flatMap(live),
    ...list(join(dir, GOALS_DIR, ARCHIVE_DIR)).flatMap((name) => [name, name.replace(/-\d{8}T\d{4}$/u, '')]),
  ]);
  const made = [];
  const make = (name, fields, done) => {
    taken.add(name);
    const goalDir = join(dir, GOALS_DIR, name);
    const goal = { version: 2, stage: 'build', status: 'ready', repos: found.repos.map((one) => one.repo),
      created: now.toISOString().replace(/\.\d{3}Z$/u, 'Z'), prs: [], success_criteria: [], ...fields };
    write(join(goalDir, GOAL_FILE), renderGoal(goal));
    write(join(goalDir, LOG_FILE), appendLog('', { at: logStamp(now), tool: 'runner', model: null, stage: 'build', status: 'ready', done, comment: null, next: null }));
  };
  const parts = partSections(text);
  for (const [number, section] of parts) {
    if (named.has(number)) continue;
    named.add(number);
    const title = partName(section);
    const name = goalSlug(title, number, taken);
    make(name, { phase: number, part: number, title, documents: [{ label: `Part ${number}`, path: readme }] }, `cut from Part ${number} of README.md`);
    made.push({ name, part: number });
  }
  if (!parts.length) return made;
  const phase = Math.max(...parts.map(([number]) => number)) + 1;
  const last = goals.find(({ goal }) => goal.documentation === true);
  if (!last) {
    const name = goalSlug(`${programme}-documentation`, phase, taken);
    make(name, { phase, documentation: true, title: DOCUMENTATION_TITLE, documents: [{ label: 'The order', path: readme }] }, 'cut as the last goal of README.md');
    made.push({ name, documentation: true });
  } else if (!last.archived && last.goal.phase !== phase) {
    // A part added since: the last goal moves to the phase after it, so it still waits for every part.
    write(join(last.dir, GOAL_FILE), renderGoal({ ...last.goal, phase }));
  }
  return made;
}

/**
 * A cut that could not be made, counted: the second since the last item opens a desk item.
 */
export function recordTurnFailure({ root, programme, reason, log = null, at, read, write, writeJson, lock, env, itemDirectory }) {
  return lock(root, () => {
    const found = readTurnState({ root, programme, read });
    if (found.status === 'unreadable') throw new Error(`${turnStatePath(root, programme)} is unreadable (${found.problem})`);
    const state = found.status === 'valid' ? found.state : { schema: TURN_SCHEMA, version: TURN_VERSION, programme, failures: [], items: [] };
    state.failures.push({ at, reason, log });
    const recent = failuresSinceItem(state);
    let item = null;
    if (recent.length >= FAILURES_TO_ITEM) {
      const reference = turnReference(programme);
      const first = state.items.length === 0;
      const id = deskItemId(TURN_ITEM_KIND, reference, at);
      item = { schema: 'mc-desk-item', version: 1, id, kind: TURN_ITEM_KIND, reference, source_at: at, opened_at: at,
        state: first ? 'prepared' : 'for-martin', sort: 'mechanical', reversible: first ? null : false, due_at: null, outcome: null };
      const dir = itemDirectory(item, env);
      if (first) write(join(dir, 'prepared.md'), preparedText({ programme, failures: recent, item }));
      else write(join(dir, 'brief.md'), briefText({ programme, failures: recent }));
      writeJson(join(dir, 'item.json'), item);
      state.items.push({ id, opened_at: at });
    }
    writeJson(turnStatePath(root, programme), state);
    return { count: recent.length, item };
  }, { strict: true, name: 'programme-turn' });
}

const failureLines = (failures) => failures.map((failure) => `- ${failure.at}: ${failure.reason}${failure.log ? ` (session log: ${failure.log})` : ''}`).join('\n');

/** What the decision session reads for the first item: the cuts that failed, and where to look. */
function preparedText({ programme, failures, item }) {
  return `# Programme ${programme}: its cut failed twice\n\n`
    + `The runner's cut of programme ${programme} ended twice without a goal for every part of README.md. `
    + `Nothing was asked of Martin; this is a mechanical failure to repair within reach.\n\n`
    + `## The failures\n${failureLines(failures)}\n\n`
    + `## Where to look\n- Programme directory: ${programme} under the programmes home, with README.md, PROGRAMME.json and goals/.\n`
    + `- The cut's state: runner/programme-turn/${programme}.json under the work root.\n`
    + `- Item: ${item.id}.\n\n`
    + `## What closes it\nRepair what failed, then close the item (--by decision) so the runner cuts the programme again. `
    + `A text of Martin's that would have to change goes to a brief instead.\n`;
}

/** The brief a later item carries: the cut failed again after a decision pass closed the first. Swedish, as the desk reads it. */
function briefText({ programme, failures }) {
  return `## Vad det gäller\nUppdelningen av programmet ${programme} i mål slutade igen utan att varje del av programmets README.md blev ett mål; arbetet kan inte fortsätta automatiskt.\n\n`
    + `## Alternativ och konsekvenser\n- Undersök underlaget: uppdelningen görs igen när felet är löst.\n- Låt programmet vänta: inga fler mål skapas förrän felet är löst.\n\n`
    + `## Rekommendation och skäl\nUndersök underlaget; uppdelningen har misslyckats igen sedan ett tidigare ärende stängts.\n\n`
    + `## Vad som står still\nProgrammet ${programme} väntar på Martin. Felunderlag:\n${failureLines(failures)}\n\n`
    + `## Kan valet ändras efteråt?\nIngen automatisk tillämpning; detta är ett mekaniskt fel som kräver undersökning.\n`;
}

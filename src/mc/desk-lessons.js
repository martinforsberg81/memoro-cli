/**
 * The desk's lessons: what a rule that was missing or wrong looked like, in
 * general form, until a landed change makes it unnecessary. A lesson is input
 * to a goal, never the result; mc never deletes one.
 *
 * A lesson is `~/mc/martin/lessons/<date>-<slug>.md`: a small header, then
 * three prose parts. Everything here is model-free. The verbs live in
 * `commands/martin.js`; the runner reconciles `in-goal` lessons with their
 * goals (`reconcileLessons`) and is the only writer of `landed`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { deskItemId, itemDirectory, updateDeskItem } from './desk-items.js';
import { textForm } from './desk-texts.js';
import { goalReferences, isGoalRef, prRef, REVIEW_ROLE } from './goals.js';
import { martinDir, programsHome } from './paths.js';

export const LESSON_KINDS = ['not-martins', 'wrong-question', 'answer-differs', 'overturned', 'review-finding', 'unsettled', 'repeat'];
export const LESSON_STATES = ['open', 'in-goal', 'landed', 'dismissed'];
/** Who may do what to a lesson. The runner writes `unsettled`, `answer-differs` and `landed` itself. */
export const LESSON_WRITERS = {
  add: ['person', 'martin', 'decision', 'learning', REVIEW_ROLE],
  carry: ['person', 'martin', 'decision', 'learning'],
  dismiss: ['person', 'martin', 'decision', 'learning'],
  brief: ['person', 'martin', 'decision', 'learning'],
};
/** The learning pass may dismiss at most this share of the lessons it was given: one in five. */
export const DISMISS_ONE_IN = 5;
export const LATE_DAYS = 14;
export const PARTS = [['happened', 'What happened'], ['rule', 'The rule'], ['where', 'Where the change belongs']];

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/u;
const WORD = /^[a-z0-9][a-z0-9-]*$/u;
const ITEM_ID = /^[a-f0-9]{24}$/u;
const FIELDS = ['kind', 'item', 'programme', 'state', 'goal', 'pr', 'place', 'at', 'by', 'carried_at', 'landed_at', 'dismissed_at', 'reason', 'repeat_of'];

export function lessonsDir(env = process.env) { return join(martinDir(env), 'lessons'); }

/** Which of the three places a lesson's change belongs to, from the file it names. */
export function placeOf(place) {
  const path = String(place ?? '').trim();
  if (path.startsWith('src/')) return 'code';
  if (path.startsWith('canon/')) return 'prompt';
  if (path.startsWith('docs/technical/')) return 'standard';
  return null;
}

export function parseLesson(name, text) {
  const match = String(text ?? '').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  if (!match) return null;
  const header = Object.fromEntries(FIELDS.map((field) => [field, null]));
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(': ');
    const key = at < 0 ? line.replace(/:$/u, '') : line.slice(0, at);
    if (!FIELDS.includes(key)) continue;
    const value = at < 0 ? '' : line.slice(at + 2).trim();
    header[key] = value === '' || value === 'null' ? null : value;
  }
  if (!LESSON_KINDS.includes(header.kind) || !LESSON_STATES.includes(header.state) || !Number.isFinite(Date.parse(header.at))) return null;
  return { name, ...header, parts: readParts(match[2]) };
}

/** The three parts of a lesson's body, or null for a part that is missing or empty. */
export function readParts(body) {
  const parts = {};
  const headings = PARTS.map(([, title]) => `## ${title}`);
  const lines = String(body ?? '').split('\n');
  let current = null;
  for (const line of lines) {
    const index = headings.indexOf(line.trim());
    if (index >= 0 && line.startsWith('## ')) { current = PARTS[index][0]; parts[current] = []; } else if (current) parts[current].push(line);
  }
  return Object.fromEntries(PARTS.map(([key]) => [key, parts[key] ? parts[key].join('\n').trim() || null : null]));
}

/** The text of a lesson file: header, then the three parts. */
export function renderLesson(lesson) {
  const header = FIELDS.map((field) => `${field}: ${lesson[field] ?? 'null'}`);
  const body = PARTS.map(([key, title]) => `## ${title}\n\n${lesson.parts[key]}\n`);
  return `---\n${header.join('\n')}\n---\n${body.join('\n')}`;
}

/** Every readable lesson, oldest first. A file that is not a lesson is left alone and not listed. */
export function listLessons({ env = process.env, state = null } = {}) {
  const dir = lessonsDir(env);
  let names;
  try { names = readdirSync(dir).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3)).filter((name) => NAME.test(name)); } catch { return []; }
  const lessons = [];
  for (const name of names) {
    try { const lesson = parseLesson(name, readFileSync(join(dir, `${name}.md`), 'utf8')); if (lesson && (!state || lesson.state === state)) lessons.push(lesson); } catch { /* unreadable: omitted */ }
  }
  return lessons.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.name.localeCompare(b.name));
}

export function readLesson(name, { env = process.env } = {}) {
  if (!NAME.test(String(name))) return null;
  try { return parseLesson(name, readFileSync(join(lessonsDir(env), `${name}.md`), 'utf8')); } catch { return null; }
}

function writeLesson(lesson, { env }) {
  const dir = lessonsDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, `${lesson.name}.md`), renderLesson(lesson));
}

function uniqueName(at, slug, env) {
  const base = `${at.slice(0, 10)}-${slug}`;
  let name = base;
  for (let n = 2; existsSync(join(lessonsDir(env), `${name}.md`)); n += 1) name = `${base}-${n}`;
  return name;
}

/**
 * The body of `mc martin lesson add --file`: the three headings, in order, each
 * with text. Returns `{ parts }` or `{ error }`.
 */
export function parseLessonInput(text) {
  const lines = String(text ?? '').split('\n');
  const seen = lines.filter((line) => /^## /u.test(line)).map((line) => line.trim());
  const expected = PARTS.map(([, title]) => `## ${title}`);
  if (seen.length !== expected.length || expected.some((heading, index) => seen[index] !== heading)) {
    return { error: `a lesson has exactly three parts, in this order: ${expected.join(', ')}` };
  }
  const parts = readParts(text);
  const missing = PARTS.filter(([key]) => !parts[key]).map(([, title]) => title);
  return missing.length ? { error: `empty part: ${missing.join(', ')}` } : { parts };
}

/** The last, in `listLessons` order, of the landed lessons of this kind and place whose `landed_at` is not after `at`; or null. */
function earlierLanded({ env, kind, place, at }) {
  if (!place) return null;
  return listLessons({ env }).filter((x) => x.state === 'landed' && x.kind === kind && x.place === place && Date.parse(x.landed_at) <= Date.parse(at)).at(-1) ?? null;
}

/** The first part with the sentence that says the lesson repeats `earlier`; `once` leaves a part that already ends with it as it is. */
function withRepeat(happened, earlier, { once = false } = {}) {
  const sentence = `This repeats a lesson of the same kind and place that landed${earlier.pr ? ` in ${earlier.pr}` : ''} (${earlier.name}): that change did not work.`;
  return once && happened.endsWith(sentence) ? happened : `${happened}\n\n${sentence}`;
}

/**
 * Write a new open lesson. `kind`, `parts` and `by` are required; `item` is a desk item id or a
 * `<programme>/<goal>` reference. A lesson of the same kind and place as one that already landed
 * says so in its header (`repeat_of`: that change did not work) — computed here, without a model.
 */
export function addLesson({ env = process.env, kind, item = null, programme = null, place = null, parts, by, now = new Date(), slug = null }) {
  if (!LESSON_KINDS.includes(kind)) return { error: `unknown kind ${kind}; kinds are ${LESSON_KINDS.join(', ')}` };
  if (item !== null && !ITEM_ID.test(item) && !isGoalRef(item)) return { error: `--item expects a desk item id or <programme>/<goal>, not ${item}` };
  if (programme !== null && !WORD.test(programme)) return { error: `--programme expects a programme name, not ${programme}` };
  if (!parts || PARTS.some(([key]) => !parts[key])) return { error: 'a lesson needs all three parts' };
  const at = now.toISOString();
  const trimmedPlace = place === null ? null : String(place).trim() || null;
  const earlier = earlierLanded({ env, kind, place: trimmedPlace, at });
  const lesson = {
    kind, item, programme, state: 'open', goal: null, pr: null, place: trimmedPlace, at, by, carried_at: null, landed_at: null, dismissed_at: null, reason: null,
    repeat_of: earlier?.pr ?? null,
    parts: earlier ? { ...parts, happened: withRepeat(parts.happened, earlier) } : parts,
  };
  lesson.name = uniqueName(at, slug || [kind, item && ITEM_ID.test(item) ? item.slice(0, 8) : item?.replace('/', '-')].filter(Boolean).join('-'), env);
  writeLesson(lesson, { env });
  return { lesson };
}

/** The refusal for a role that may not do `verb`, or null. */
export function lessonRefusal(verb, role) {
  return LESSON_WRITERS[verb]?.includes(role) ? null : `role ${role} cannot ${verb} lessons`;
}

/** open → in-goal, with the goal that carries it. The goal must exist. */
export function carryLesson({ env = process.env, name, goal, place = null, now = new Date(), home = programsHome(env), goals = null }) {
  const lesson = readLesson(name, { env });
  if (!lesson) return { error: `unknown lesson ${name}` };
  if (lesson.state !== 'open') return { error: `lesson ${name} is ${lesson.state}; only an open lesson is carried` };
  if (!isGoalRef(goal)) return { error: '--goal expects <programme>/<goal>' };
  const known = (goals ?? goalReferences({ home })).find((g) => `${g.programme}/${g.goal}` === goal && g.stage !== 'dropped' && g.stage !== 'done');
  if (!known) return { error: `no live goal ${goal} to carry the lesson` };
  Object.assign(lesson, { state: 'in-goal', goal, carried_at: now.toISOString(), ...(place ? { place: String(place).trim() } : {}) });
  // A place given now is a place given at `add`: the same rule marks the repeat.
  if (place && lesson.repeat_of === null) {
    const earlier = earlierLanded({ env, kind: lesson.kind, place: lesson.place, at: lesson.at });
    if (earlier) Object.assign(lesson, { repeat_of: earlier.pr ?? null, parts: { ...lesson.parts, happened: withRepeat(lesson.parts.happened, earlier, { once: true }) } });
  }
  writeLesson(lesson, { env });
  return { lesson };
}

/**
 * open → dismissed, with a reason. The learning pass may dismiss at most one lesson in five of those
 * it was given: the lessons it carried or dismissed since `since` plus those still open are what it
 * was given.
 */
export function dismissLesson({ env = process.env, name, reason, role, since = null, now = new Date() }) {
  const lesson = readLesson(name, { env });
  if (!lesson) return { error: `unknown lesson ${name}` };
  if (lesson.state !== 'open') return { error: `lesson ${name} is ${lesson.state}; only an open lesson is dismissed` };
  if (!String(reason ?? '').trim()) return { error: 'dismiss needs --reason, in a sentence: the accident no change would have prevented' };
  if (role === 'learning') {
    const from = Date.parse(since ?? '') || 0;
    const all = listLessons({ env });
    const given = all.filter((x) => x.state === 'open' || (x.state === 'in-goal' && Date.parse(x.carried_at) >= from) || (x.state === 'dismissed' && Date.parse(x.dismissed_at) >= from)).length;
    const dismissed = all.filter((x) => x.state === 'dismissed' && Date.parse(x.dismissed_at) >= from).length;
    if ((dismissed + 1) * DISMISS_ONE_IN > given) return { error: `the learning pass may dismiss at most one lesson in ${DISMISS_ONE_IN}: ${dismissed} of ${given} are dismissed already` };
  }
  Object.assign(lesson, { state: 'dismissed', dismissed_at: now.toISOString(), reason: String(reason).trim().replace(/\s+/gu, ' ') });
  writeLesson(lesson, { env });
  return { lesson };
}

/**
 * A lesson that contradicts a dated decision of Martin's is not a goal: it becomes a desk item of sort
 * `text` that names the text (`text`) with the brief given, in the form of mc-martin.md (three parts, no
 * options), and the lesson is dismissed with that as its reason. The item waits for Martin without limit and
 * no clock carries it out. A brief not in the form leaves the lesson open.
 */
export function briefLesson({ env = process.env, name, text, brief, now = new Date(), lock }) {
  const lesson = readLesson(name, { env });
  if (!lesson) return { error: `unknown lesson ${name}` };
  if (lesson.state !== 'open') return { error: `lesson ${name} is ${lesson.state}; only an open lesson is brought to Martin` };
  const form = textForm(brief);
  if (form.error) return { error: form.error };
  const reference = `lesson:${name}`;
  const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('lesson', reference, lesson.at), kind: 'lesson', reference,
    source_at: lesson.at, opened_at: now.toISOString(), state: 'for-martin', sort: 'text', reversible: null, due_at: null, outcome: null, text, goal: null };
  // Whether the item exists is read, and the brief and the item written, in one hold: two briefs of one lesson make one item.
  const { written } = updateDeskItem(item.id, (current) => {
    if (current) return null;
    writeFileAtomic(join(itemDirectory(item, env), 'brief.md'), `${String(brief).trim()}\n`);
    return item;
  }, { env, ...(lock ? { lock } : {}) });
  if (!written) return { error: `lesson ${name} has been brought to Martin already` };
  Object.assign(lesson, { state: 'dismissed', dismissed_at: now.toISOString(), reason: `contradicts a decision of Martin's; brought to him as a change to a text (item ${item.id})` });
  writeLesson(lesson, { env });
  return { lesson, item };
}

/**
 * The runner's reconciliation, and the only way a lesson becomes `landed`: an `in-goal` lesson whose
 * goal is done becomes `landed` with the goal's pull request; one whose goal was dropped is `open`
 * again. Done goals are archived after a day and dropped ones at once, so the archive is read too.
 * A goal that cannot be found leaves its lessons where they are.
 */
export function reconcileLessons({ env = process.env, home = programsHome(env), now = new Date(), goals = null } = {}) {
  const carried = listLessons({ env, state: 'in-goal' });
  if (!carried.length) return [];
  const known = goals ?? goalReferences({ home });
  const changed = [];
  for (const lesson of carried) {
    const matches = known.filter((g) => `${g.programme}/${g.goal}` === lesson.goal && !g.problems?.length);
    const goal = matches.find((g) => g.stage === 'done') ?? matches.at(-1);
    if (!goal) continue;
    if (goal.stage === 'done') {
      const pr = goal.prs?.length ? (typeof goal.prs.at(-1) === 'string' ? goal.prs.at(-1) : prRef(goal.prs.at(-1))) : null;
      Object.assign(lesson, { state: 'landed', pr, landed_at: now.toISOString() });
    } else if (goal.stage === 'dropped') {
      Object.assign(lesson, { state: 'open', goal: null, carried_at: null });
    } else continue;
    writeLesson(lesson, { env });
    changed.push({ name: lesson.name, state: lesson.state, pr: lesson.pr });
  }
  return changed;
}

// ---- Options in a brief, and the lessons the desk writes itself ------------------

/** `- <key>: text` lines of a brief: the options a recommendation or an answer is named by. */
export function briefOptions(text) {
  const options = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^\s*[-*]\s+(?:`([a-z0-9][a-z0-9_-]*)`|\*\*([a-z0-9][a-z0-9_-]*)\*\*|([a-z0-9][a-z0-9_-]*))\s*:\s*(.+)$/u);
    if (match) { const key = match[1] ?? match[2] ?? match[3]; if (!options.has(key)) options.set(key, match[4].trim()); }
  }
  return options;
}

const programmeOfItem = (item) => (item.kind === 'goal' ? item.reference.split('/')[0] : null);

/** Martin answered otherwise than the brief recommended: the lesson, without a model. */
export function recordAnswerDiffers({ env = process.env, item, brief, now = new Date(), by = 'martin' }) {
  const options = briefOptions(brief);
  const text = (key) => options.get(key) ?? '(the brief gives no text for this option)';
  return addLesson({
    env, kind: 'answer-differs', item: item.id, programme: programmeOfItem(item), by, now,
    parts: {
      happened: `Item ${item.id} (${item.reference}): the brief recommended "${item.recommend}": ${text(item.recommend)}\nMartin chose "${item.chose}": ${text(item.chose)}`,
      rule: 'Not yet in general form: the learning pass derives, from this item\'s brief and Martin\'s answer, the rule that would have made the recommendation his.',
      where: 'Not yet named: the learning pass names the code, canon page or technical standard where that rule belongs.',
    },
  });
}

/** The decision pass gave up on an item after two failures: one `unsettled` lesson per item. */
export function recordUnsettled({ env = process.env, item, failures, now = new Date() }) {
  if (listLessons({ env }).some((x) => x.kind === 'unsettled' && x.item === item.id)) return { skipped: true };
  return addLesson({
    env, kind: 'unsettled', item: item.id, programme: programmeOfItem(item), by: 'runner', now,
    parts: {
      happened: `Item ${item.id} (${item.reference}): the decision pass ended twice without settling it, and the runner gave it to Martin as a mechanical brief.\n${failures.map((x) => `- ${x.at}: ${String(x.reason).split('\n')[0].slice(0, 300)}`).join('\n')}`,
      rule: 'Not yet in general form: the learning pass derives from the two endings what the pass lacked (a rule, a check or a refusal) to settle such an item.',
      where: 'Not yet named: the learning pass names the code, canon page or technical standard where that rule belongs.',
    },
  });
}

// ---- What the system changed: a part of the opening ---------------------------------------------

const ageDays = (at, nowMs) => Math.max(0, Math.floor((nowMs - Date.parse(at)) / DAY_MS));
const share = (n, of) => (of > 0 ? Math.round((n / of) * 1000) / 10 : null);
const NOT_MARTINS = ['not-martins', 'wrong-question'];
/** An item "reached Martin" when it was briefed to him: it waits for him or he or the default closed it. */
const reached = (item) => item.state === 'for-martin' || (item.state === 'closed' && ['martin', 'default'].includes(item.outcome?.by));

/** The goal a landed lesson names among live and archived ones: the `done` one, of several the one whose pull requests hold the lesson's, else the last. */
function goalOfLesson(goals, lesson) {
  const matches = goals.filter((g) => `${g.programme}/${g.goal}` === lesson.goal && !g.problems?.length);
  const done = matches.filter((g) => g.stage === 'done');
  const holds = (g) => (g.prs ?? []).some((p) => (typeof p === 'string' ? p : prRef(p)) === lesson.pr);
  return done.filter(holds).at(-1) ?? done.at(-1) ?? matches.at(-1);
}

/**
 * What the system changed, as data, from the lessons and the item store only. `since` is the previous
 * opening (the landed changes and dismissals shown are those after it); the four weeks end at `now`,
 * oldest first, each `(now - 7(w+1) days, now - 7w days]`. No lesson text enters it.
 */
export function buildChanges({ lessons, items, goals = [], since, now }) {
  const nowMs = now.getTime(), sinceMs = Date.parse(since) || 0;
  const live = lessons.filter((x) => x.state === 'open'), carried = lessons.filter((x) => x.state === 'in-goal');
  const oldest = (list) => (list.length ? Math.max(...list.map((x) => ageDays(x.at, nowMs))) : null);
  const between = (at) => Date.parse(at) > sinceMs && Date.parse(at) <= nowMs;

  const groups = new Map();
  for (const lesson of lessons.filter((x) => x.state === 'landed' && between(x.landed_at))) {
    const key = `${lesson.goal}|${lesson.pr}`;
    const goal = goalOfLesson(goals, lesson);
    const entry = groups.get(key) ?? { what: goal?.title || lesson.goal, goal: lesson.goal, pr: lesson.pr, place: lesson.place, where: placeOf(lesson.place), lessons: 0, at: lesson.landed_at };
    entry.lessons += 1; groups.set(key, entry);
  }
  const landed = [...groups.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || String(a.pr).localeCompare(String(b.pr)));

  const late = lessons.filter((x) => ['open', 'in-goal'].includes(x.state) && ageDays(x.at, nowMs) > LATE_DAYS)
    .map((x) => ({ name: x.name, state: x.state, days: ageDays(x.at, nowMs) }));
  const dismissed = lessons.filter((x) => x.state === 'dismissed' && between(x.dismissed_at)).map((x) => ({ name: x.name, reason: x.reason, at: x.dismissed_at }));

  const weeks = [3, 2, 1, 0].map((w) => {
    const end = nowMs - w * 7 * DAY_MS, start = end - 7 * DAY_MS;
    const inWeek = (at) => Date.parse(at) > start && Date.parse(at) <= end;
    const opened = items.filter((item) => inWeek(item.opened_at));
    const toMartin = opened.filter(reached);
    const notHis = toMartin.filter((item) => lessons.some((x) => NOT_MARTINS.includes(x.kind) && x.item === item.id));
    const overturned = lessons.filter((x) => x.kind === 'overturned' && inWeek(x.at)).length;
    const repeats = lessons.filter((x) => inWeek(x.at) && x.place && lessons.some((y) => y.state === 'landed' && y.kind === x.kind && y.place === x.place && Date.parse(y.landed_at) <= Date.parse(x.at))).length;
    return {
      from: new Date(start).toISOString(), to: new Date(end).toISOString(),
      items_opened: opened.length,
      reached_martin: toMartin.length, reached_share: share(toMartin.length, opened.length),
      not_his: notHis.length, not_his_share: share(notHis.length, toMartin.length),
      overturned, repeats,
    };
  });

  return {
    landed,
    open: { count: live.length, oldest_days: oldest(live) },
    in_goal: { count: carried.length, oldest_days: oldest(carried) },
    late, dismissed, weeks,
  };
}

/** The part What the system changed, as text. */
export function renderChanges(changes) {
  const out = ['## What the system changed', ''];
  if (!changes.landed.length) out.push('No change has landed from lessons since the last opening.');
  for (const change of changes.landed) out.push(`- ${change.what} — ${change.where ?? 'unplaced'}${change.place ? ` (${change.place})` : ''} — ${change.pr ?? 'no pull request recorded'}`);
  const age = (n) => (n === null ? '' : `, oldest ${n} day${n === 1 ? '' : 's'}`);
  out.push('', `Lessons still open: ${changes.open.count}${age(changes.open.oldest_days)}. In a goal that has not landed: ${changes.in_goal.count}${age(changes.in_goal.oldest_days)}.`);
  if (changes.late.length) out.push(`Late (older than ${LATE_DAYS} days, neither landed nor dismissed): ${changes.late.map((x) => `${x.name} (${x.state}, ${x.days} days)`).join('; ')}.`);
  out.push(changes.dismissed.length ? `Dismissed since the last opening: ${changes.dismissed.length}. ${changes.dismissed.map((x) => `${x.name}: ${x.reason}`).join(' ')}` : 'Dismissed since the last opening: 0.');
  const pct = (value) => (value === null ? '-' : `${value}%`);
  out.push('', 'Last four weeks, oldest first — items opened; share that reached you; of those, share recorded as not yours or the wrong question; decisions you overturned; lessons repeating a change that had landed:');
  for (const week of changes.weeks) out.push(`- ${week.from.slice(0, 10)} to ${week.to.slice(0, 10)}: ${week.items_opened}; ${pct(week.reached_share)} (${week.reached_martin}); ${pct(week.not_his_share)} (${week.not_his}); ${week.overturned}; ${week.repeats}`);
  return out;
}

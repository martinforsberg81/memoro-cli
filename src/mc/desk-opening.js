/**
 * The desk's opening as data, and the pieces of it the page shares.
 *
 * Everything here reads: the item store, each waiting item's brief.md, the programmes' goals, the desk's runs.tsv
 * and ceiling, the horizons, the lessons and the jev ledger. Nothing here syncs the store, takes a lock or writes a
 * file, so `mc martin` (which syncs first and writes last-open.json after it launches) and the page (which does
 * neither) draw what waits, what was decided and what it costs from the same functions. `buildOpening` is the whole
 * opening; the page calls the parts it shows (texts, acts, stuck, decided, not ready, cost) and never the changes,
 * the horizons or the archive, which cost half a second (docs/technical/mc-martin.md, Opening).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { martinDir, mcHome, programsHome } from './paths.js';
import { itemDirectory, itemStore, listDeskItems } from './desk-items.js';
import { costSum, deskCeiling, deskRunsPath, readDeskText } from './desk-budget.js';
import { ledgerPath } from './jev.js';
import { FINISHED, goalReferences, programmeOrder, programsGoals } from './goals.js';
import { readRunRows } from './landed.js';
import { horizonsOpening } from './desk-horizons.js';
import { isTextSort } from './desk-texts.js';
import { buildChanges, listLessons } from './desk-lessons.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
const PASSES = ['desk-prepare', 'decision', 'learning'];
const BEGINNING = '1970-01-01T00:00:00.000Z';
const LAST_OPEN = 'last-open.json';

export function lastOpenPath(env = process.env) { return join(martinDir(env), LAST_OPEN); }

/** The time of the last successful opening, or null before the first. An unreadable file is an error, never a reason to show the history again. */
export function readLastOpen({ env = process.env, read = readDeskText } = {}) {
  const text = read(lastOpenPath(env));
  if (text == null) return null;
  let value = null;
  try { value = JSON.parse(text); } catch { /* refused below */ }
  if (typeof value?.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new Error(`${lastOpenPath(env)} does not hold a valid "at" time`);
  return value.at;
}

export const timeOf = (text) => Date.parse(text) || 0;
export const oneLine = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();

function storeStart(env) {
  try { return JSON.parse(readDeskText(join(itemStore(env), '.store.json')))?.first_sync_at ?? null; } catch { return null; }
}

/** The start of what the opening calls decided without Martin: the last opening's time, else the store's first sync, else the beginning. */
export function openingSince({ env = process.env, last = null } = {}) { return last ?? storeStart(env) ?? BEGINNING; }

/**
 * Goals of the item's programme that are not finished and wait on this goal's
 * phase, as `{ count, stated }`. In a programme whose phases run in sequence
 * these are the goals in a later phase; in one whose record states its phases,
 * the goals in the phases that wait for this goal's phase, directly or through
 * other phases (`stated` is then true, and the words say so). An invalid record
 * counts none: no phase is open, so nothing is known to wait on this goal.
 */
function laterPhaseGoals(item, goals, { home, read }) {
  if (item.kind !== 'goal') return { count: 0, stated: false };
  const [programme, goal] = item.reference.split('/');
  const own = goals.find((g) => g.programme === programme && g.goal === goal && !g.problems.length);
  if (!own) return { count: 0, stated: false };
  const unfinished = goals.filter((g) => g.programme === programme && !g.problems.length && !FINISHED.includes(g.stage));
  const order = programmeOrder(programme, { home, read });
  if (order.kind === 'invalid') return { count: 0, stated: false };
  if (order.kind === 'sequential') return { count: unfinished.filter((g) => g.phase > own.phase).length, stated: false };
  const waiting = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [phase, list] of Object.entries(order.after)) {
      if (!waiting.has(Number(phase)) && list.some((named) => named === own.phase || waiting.has(named))) { waiting.add(Number(phase)); grew = true; }
    }
  }
  return { count: unfinished.filter((g) => waiting.has(g.phase)).length, stated: true };
}

function programmeOf(item) {
  if (item.kind === 'goal') return item.reference.split('/')[0];
  if (item.kind === 'main-red') return `main-red ${item.reference.slice('main-red:'.length).split('/')[0]}`;
  if (item.kind === 'lesson') return 'lessons';
  if (item.kind === 'programme') return item.reference.slice('programme:'.length);
  if (item.kind === 'text') return item.goal ? item.goal.split('/')[0] : 'texts';
  return 'jev ledger';
}

/** The desk's spending by pass, today (UTC) and over seven days, and its ceiling. A file that cannot be read is `error`, never a throw. */
export function costReading({ env, now, read = readDeskText }) {
  const day = now.toISOString().slice(0, 10), nowMs = now.getTime();
  const out = { day, today: null, last_seven_days: null, unknown_cost_runs: 0, ceiling: null, error: null };
  let runsError = null;
  try {
    // runs.tsv holds every session the runner ever ran (11 000 rows, 1.5 MB in November): a row is built only
    // for a line that names one of the desk's passes, which is what takes the reading from 100 ms to a few.
    // The header is the first non-blank line, as readRunRows takes it.
    const lines = String(read(deskRunsPath(env)) ?? '').split('\n').filter((line) => line.trim());
    const [header = '', ...body] = lines;
    const rows = readRunRows([header, ...body.filter((line) => PASSES.some((pass) => line.includes(pass)))].join('\n')).filter((row) => PASSES.includes(row.kind));
    const today = rows.filter((row) => String(row.ts).slice(0, 10) === day);
    const week = rows.filter((row) => timeOf(row.ts) <= nowMs && nowMs - timeOf(row.ts) < 7 * DAY_MS);
    out.today = costSum(today); out.last_seven_days = costSum(week);
    out.unknown_cost_runs = week.filter((row) => !(Number.isFinite(Number(row.cost)) && Number(row.cost) >= 0)).length;
  } catch (error) { runsError = error; out.error = `runs.tsv unreadable: ${error.message}`; }
  // The ceiling is read as deskBudget reads it, which reads runs.tsv too: a runs.tsv that cannot be read leaves
  // the ceiling unread and is named twice, as the opening has always said it (V1). runs.tsv is read once.
  try { const ceiling = deskCeiling({ env, read }); if (runsError) throw runsError; out.ceiling = ceiling; } catch (error) { out.error = `${out.error ? `${out.error}; ` : ''}ceiling setting unreadable: ${error.message}`; }
  return out;
}

/** `blocks`, and for a programme that states its phases `blocks_stated` (the words of its line). `goals` is read here, when an item needs it. */
function blocksOf(item, goals, home) {
  const goalItem = item.kind === 'text' ? { kind: 'goal', reference: item.goal ?? '' } : item;
  const { count, stated } = laterPhaseGoals(goalItem, goals(), { home, read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } } });
  return { blocks: count, ...(stated ? { blocks_stated: true } : {}) };
}

/** What waits for Martin is a for-martin item of sort text (or its old names product and judgement) or reserved. */
const forMartinItems = (items) => items.filter((item) => item.state === 'for-martin');
const byWaiting = (a, b) => b.blocks - a.blocks || timeOf(a.source_at) - timeOf(b.source_at) || a.id.localeCompare(b.id);

/**
 * The proposed changes to Martin's texts, blocking work first, then the oldest, then by id. `goals` is a function
 * that gives every programme's goals: it is called only when a waiting item needs them, so a desk with nothing
 * waiting reads no goal.
 */
export function openingTexts({ items, env = process.env, home = programsHome(env), goals }) {
  const entry = (item) => ({
    id: item.id, kind: item.kind, reference: item.reference, source_at: item.source_at, sort: item.sort, reversible: item.reversible,
    ...blocksOf(item, goals, home), brief: readDeskText(join(itemDirectory(item, env), 'brief.md')),
  });
  return forMartinItems(items).filter((item) => isTextSort(item.sort)).map((item) => ({
    ...entry(item), text: item.text ?? item.reference, goal: item.goal ?? (item.kind === 'goal' ? item.reference : null),
  })).sort(byWaiting);
}

/** Martin's reserved acts, in the order of the texts. */
export function openingActs({ items, env = process.env, home = programsHome(env), goals }) {
  return forMartinItems(items).filter((item) => item.sort === 'reserved').map((item) => ({
    id: item.id, kind: item.kind, reference: item.reference, source_at: item.source_at, sort: item.sort, reversible: item.reversible,
    ...blocksOf(item, goals, home), brief: readDeskText(join(itemDirectory(item, env), 'brief.md')),
  })).sort(byWaiting);
}

/** A for-martin item of any other sort is the runner's own stop, which is not Martin's: it is stuck. */
export function openingStuck(items) {
  return forMartinItems(items).filter((item) => !isTextSort(item.sort) && item.sort !== 'reserved').map((item) => ({
    id: item.id, reference: item.reference, sort: item.sort ?? null, prepare_failures: item.prepare_failures?.length ?? 0, decision_failures: item.decision_failures?.length ?? 0,
  })).sort((a, b) => a.reference.localeCompare(b.reference) || a.id.localeCompare(b.id));
}

/** The items closed by the decision pass or by default in (since, now], by programme, and how many the source closed. */
export function openingDecided({ items, since, now }) {
  const sinceMs = timeOf(since), nowMs = now.getTime();
  const closed = items.filter((item) => item.state === 'closed' && item.outcome && timeOf(item.outcome.at) > sinceMs && timeOf(item.outcome.at) <= nowMs);
  const decided = closed.filter((item) => ['decision', 'default'].includes(item.outcome.by)).map((item) => ({
    id: item.id, reference: item.reference, programme: programmeOf(item), by: item.outcome.by, at: item.outcome.at, summary: oneLine(item.outcome.summary),
  })).sort((a, b) => timeOf(a.at) - timeOf(b.at) || a.id.localeCompare(b.id));
  const programmes = [...new Set(decided.map((item) => item.programme))].sort().map((programme) => ({ programme, items: decided.filter((item) => item.programme === programme) }));
  return { since, programmes, closed_by_source: closed.filter((item) => item.outcome.by === 'source').length };
}

/** Items still new or prepared, the oldest of them, those that failed, and the runner's stops that are not Martin's. */
export function openingNotReady({ items, stuck, now }) {
  const nowMs = now.getTime();
  const waiting = items.filter((item) => ['new', 'prepared'].includes(item.state));
  const oldest = waiting.reduce((a, b) => (a === null || timeOf(b.source_at) < timeOf(a.source_at) ? b : a), null);
  const failed = waiting.filter((item) => item.prepare_failures?.length || item.decision_failures?.length).map((item) => ({
    id: item.id, reference: item.reference, state: item.state, prepare_failures: item.prepare_failures?.length ?? 0, decision_failures: item.decision_failures?.length ?? 0,
  }));
  return {
    count: waiting.length,
    oldest: oldest ? { id: oldest.id, reference: oldest.reference, state: oldest.state, source_at: oldest.source_at, age_hours: Math.floor((nowMs - timeOf(oldest.source_at)) / 3600000) } : null,
    failed,
    stuck,
  };
}

/**
 * The jev ledger's asks in (since, now]: `asks` the rows answered or decided, `against` the answered rows whose
 * choice differs from the recommendation (a decided row takes the recommendation, as `mc decisions` has it), and
 * the lines that did not parse. A missing ledger is no asks; any other read error throws.
 */
export function ledgerAsks({ env = process.env, since, now, read = readDeskText }) {
  const text = read(ledgerPath(mcHome(env))) ?? '';
  const sinceMs = timeOf(since), nowMs = now.getTime();
  const out = { asks: 0, against: 0, unreadable_lines: 0 };
  for (const line of text.split(/\n/u)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { out.unreadable_lines += 1; continue; }
    if (!['answered', 'decided'].includes(row?.outcome)) continue;
    const at = Date.parse(row.at);
    if (!(at > sinceMs && at <= nowMs)) continue;
    out.asks += 1;
    if (row.outcome === 'answered' && row.answers?.answer?.choice !== row.recommend) out.against += 1;
  }
  return out;
}

/** The opening as data. Reads only; `last` is the previous opening's time, or null. */
export function buildOpening({ env = process.env, home = programsHome(env), now = new Date(), last = null, read = readDeskText } = {}) {
  const since = openingSince({ env, last });
  const items = listDeskItems({ env });
  const all = programsGoals({ home });
  const goals = () => all;
  const stuck = openingStuck(items);
  const horizonData = horizonsOpening({ env, since, now });
  return {
    generated_at: now.toISOString(), last_opened: last, since,
    texts: openingTexts({ items, env, home, goals }), acts: openingActs({ items, env, home, goals }),
    decided: openingDecided({ items, since, now }),
    not_ready: openingNotReady({ items, stuck, now }),
    cost: costReading({ env, now, read }),
    ...(horizonData ? { horizons: horizonData } : {}),
    changes: buildChanges({ lessons: listLessons({ env }), items, goals: goalReferences({ home }), since, now }),
  };
}

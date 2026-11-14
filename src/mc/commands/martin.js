/** Martin's interactive decision desk: the opening it starts from, its read-only queue and item commands. */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandUsage } from '../command-help.js';
import { martinDir, mcHome, programsHome } from '../paths.js';
import { readCanonRole, roleSourceOf } from '../roles.js';
import { openInWorkArea } from '../work-open.js';
import { interactive } from '../prompt.js';
import { scanArgs } from './flags.js';
import { collectMartinQueue, renderMartinQueue } from '../martin-collect.js';
import { deskItemQuestion, itemDirectory, itemStore, listDeskItems, readDeskItem, syncDeskItems, writeDeskItem } from '../desk-items.js';
import { drainDeskPreparation, prepareDeskItem } from '../desk-prepare.js';
import { deskBudget, deskRunsPath, readDeskText, setDeskCeiling } from '../desk-budget.js';
import { sessionIdentity } from '../session-role.js';
import { ledgerPath } from '../jev.js';
import { FINISHED, programsGoals } from '../goals.js';
import { readRunRows } from '../landed.js';
import { writeJsonAtomic } from '../atomic-write.js';
import { addLesson, briefLesson, briefOptions, buildChanges, carryLesson, dismissLesson, lessonRefusal, listLessons, parseLessonInput, recordAnswerDiffers, renderChanges, LESSON_STATES } from '../desk-lessons.js';

export function usage() { return commandUsage('martin'); }

export const ROUTES = {
  '': { booleans: ['--local', '--new', '--resume'], strictValues: ['--model'], toolSugar: true, check: ({ flags, positional }) => {
    if (positional.length > (flags.resume ? 1 : 0)) return `unknown argument ${positional[flags.resume ? 1 : 0]}`;
    if (flags.resume && flags.new) return '--resume and --new cannot be combined';
    if (flags.resume && positional[0] === 'new') return '--resume expects a conversation ID or prefix';
    return null;
  } },
  brief: { booleans: ['--json'], check: ({ positional }) => positional.length ? `unknown argument ${positional[0]}` : null },
  get: { booleans: ['--all', '--json'], strictValues: ['--programme', '--goal'], check: ({ flags, positional }) => {
    if (positional.length) return `unknown argument ${positional[0]}`;
    const selectors = Number(flags.all) + Number(flags.programme !== null) + Number(flags.goal !== null);
    return selectors > 1 ? 'choose exactly one of --all, --programme or --goal' : null;
  } },
  prepare: { check: ({ positional }) => positional.length > 1 ? 'prepare takes at most one item id' : null },
  ceiling: { check: ({ positional }) => positional.length > 1 ? 'ceiling takes one USD amount or off' : null },
  items: { booleans: ['--json'], strictValues: ['--state'], check: ({ positional }) => positional.length ? `unknown argument ${positional[0]}` : null },
  lesson: { strictValues: ['--kind', '--item', '--programme', '--place', '--file', '--goal', '--reason'], check: ({ positional }) => positional.length > 1 ? `unknown argument ${positional[1]}` : null },
  lessons: { booleans: ['--json'], strictValues: ['--state'], check: ({ positional }) => positional.length ? `unknown argument ${positional[0]}` : null },
  item: { strictValues: ['--sort','--reversible','--by','--summary','--summary-file','--recommend','--chose'], check: ({ positional }) => positional.length < 1 ? 'mc martin item expects <id>' : positional.length > 2 ? `unknown argument ${positional[2]}` : null },
};

export async function run(argv, deps = {}) {
  if (argv[0] === 'brief') return brief(argv.slice(1), deps);
  if (argv[0] === 'prepare') return prepare(argv.slice(1), deps);
  if (argv[0] === 'ceiling') return ceiling(argv.slice(1), deps);
  if (argv[0] === 'items') return items(argv.slice(1), deps);
  if (argv[0] === 'item') return item(argv.slice(1), deps);
  if (argv[0] === 'lesson') return lesson(argv.slice(1), deps);
  if (argv[0] === 'lessons') return lessons(argv.slice(1), deps);
  if (argv[0] === 'get') return get(argv.slice(1), deps);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, ROUTES['']);
  const error = scanned.error || ROUTES[''].check(scanned);
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  const env = deps.env || process.env;
  if (env.MC_HEADLESS === '1' || !(deps.interactive || interactive)(env)) {
    stderr.write('mc: martin is an interactive-only desk; unattended launch refused\n');
    return 2;
  }
  const role = (deps.role || (() => readCanonRole('martin')))();
  if (!role?.overlay) { stderr.write('mc: the martin role is missing from this install — expected canon/roles/martin.md with an overlay body\n'); return 1; }
  const now = (deps.now || (() => new Date()))();
  const home = deps.home || programsHome(env);
  let last;
  try { last = readLastOpen({ env, read: deps.read || readDeskText }); } catch (error) { stderr.write(`mc: ${error.message}; correct or remove it, then open the desk again\n`); return 1; }
  const root = (deps.desk || martinDir)(env);
  (deps.mkdir || mkdirSync)(root, { recursive: true });
  const data = openingFor({ env, home, now, last, deps, stderr });
  const opening = renderOpening(data);
  const launch = { overlay: role.overlay, prompt: opening, model: role.model || null };
  const opened = await (deps.open || openInWorkArea)({
    env, areaRoot: root, conversationRoots: [root],
    worktree: { repo: null, path: root, is_git: false }, tool: flags.tool || role.tools?.[0] || 'claude',
    pick: flags.new ? 'new' : flags.resume ? positional[0] || true : null,
    resumeTool: flags.tool, stdout, stderr, verb: 'martin', areaName: 'martin',
    roleName: role.name || 'martin', roleSource: roleSourceOf(role), cache: role.cache,
    model: flags.model, overlay: launch.overlay, prompt: launch.prompt, resumePrompt: `Refresh from the desk now; what you remember of earlier openings is not current.\n\n${opening}`,
    defaultModel: role.model, defaultModelTool: role.tools?.[0] || null,
  });
  if (!opened.ok) { stderr.write(`mc: ${opened.reason}${opened.hint ? ` — ${opened.hint}` : ''}\n`); return 1; }
  (deps.writeLastOpen || writeJsonAtomic)(lastOpenPath(env), { at: now.toISOString() });
  return opened.code ?? 0;
}

function items(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const role = writerRole(env);
  if (!DESK_WRITERS.includes(role)) { stderr.write(`mc: role ${role} cannot sync desk items\n`); return 2; }
  const parsed = scanArgs(argv, ROUTES.items);
  const error = parsed.error || ROUTES.items.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  if (parsed.flags.state && !['new','prepared','for-martin','closed'].includes(parsed.flags.state)) { stderr.write(`mc: unknown state ${parsed.flags.state}\n`); return 2; }
  const home = deps.home || programsHome(env);
  syncDeskItems({ env, home, reportIssue: issue => stderr.write(`mc: source issue ${issue.path}: ${issue.error}\n`), ...(deps.syncDeps || {}) });
  const result = listDeskItems({ env: deps.env || process.env, state: parsed.flags.state });
  const shown = result.map((x) => ({ ...x, question: deskItemQuestion(x, { env, home }) }));
  if (parsed.flags.json) stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
  else for (const x of shown) stdout.write(`${x.id} · ${x.kind} · ${x.reference} · ${x.state} · ${x.sort || 'unsorted'} · ${x.due_at || 'no due date'} · ${x.question}\n`);
  return 0;
}

function item(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const [id, verb, ...rest] = argv;
  if (!id) { stderr.write('mc: usage: mc martin item <id> [prepared|brief|close …]\n'); return 2; }
  const env = deps.env || process.env; const record = readDeskItem(id, { env });
  if (!record) { stderr.write(`mc: unknown item ${id}; no item state or verb applies\n`); return 2; }
  if (!verb) {
    const source = record.kind === 'decision' ? readDecisionRows(env).find((x) => `decision:${x.at}` === record.reference) || null
      : collectMartinQueue({ home: deps.home || programsHome(env) }).items.find((x) => x.reference === record.reference) || null;
    const dir = itemDirectory(record, env); const prepared = maybeRead(join(dir, 'prepared.md')); const brief = maybeRead(join(dir, 'brief.md'));
    stdout.write(`${JSON.stringify({ ...record, source, prepared, brief }, null, 2)}\n`); return 0;
  }
  const role = writerRole(env);
  if (!['person','martin','desk-prepare','decision'].includes(role)) return refused(record, verb, stderr, `role ${role} cannot write desk items`);
  const parsed = scanArgs(rest, ROUTES.item);
  if (parsed.error || parsed.positional.length) return refused(record, verb, stderr, parsed.error || `unknown argument ${parsed.positional[0]}`);
  const f = parsed.flags, dir = itemDirectory(record, env), state = record.state;
  const refuse = (message) => refused(record, verb, stderr, message);
  if (role === 'desk-prepare' && verb !== 'prepared') return refuse('desk-prepare may only use prepared');
  if (verb === 'prepared' && state === 'new' && f.sort && ['mechanical','technical','product','judgement','reserved'].includes(f.sort) && exists(join(dir,'prepared.md'))) {
    record.state = 'prepared'; record.sort = f.sort; writeDeskItem(record, { env }); return 0;
  }
  if (verb === 'brief' && state === 'prepared' && ['product','judgement','reserved'].includes(f.sort) && ['yes','no'].includes(f.reversible) && exists(join(dir,'brief.md'))) {
    if (f.recommend !== null && !briefOptions(maybeRead(join(dir, 'brief.md'))).has(f.recommend)) return refuse(`brief.md names no option "${f.recommend}"; write each option as "- <key>: its consequence"`);
    if (f.recommend !== null) record.recommend = f.recommend;
    record.state = 'for-martin'; record.sort = f.sort; record.reversible = f.reversible === 'yes'; record.due_at = record.reversible ? new Date((deps.now || (() => new Date()))().getTime() + 48*60*60*1000).toISOString() : null; writeDeskItem(record, { env }); return 0;
  }
  if (verb === 'close' && ['prepared','for-martin'].includes(state) && ['decision','martin','default'].includes(f.by)) {
    let summary = f.summary;
    if (f['summary-file']) { try { summary = (deps.readFile || readFileSync)(f['summary-file'], 'utf8').trim(); } catch { return refuse('summary file is missing'); } }
    if (!summary?.trim() || summary.trim().split(/\n\s*\n/u).length > 1) return refuse('close requires one paragraph with --summary or --summary-file');
    if (f.chose !== null && f.by !== 'martin') return refuse('--chose is what Martin chose: only with --by martin');
    const briefText = maybeRead(join(dir, 'brief.md'));
    if (f.chose !== null && !briefOptions(briefText).has(f.chose)) return refuse(`brief.md names no option "${f.chose}"`);
    if (f.by === 'martin' && record.recommend && f.chose === null) return refuse(`the brief recommended "${record.recommend}": close --by martin needs --chose <key> of the option he chose`);
    const closedAt = (deps.now || (() => new Date()))();
    if (f.chose !== null) record.chose = f.chose;
    if (record.recommend && f.chose !== null && f.chose !== record.recommend) {
      const written = recordAnswerDiffers({ env, item: record, brief: briefText, now: closedAt, by: role });
      if (written.error) return refuse(written.error);
    }
    record.state = 'closed'; record.outcome = { by: f.by, at: closedAt.toISOString(), summary: summary.trim() }; writeDeskItem(record, { env }); return 0;
  }
  return refuse('transition not allowed');
}
// ---- Lessons ------------------------------------------------------------------------

function lesson(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const [verb, ...rest] = argv;
  if (!['add', 'carry', 'dismiss', 'brief'].includes(verb)) { stderr.write('mc: usage: mc martin lesson add --kind <kind> [--item <id>] [--programme <p>] [--place <path>] --file <path|->\n  | carry <name> --goal <programme>/<goal> [--place <path>] | dismiss <name> --reason "…" | brief <name> --file <path|->\n'); return 2; }
  const role = writerRole(env);
  const refusal = lessonRefusal(verb, role);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 2; }
  const parsed = scanArgs(rest, ROUTES.lesson);
  const error = parsed.error || ROUTES.lesson.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  const f = parsed.flags, name = parsed.positional[0] ?? null;
  const now = (deps.now || (() => new Date()))();
  const fail = (message) => { stderr.write(`mc: ${message}\n`); return 2; };
  if (verb === 'add') {
    if (name) return fail(`unknown argument ${name}`);
    if (!f.kind || !f.file) return fail('lesson add needs --kind and --file <path|->');
    let text;
    try { text = f.file === '-' ? (deps.readStdin || (() => readFileSync(0, 'utf8')))() : (deps.readFile || readFileSync)(f.file, 'utf8'); } catch { return fail(`cannot read ${f.file}`); }
    const input = parseLessonInput(text);
    if (input.error) return fail(input.error);
    const written = addLesson({ env, kind: f.kind, item: f.item, programme: f.programme, place: f.place, parts: input.parts, by: role, now });
    if (written.error) return fail(written.error);
    stdout.write(`${written.lesson.name}\n`);
    return 0;
  }
  if (!name) return fail(`lesson ${verb} expects <name>`);
  if (verb === 'brief') {
    if (!f.file) return fail('lesson brief needs --file <path|-> with the brief for Martin');
    let text;
    try { text = f.file === '-' ? (deps.readStdin || (() => readFileSync(0, 'utf8')))() : (deps.readFile || readFileSync)(f.file, 'utf8'); } catch { return fail(`cannot read ${f.file}`); }
    const done = briefLesson({ env, name, brief: text, now });
    if (done.error) return fail(done.error);
    stdout.write(`${name} · dismissed · item ${done.item.id}\n`);
    return 0;
  }
  if (verb === 'carry') {
    if (!f.goal) return fail('lesson carry needs --goal <programme>/<goal>');
    const done = carryLesson({ env, name, goal: f.goal, place: f.place, now, home: deps.home || programsHome(env) });
    if (done.error) return fail(done.error);
    stdout.write(`${name} · in-goal · ${f.goal}\n`);
    return 0;
  }
  const done = dismissLesson({ env, name, reason: f.reason, role, since: env.MC_SESSION_STARTED || null, now });
  if (done.error) return fail(done.error);
  stdout.write(`${name} · dismissed\n`);
  return 0;
}

function lessons(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const parsed = scanArgs(argv, ROUTES.lessons);
  const error = parsed.error || ROUTES.lessons.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  if (parsed.flags.state && !LESSON_STATES.includes(parsed.flags.state)) { stderr.write(`mc: unknown state ${parsed.flags.state}\n`); return 2; }
  const found = listLessons({ env, state: parsed.flags.state });
  if (parsed.flags.json) { stdout.write(`${JSON.stringify(found, null, 2)}\n`); return 0; }
  const now = (deps.now || (() => new Date()))().getTime();
  for (const x of found) stdout.write(`${x.name} · ${x.kind} · ${x.state} · ${x.goal ?? 'no goal'}${x.pr ? ` · ${x.pr}` : ''} · ${Math.max(0, Math.floor((now - Date.parse(x.at)) / DAY_MS))} days\n`);
  return 0;
}

const DESK_WRITERS = ['person', 'martin', 'desk-prepare', 'decision'];
function writerRole(env) { const identity = sessionIdentity({ env, cwd: env.cwd || process.cwd() }); return env.MC_ROLE || (env.MC_TOOL && env.MC_TOOL !== 'person' ? 'session' : identity.role || 'person'); }
function refused(record, verb, stderr, why) { stderr.write(`mc: item ${record.id} is ${record.state}; ${why}; ${record.state === 'new' ? 'prepared' : record.state === 'prepared' ? 'brief or close' : record.state === 'for-martin' ? 'close' : 'no verb'} applies\n`); return 2; }
function maybeRead(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } }
function exists(path) { try { return readFileSync(path); } catch { return null; } }
function readDecisionRows(env) { return String(maybeRead(ledgerPath(mcHome(env))) || '').split(/\n/u).filter(Boolean).flatMap(line=>{ try { const row=JSON.parse(line); return [{...row,reference:`decision:${row.at}`}]; } catch { return []; } }); }

export function get(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const selectorFlags = argv.filter((arg) => ['--all', '--programme', '--goal'].includes(arg));
  if (selectorFlags.length > 1) { stderr.write('mc: choose exactly one of --all, --programme or --goal\n'); return 2; }
  const scanned = scanArgs(argv, ROUTES.get);
  const error = scanned.error || ROUTES.get.check(scanned);
  if (error) { stderr.write(`mc: ${error}\n${usage()}`); return 2; }
  const { flags } = scanned;
  const selector = flags.programme !== null ? { kind: 'programme', value: flags.programme }
    : flags.goal !== null ? { kind: 'goal', value: flags.goal }
      : { kind: 'all' };
  const result = (deps.collect || collectMartinQueue)({ selector, home: deps.home || programsHome(deps.env || process.env) });
  if (result.error) { stderr.write(`mc: ${result.error}\n`); return 2; }
  stdout.write(renderMartinQueue(result, { json: flags.json }));
  return 0;
}

// ---- The opening -----------------------------------------------------------
// Built without a model from the item store, the briefs, runs.tsv and the
// ceiling setting. The only write is the store's own idempotent sync, and the
// launch's write of last-open.json after a successful launch.

const DAY_MS = 24 * 60 * 60 * 1000;
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

const timeOf = (text) => Date.parse(text) || 0;
const oneLine = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function openingFor({ env, home, now, last, deps, stderr }) {
  syncDeskItems({ env, home, now: () => now, reportIssue: issue => stderr.write(`mc: source issue ${issue.path}: ${issue.error}\n`), ...(deps.syncDeps || {}) });
  return buildOpening({ env, home, now, last, read: deps.read || readDeskText });
}

function storeStart(env) {
  try { return JSON.parse(readDeskText(join(itemStore(env), '.store.json')))?.first_sync_at ?? null; } catch { return null; }
}

/** Goals of the item's programme in a later phase that are not finished: each waits on this goal's phase. */
function laterPhaseGoals(item, goals) {
  if (item.kind !== 'goal') return 0;
  const [programme, goal] = item.reference.split('/');
  const own = goals.find((g) => g.programme === programme && g.goal === goal && !g.problems.length);
  if (!own) return 0;
  return goals.filter((g) => g.programme === programme && !g.problems.length && !FINISHED.includes(g.stage) && g.phase > own.phase).length;
}

function programmeOf(item) {
  if (item.kind === 'goal') return item.reference.split('/')[0];
  if (item.kind === 'main-red') return `main-red ${item.reference.slice('main-red:'.length).split('/')[0]}`;
  if (item.kind === 'lesson') return 'lessons';
  return 'jev ledger';
}

function costOf(rows) {
  return rows.reduce((sum, row) => { const cost = Number(row.cost); return sum + (Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 10000) : 0); }, 0) / 10000;
}

function costReading({ env, now, read }) {
  const day = now.toISOString().slice(0, 10), nowMs = now.getTime();
  const out = { day, today: null, last_seven_days: null, unknown_cost_runs: 0, ceiling: null, error: null };
  try {
    const rows = readRunRows(read(deskRunsPath(env)) ?? '').filter((row) => PASSES.includes(row.kind));
    const today = rows.filter((row) => String(row.ts).slice(0, 10) === day);
    const week = rows.filter((row) => timeOf(row.ts) <= nowMs && nowMs - timeOf(row.ts) < 7 * DAY_MS);
    out.today = costOf(today); out.last_seven_days = costOf(week);
    out.unknown_cost_runs = rows.filter((row) => !(Number.isFinite(Number(row.cost)) && Number(row.cost) >= 0)).length;
  } catch (error) { out.error = `runs.tsv unreadable: ${error.message}`; }
  try { out.ceiling = deskBudget({ env, now, read }).ceiling; } catch (error) { out.error = `${out.error ? `${out.error}; ` : ''}ceiling setting unreadable: ${error.message}`; }
  return out;
}

/** The opening as data. Reads only; `last` is the previous opening's time, or null. */
export function buildOpening({ env = process.env, home = programsHome(env), now = new Date(), last = null, read = readDeskText } = {}) {
  const nowMs = now.getTime();
  const since = last ?? storeStart(env) ?? BEGINNING;
  const sinceMs = timeOf(since);
  const items = listDeskItems({ env });
  const goals = programsGoals({ home });

  const yours = items.filter((item) => item.state === 'for-martin').map((item) => ({
    id: item.id, kind: item.kind, reference: item.reference, source_at: item.source_at, sort: item.sort, reversible: item.reversible,
    blocks: laterPhaseGoals(item, goals), due: item.due_at && timeOf(item.due_at) - nowMs <= DAY_MS ? item.due_at : null,
    brief: readDeskText(join(itemDirectory(item, env), 'brief.md')),
  })).sort((a, b) => b.blocks - a.blocks || timeOf(a.source_at) - timeOf(b.source_at) || a.id.localeCompare(b.id));

  const closed = items.filter((item) => item.state === 'closed' && item.outcome && timeOf(item.outcome.at) > sinceMs && timeOf(item.outcome.at) <= nowMs);
  const decided = closed.filter((item) => ['decision', 'default'].includes(item.outcome.by)).map((item) => ({
    id: item.id, reference: item.reference, programme: programmeOf(item), by: item.outcome.by, at: item.outcome.at, summary: oneLine(item.outcome.summary),
  })).sort((a, b) => timeOf(a.at) - timeOf(b.at) || a.id.localeCompare(b.id));
  const programmes = [...new Set(decided.map((item) => item.programme))].sort().map((programme) => ({ programme, items: decided.filter((item) => item.programme === programme) }));

  const waiting = items.filter((item) => ['new', 'prepared'].includes(item.state));
  const oldest = waiting.reduce((a, b) => (a === null || timeOf(b.source_at) < timeOf(a.source_at) ? b : a), null);
  const failed = waiting.filter((item) => item.prepare_failures?.length || item.decision_failures?.length).map((item) => ({
    id: item.id, reference: item.reference, state: item.state, prepare_failures: item.prepare_failures?.length ?? 0, decision_failures: item.decision_failures?.length ?? 0,
  }));

  return {
    generated_at: now.toISOString(), last_opened: last, since,
    yours,
    decided: { since, programmes, closed_by_source: closed.filter((item) => item.outcome.by === 'source').length },
    not_ready: {
      count: waiting.length,
      oldest: oldest ? { id: oldest.id, reference: oldest.reference, state: oldest.state, source_at: oldest.source_at, age_hours: Math.floor((nowMs - timeOf(oldest.source_at)) / 3600000) } : null,
      failed,
    },
    cost: costReading({ env, now, read }),
    changes: buildChanges({ lessons: listLessons({ env }), items, goals, since, now }),
  };
}

/** The opening as the text the session starts from. */
export function renderOpening(data) {
  const out = [];
  out.push(`Martin's desk, opened ${data.generated_at}. Decided-without-you covers ${data.since} to ${data.generated_at}${data.last_opened ? '' : ' (first opening)'}.`);
  out.push('', `## Yours (${data.yours.length})`);
  if (!data.yours.length) out.push('', 'Nothing waits for you.');
  data.yours.forEach((item, index) => {
    const blocks = item.blocks ? `, blocks ${plural(item.blocks, 'later-phase goal')} of ${item.reference.split('/')[0]}` : '';
    out.push('', `### ${index + 1}. ${item.reference} · ${item.sort ?? 'unsorted'} · ${item.reversible ? 'reversible' : 'not reversible'}`);
    out.push(`Item ${item.id}, waiting since ${item.source_at}${blocks}.`);
    if (item.due) out.push(`Due ${item.due}: if nothing is said by then, the recommendation in the brief is carried out and the item is closed by default.`);
    out.push('', item.brief ?? '(brief.md is missing)');
  });
  out.push('', '## Decided without you');
  if (!data.decided.programmes.length) out.push('', 'Nothing was decided without you in this interval.');
  for (const group of data.decided.programmes) {
    out.push('', group.programme);
    for (const item of group.items) out.push(`- ${item.at} · ${item.summary} (${item.reference}, ${item.by})`);
  }
  out.push('', `Closed by source in the same interval: ${data.decided.closed_by_source}.`);
  out.push('', '## Not ready');
  const nr = data.not_ready;
  out.push('', nr.count ? `${plural(nr.count, 'item')} still new or prepared. Oldest: ${nr.oldest.reference} (${nr.oldest.state}), waiting ${nr.oldest.age_hours} hours since ${nr.oldest.source_at}.` : 'Nothing is waiting for preparation.');
  if (nr.failed.length) out.push(`Failed: ${nr.failed.map((item) => `${item.reference} (preparation failed ${item.prepare_failures} time${item.prepare_failures === 1 ? '' : 's'}, decision ${item.decision_failures} time${item.decision_failures === 1 ? '' : 's'})`).join('; ')}.`);
  out.push('', '## Cost');
  const cost = data.cost;
  out.push('', `Today (UTC ${cost.day}): ${cost.today === null ? 'unreadable' : `$${cost.today.toFixed(4)}`}. Last seven days: ${cost.last_seven_days === null ? 'unreadable' : `$${cost.last_seven_days.toFixed(4)}`}. Ceiling: ${cost.ceiling === null ? 'off' : `$${cost.ceiling}/day`}.`);
  if (cost.unknown_cost_runs) out.push(`Runs with unknown cost, not counted: ${cost.unknown_cost_runs}.`);
  if (cost.error) out.push(`Cost reading error: ${cost.error}.`);
  out.push('', ...renderChanges(data.changes));
  return `${out.join('\n')}\n`;
}

function brief(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const role = writerRole(env);
  if (!DESK_WRITERS.includes(role)) { stderr.write(`mc: role ${role} cannot sync desk items\n`); return 2; }
  const parsed = scanArgs(argv, ROUTES.brief);
  const error = parsed.error || ROUTES.brief.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  const now = (deps.now || (() => new Date()))();
  const home = deps.home || programsHome(env);
  let last;
  try { last = readLastOpen({ env, read: deps.read || readDeskText }); } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
  const data = openingFor({ env, home, now, last, deps, stderr });
  stdout.write(parsed.flags.json ? `${JSON.stringify(data, null, 2)}\n` : renderOpening(data));
  return 0;
}

async function prepare(argv, deps) {
  const env = deps.env || process.env, stderr = deps.stderr || process.stderr, stdout = deps.stdout || process.stdout;
  if (writerRole(env) !== 'person') { stderr.write('mc: martin prepare is for a person\n'); return 2; }
  const parsed = scanArgs(argv, ROUTES.prepare);
  const error = parsed.error || ROUTES.prepare.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  const options = { env, now: deps.now || (() => new Date()), deps: { ...deps.prepareDeps, say: line => stdout.write(`${line}\n`) } };
  if (!parsed.positional[0]) { await drainDeskPreparation(options); return 0; }
  const turn = await prepareDeskItem({ ...options, id: parsed.positional[0] });
  stdout.write(`mc: desk-prepare: ${turn.reason || 'prepared'}\n`);
  return turn.started && turn.ok ? 0 : 1;
}
function ceiling(argv, deps) {
  const env = deps.env || process.env, stderr = deps.stderr || process.stderr, stdout = deps.stdout || process.stdout;
  const parsed = scanArgs(argv, ROUTES.ceiling);
  const error = parsed.error || ROUTES.ceiling.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  try {
    const value = parsed.positional[0];
    if (value !== undefined) {
      if (writerRole(env) !== 'person') { stderr.write('mc: only a person sets the desk ceiling\n'); return 2; }
      if (value !== 'off' && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) || !Number.isFinite(Number(value)))) throw new Error('ceiling must be a non-negative USD amount or off');
      setDeskCeiling(value === 'off' ? null : Number(value), { env });
    }
    const budget = deskBudget({ env, now: (deps.now || (() => new Date()))() });
    stdout.write(`mc: desk ceiling: ${budget.ceiling === null ? 'off' : `$${budget.ceiling}/day`}; today (${budget.day} UTC): $${budget.spent.toFixed(4)}\n`);
    return 0;
  } catch (error) { stderr.write(`mc: ${error.message}\n`); return 2; }
}

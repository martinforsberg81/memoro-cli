/** Martin's interactive decision desk: the opening it starts from, its read-only queue and item commands. */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandUsage } from '../command-help.js';
import { martinDir, mcHome, programsHome, workRoot } from '../paths.js';
import { readMainMends } from '../main-repair.js';
import { readCanonRole, roleSourceOf } from '../roles.js';
import { openInWorkArea } from '../work-open.js';
import { interactive } from '../prompt.js';
import { scanArgs } from './flags.js';
import { interactiveToolRefusal } from '../interactive-tool.js';
import { collectMartinQueue, renderMartinQueue } from '../martin-collect.js';
import { deskItemQuestion, itemDirectory, listDeskItems, readDeskItem, syncDeskItems, updateDeskItem } from '../desk-items.js';
import { drainDeskPreparation, prepareDeskItem } from '../desk-prepare.js';
import { deskBudget, readDeskText, setDeskCeiling } from '../desk-budget.js';
import { sessionIdentity } from '../session-role.js';
import { ledgerPath } from '../jev.js';
import { isGoalRef, programsGoals } from '../goals.js';
import { writeJsonAtomic } from '../atomic-write.js';
import { HORIZON_STATES, PLAYBACK_PARTS, horizonsDir, parsePlaybackInput, planDrop, planMove, planReached, planReopen, planSet, readHorizon, readHorizons, renderHorizons, updateDeskHorizons, validSlug } from '../desk-horizons.js';
import { isTextSort, proposeText, textForm, textName } from '../desk-texts.js';
import { DAY_MS, buildOpening, lastOpenPath, oneLine, readLastOpen } from '../desk-opening.js';
import { addLesson, briefLesson, briefOptions, carryLesson, dismissLesson, lessonRefusal, listLessons, parseLessonInput, recordAnswerDiffers, renderChanges, LESSON_STATES } from '../desk-lessons.js';

// The opening's data moved to desk-opening.js; these stay importable from here.
export { buildOpening, lastOpenPath, readLastOpen };

export function usage() { return commandUsage('martin'); }

export const ROUTES = {
  '': { booleans: ['--local', '--new', '--resume', '--bg'], strictValues: ['--model'], toolSugar: true, check: ({ flags, positional }) => {
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
  propose: { strictValues: ['--text', '--file', '--goal'], check: ({ positional }) => positional.length ? `unknown argument ${positional[0]}` : null },
  lesson: { strictValues: ['--kind', '--item', '--programme', '--place', '--file', '--goal', '--reason', '--text'], check: ({ positional }) => positional.length > 2 ? `unknown argument ${positional[2]}` : null },
  lessons: { booleans: ['--json'], strictValues: ['--state'], check: ({ positional }) => positional.length ? `unknown argument ${positional[0]}` : null },
  horizon: { booleans: ['--json'], strictValues: ['--title', '--file', '--position', '--reason'], check: ({ positional }) => positional.length > 2 ? `unknown argument ${positional[2]}` : null },
  horizons: { booleans: ['--json'], strictValues: ['--state'], check: ({ positional }) => positional.length ? `unknown argument ${positional[0]}` : null },
  item: { booleans: ['--no-option'], strictValues: ['--sort','--reversible','--by','--summary','--summary-file','--recommend','--chose','--text'], check: ({ positional }) => positional.length < 1 ? 'mc martin item expects <id>' : positional.length > 2 ? `unknown argument ${positional[2]}` : null },
};

export async function run(argv, deps = {}) {
  if (argv[0] === 'brief') return brief(argv.slice(1), deps);
  if (argv[0] === 'prepare') return prepare(argv.slice(1), deps);
  if (argv[0] === 'ceiling') return ceiling(argv.slice(1), deps);
  if (argv[0] === 'items') return items(argv.slice(1), deps);
  if (argv[0] === 'item') return item(argv.slice(1), deps);
  if (argv[0] === 'propose') return propose(argv.slice(1), deps);
  if (argv[0] === 'lesson') return lesson(argv.slice(1), deps);
  if (argv[0] === 'lessons') return lessons(argv.slice(1), deps);
  if (argv[0] === 'horizon') return horizon(argv.slice(1), deps);
  if (argv[0] === 'horizons') return horizons(argv.slice(1), deps);
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
  const tool = flags.tool || role.tools?.[0] || 'claude';
  const notInteractive = interactiveToolRefusal(tool);
  if (notInteractive) { stderr.write(`mc: ${notInteractive}\n`); return 2; }
  const now = (deps.now || (() => new Date()))();
  const home = deps.home || programsHome(env);
  let last;
  try { last = readLastOpen({ env, read: deps.read || readDeskText }); } catch (error) { stderr.write(`mc: ${error.message}; correct or remove it, then open the desk again\n`); return 1; }
  const root = (deps.desk || martinDir)(env);
  (deps.mkdir || mkdirSync)(root, { recursive: true });
  const data = openingFor({ env, home, now, last, deps, stderr });
  if (!data) return 1;
  const opening = renderOpening(data);
  const launch = { overlay: role.overlay, prompt: opening, model: role.model || null };
  const opened = await (deps.open || openInWorkArea)({
    env, areaRoot: root, conversationRoots: [root],
    worktree: { repo: null, path: root, is_git: false }, tool,
    pick: flags.new ? 'new' : flags.resume ? positional[0] || true : null,
    resumeTool: flags.tool, stdout, stderr, verb: 'martin', areaName: 'martin', bg: flags.bg,
    roleName: role.name || 'martin', roleSource: roleSourceOf(role), cache: role.cache,
    model: flags.model, overlay: launch.overlay, prompt: launch.prompt, resumePrompt: `Refresh from the desk now; what you remember of earlier openings is not current.\n\n${opening}`,
    defaultModel: role.model, defaultModelTool: role.tools?.[0] || null,
  });
  if (!opened.ok) { stderr.write(`mc: ${opened.reason}${opened.hint ? ` — ${opened.hint}` : ''}\n`); return opened.code ?? 1; }
  (deps.writeLastOpen || writeJsonAtomic)(lastOpenPath(env), { at: now.toISOString() });
  return opened.code ?? 0;
}

function items(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const role = writerRole(env);
  // The learning pass reads the store: it lists without syncing, takes no lock and writes nothing.
  const reader = role === 'learning';
  if (!DESK_WRITERS.includes(role) && !reader) { stderr.write(`mc: role ${role} cannot sync desk items\n`); return 2; }
  const parsed = scanArgs(argv, ROUTES.items);
  const error = parsed.error || ROUTES.items.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  if (parsed.flags.state && !['new','prepared','for-martin','closed'].includes(parsed.flags.state)) { stderr.write(`mc: unknown state ${parsed.flags.state}\n`); return 2; }
  const home = deps.home || programsHome(env);
  if (!reader) {
    try { syncDeskItems({ env, home, reportIssue: issue => stderr.write(`mc: source issue ${issue.path}: ${issue.error}\n`), ...(deps.syncDeps || {}) }); }
    catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
  }
  const result = listDeskItems({ env: deps.env || process.env, state: parsed.flags.state });
  const shown = result.map((x) => ({ ...x, question: deskItemQuestion(x, { env, home }) }));
  if (parsed.flags.json) stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
  else for (const x of shown) stdout.write(`${x.id} · ${x.kind} · ${x.reference} · ${x.state} · ${x.sort || 'unsorted'} · ${x.question}\n`);
  return 0;
}

/** Why a main-red item cannot be closed by hand, or null when its entry no longer reads Martin. Judged without the main-mend lock: it only reads. */
function heldMainMend(record, env, deps) {
  const [, repo, entryId] = record.reference.match(/^main-red:([^/]+)\/(.+)$/u) || [];
  if (!repo) return null;
  const answer = `answer it with mc repo mend ${repo} ${entryId} requeue|drop --reason "<text>"; the desk item then closes by source`;
  let entries;
  try {
    entries = readMainMends({ root: workRoot(env), repo, read: deps.mendRead || ((path) => readFileSync(path, 'utf8')) });
  } catch (error) { return `main-red ${repo}/${entryId}: its state cannot be read (${error.message}), so it is taken to be still held; ${answer}`; }
  const entry = entries.find((x) => x.id === entryId);
  return entry?.state === 'Martin' ? `main-red ${repo}/${entryId} still reads Martin; ${answer}` : null;
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
  const f = parsed.flags;
  if (role === 'desk-prepare' && verb !== 'prepared') return refused(record, verb, stderr, 'desk-prepare may only use prepared');
  // Everything below is judged on the record read inside the lock, never on the one read above.
  let code = 0;
  const decide = (fresh) => {
    if (!fresh) { stderr.write(`mc: unknown item ${id}; no item state or verb applies\n`); code = 2; return null; }
    const dir = itemDirectory(fresh, env), state = fresh.state;
    const refuse = (message) => { code = refused(fresh, verb, stderr, message); return null; };
    if (verb === 'prepared' && state === 'new' && f.sort && ['mechanical','technical','text','product','judgement','reserved'].includes(f.sort) && exists(join(dir,'prepared.md'))) {
      // product and judgement are the old names of the one sort for a text change; a new record never carries them.
      fresh.state = 'prepared'; fresh.sort = isTextSort(f.sort) ? 'text' : f.sort; return fresh;
    }
    if (verb === 'brief' && state === 'prepared' && ['text','product','judgement','reserved'].includes(f.sort) && ['yes','no'].includes(f.reversible) && exists(join(dir,'brief.md'))) {
      const briefText = maybeRead(join(dir, 'brief.md'));
      if (isTextSort(f.sort)) {
        // A change to a text of Martin's is brought in the form of mc-martin.md: no options, no recommendation, no due time.
        if (f.recommend !== null) return refuse('a text change has no options and no recommendation: it is proposed or the wording stands; leave out --recommend');
        const named = textName(f.text);
        if (named.error) return refuse(`brief --sort text needs --text '<the text>': ${named.error}`);
        const form = textForm(briefText);
        if (form.error) return refuse(form.error);
        fresh.text = named.text; fresh.goal = fresh.kind === 'goal' ? fresh.reference : null; fresh.sort = 'text';
      } else {
        if (f.recommend !== null && !briefOptions(briefText).has(f.recommend)) return refuse(`brief.md names no option "${f.recommend}"; write each option as "- <key>: its consequence"`);
        if (f.recommend !== null) fresh.recommend = f.recommend;
        fresh.sort = f.sort;
      }
      fresh.state = 'for-martin'; fresh.reversible = f.reversible === 'yes'; fresh.due_at = null; return fresh;
    }
    // A main-red question is answered by its repair state, never by a close: mc repo mend is the answer, and the sync closes the item.
    if (verb === 'close' && fresh.kind === 'main-red') {
      const held = heldMainMend(fresh, env, deps);
      if (held) return refuse(held);
    }
    if (f['no-option'] && verb !== 'close') return refuse('--no-option belongs to close');
    if (verb === 'close' && f.by === 'default') return refuse('close --by default is refused: no clock carries out a brief; close --by decision or --by martin');
    if (verb === 'close' && (['prepared','for-martin'].includes(state) || sourceClosedWithSort(fresh)) && ['decision','martin'].includes(f.by)) {
      if (f['no-option'] && f.by !== 'martin') return refuse('--no-option is that Martin chose none of the options: only with --by martin');
      if (f['no-option'] && f.chose !== null) return refuse('--no-option and --chose cannot be combined: he chose an option or none');
      let summary = f.summary;
      if (f['summary-file']) { try { summary = (deps.readFile || readFileSync)(f['summary-file'], 'utf8').trim(); } catch { return refuse('summary file is missing'); } }
      if (!summary?.trim() || summary.trim().split(/\n\s*\n/u).length > 1) return refuse('close requires one paragraph with --summary or --summary-file');
      if (f.chose !== null && f.by !== 'martin') return refuse('--chose is what Martin chose: only with --by martin');
      const briefText = maybeRead(join(dir, 'brief.md'));
      if (f.chose !== null && !briefOptions(briefText).has(f.chose)) return refuse(`brief.md names no option "${f.chose}"`);
      if (f.by === 'martin' && fresh.recommend && f.chose === null && !f['no-option']) return refuse(`the brief recommended "${fresh.recommend}": close --by martin needs --chose <key> of the option he chose, or --no-option when he chose none of them`);
      const closedAt = (deps.now || (() => new Date()))();
      if (f.chose !== null) fresh.chose = f.chose;
      if (fresh.recommend && f.chose !== null && f.chose !== fresh.recommend) {
        const written = recordAnswerDiffers({ env, item: fresh, brief: briefText, now: closedAt, by: role });
        if (written.error) return refuse(written.error);
      }
      // A close over a source closure keeps the closure it replaces.
      const replaced = state === 'closed' ? fresh.outcome : null;
      fresh.state = 'closed'; fresh.outcome = { by: f.by, at: closedAt.toISOString(), summary: summary.trim(), ...(replaced ? { replaced } : {}) }; return fresh;
    }
    return refuse('transition not allowed');
  };
  try { updateDeskItem(id, decide, { env, ...(deps.lock ? { lock: deps.lock } : {}) }); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
  return code;
}
/**
 * A change proposed to a text Martin holds, left at the desk in the form of mc-martin.md. Open to the person and every
 * session role but desk-prepare, headless or not: a session without a goal has no other way to the desk. Every refusal
 * is exit 2 with nothing written; a lock that cannot be had is exit 1.
 */
function propose(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const fail = (message) => { stderr.write(`mc: ${message}\n`); return 2; };
  const role = writerRole(env);
  if (role === 'desk-prepare') return fail('role desk-prepare cannot propose a text change: it only prepares');
  if (role === 'ask-reader') return fail('role ask-reader cannot propose a text change: its answer is mc ask answer … text');
  const parsed = scanArgs(argv, ROUTES.propose);
  const error = parsed.error || ROUTES.propose.check(parsed);
  if (error) return fail(error);
  const f = parsed.flags;
  const named = textName(f.text);
  if (named.error) return fail(`mc martin propose: ${named.error}`);
  if (!f.file) return fail('mc martin propose needs --file <path|-> with the brief: "## Vad den säger", "## Vad som föreslås", "## Vad som hittades"');
  let goal = null;
  if (f.goal !== null && f.goal !== undefined) {
    if (!isGoalRef(f.goal)) return fail('--goal expects <programme>/<goal>');
    const home = deps.home || programsHome(env);
    if (!programsGoals({ home }).some((g) => `${g.programme}/${g.goal}` === f.goal && !g.problems.length)) return fail(`no readable goal ${f.goal}`);
    goal = f.goal;
  }
  let text;
  try { text = f.file === '-' ? (deps.readStdin || (() => readFileSync(0, 'utf8')))() : (deps.readFile || readFileSync)(f.file, 'utf8'); } catch { return fail(`cannot read ${f.file}`); }
  const now = (deps.now || (() => new Date()))();
  let done;
  try { done = proposeText({ env, text: named.text, brief: text, goal, now, ...(deps.lock ? { lock: deps.lock } : {}) }); } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
  if (done.error) return fail(done.error);
  stdout.write(`${done.item.id}\n`);
  return 0;
}

// ---- Lessons ------------------------------------------------------------------------

function lesson(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const [verb, ...rest] = argv;
  if (!['add', 'carry', 'dismiss', 'brief'].includes(verb)) { stderr.write('mc: usage: mc martin lesson add --kind <kind> [--item <id>] [--programme <p>] [--place <path>] --file <path|->\n  | carry <name> --goal <programme>/<goal> [--place <path>] | dismiss <name> --reason "…" | brief <name> --text "<the text>" --file <path|->\n'); return 2; }
  const role = writerRole(env);
  const refusal = lessonRefusal(verb, role);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 2; }
  const parsed = scanArgs(argv, ROUTES.lesson); // the sub-verb is the first positional, the lesson's name the second
  const error = parsed.error || ROUTES.lesson.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  const f = parsed.flags, name = parsed.positional[1] ?? null;
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
    const named = textName(f.text);
    if (named.error) return fail(`lesson brief needs --text '<the text>': ${named.error}`);
    let text;
    try { text = f.file === '-' ? (deps.readStdin || (() => readFileSync(0, 'utf8')))() : (deps.readFile || readFileSync)(f.file, 'utf8'); } catch { return fail(`cannot read ${f.file}`); }
    let done;
    try { done = briefLesson({ env, name, text: named.text, brief: text, now, ...(deps.lock ? { lock: deps.lock } : {}) }); } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
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

// ---- Horizons -----------------------------------------------------------------------

const HORIZON_VERBS = ['set', 'show', 'move', 'reached', 'reopen', 'drop'];
const HORIZON_USAGE = 'mc: usage: mc martin horizon set <slug> --title <t> --file <path|-> [--position n] | show <slug> [--json] | move <slug> --position n | reached <slug> --file <path|-> | reopen <slug> --reason <t> [--position n] | drop <slug> --reason <t>\n';

/** Who may write a horizon: the interactive desk or a person; `reached` also the unattended manager. Null when the caller may. */
function horizonRefusal(verb, role, env) {
  const headless = env.MC_HEADLESS === '1';
  if (!headless && (role === 'martin' || role === 'person')) return null;
  if (verb === 'reached' && headless && role === 'manager') return null;
  if (verb === 'reached' && role === 'manager') return 'horizon reached is refused to the interactive manager; take it to the desk (mc martin), or let the unattended manager mark it';
  const caller = `${headless ? 'an unattended ' : ''}${role}`;
  return verb === 'reached'
    ? `horizon reached is refused to ${caller}; only the interactive desk (mc martin), a person or the unattended manager marks a horizon reached`
    : `horizon ${verb} is refused to ${caller}; only the interactive desk (mc martin) or a person sets, moves, reopens or drops a horizon`;
}

function horizon(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const [verb] = argv;
  if (!HORIZON_VERBS.includes(verb)) { stderr.write(HORIZON_USAGE); return 2; }
  const fail = (message) => { stderr.write(`mc: ${message}\n`); return 2; };
  const role = writerRole(env);
  if (verb !== 'show') { const refusal = horizonRefusal(verb, role, env); if (refusal) return fail(refusal); }
  const parsed = scanArgs(argv, ROUTES.horizon); // the sub-verb is the first positional, the slug the second
  const error = parsed.error || ROUTES.horizon.check(parsed);
  if (error) return fail(error);
  const f = parsed.flags, slug = parsed.positional[1] ?? null;
  if (!slug) return fail(`horizon ${verb} expects <slug>`);
  if (!validSlug(slug)) return fail(`${slug} is not a slug: lowercase letters, digits and hyphens, starting with a letter or digit`);
  if (verb === 'show') {
    const found = readHorizon(slug, { env });
    if (!found) return fail(`unknown horizon ${slug}`);
    if (f.json) {
      const { playback, now_true, ...record } = found;
      stdout.write(`${JSON.stringify({ ...record, playback, now_true }, null, 2)}\n`);
      return 0;
    }
    const lines = [`${found.title} (${found.slug}) · ${found.state}${found.position ? ` · ${found.position}` : ''}`, `set ${found.set_at} by ${found.set_by}`];
    if (found.reopened_at) lines.push(`reopened ${found.reopened_at} by ${found.reopened_by}: ${found.reopen_reason}`);
    if (found.dropped_at) lines.push(`dropped ${found.dropped_at} by ${found.dropped_by}: ${found.drop_reason}`);
    for (const [key, title] of PLAYBACK_PARTS) lines.push('', `## ${title}`, '', found.playback[key]);
    lines.push('', `basis: ${join(horizonsDir(env), slug, 'basis.md')}`);
    if (found.now_true !== null) lines.push('', `## Now true (reached ${found.reached_at} by ${found.reached_by})`, '', found.now_true.trim());
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  const now = (deps.now || (() => new Date()))().toISOString();
  const readInput = () => {
    if (!f.file) return { error: `horizon ${verb} needs --file <path|->` };
    try { return { text: f.file === '-' ? (deps.readStdin || (() => readFileSync(0, 'utf8')))() : (deps.readFile || readFileSync)(f.file, 'utf8') }; } catch { return { error: `cannot read ${f.file}` }; }
  };
  const reasonOf = () => oneLine(f.reason);
  let position = null;
  if (f.position !== null && f.position !== undefined) {
    if (verb !== 'set' && verb !== 'move' && verb !== 'reopen') return fail(`horizon ${verb} takes no --position`);
    if (!/^[1-9][0-9]*$/u.test(f.position)) return fail('--position must be a whole number from 1');
    position = Number(f.position);
  }
  let plan;
  if (verb === 'set') {
    const title = oneLine(f.title);
    if (!title || /[\r\n]/u.test(f.title ?? '')) return fail('horizon set needs --title, one non-empty line');
    const input = readInput(); if (input.error) return fail(input.error);
    const playback = parsePlaybackInput(input.text); if (playback.error) return fail(playback.error);
    plan = (held) => planSet(held, { slug, title, playback: `${input.text.trimEnd()}\n`, position, by: role, now });
  } else if (verb === 'move') {
    if (position === null) return fail('horizon move needs --position n');
    plan = (held) => planMove(held, { slug, position });
  } else if (verb === 'reached') {
    const input = readInput(); if (input.error) return fail(input.error);
    if (!input.text.trim()) return fail('horizon reached needs what is now true, not an empty file');
    plan = (held) => planReached(held, { slug, statement: `${input.text.trimEnd()}\n`, by: role, now });
  } else if (verb === 'reopen') {
    if (!reasonOf()) return fail('horizon reopen needs --reason <text>');
    plan = (held) => planReopen(held, { slug, reason: reasonOf(), position, by: role, now });
  } else {
    if (!reasonOf()) return fail('horizon drop needs --reason <text>');
    plan = (held) => planDrop(held, { slug, reason: reasonOf(), by: role, now });
  }
  let done;
  try { done = updateDeskHorizons(plan, { env, ...(deps.lock ? { lock: deps.lock } : {}) }); } catch (error) { stderr.write(`mc: ${error.message}\n`); return 1; }
  if (done.error) return fail(done.error);
  stdout.write(`${slug} · ${verb === 'reached' ? 'reached' : verb === 'drop' ? 'dropped' : `open · ${done.position}`}\n`);
  return 0;
}

function horizons(argv, deps) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const parsed = scanArgs(argv, ROUTES.horizons);
  const error = parsed.error || ROUTES.horizons.check(parsed);
  if (error) { stderr.write(`mc: ${error}\n`); return 2; }
  if (parsed.flags.state && !HORIZON_STATES.includes(parsed.flags.state)) { stderr.write(`mc: unknown state ${parsed.flags.state}\n`); return 2; }
  const { horizons: found, unreadable } = readHorizons({ env, state: parsed.flags.state });
  if (unreadable.length) stderr.write(`mc: horizon record cannot be read, left as it is: ${unreadable.join(', ')}\n`);
  if (parsed.flags.json) { stdout.write(`${JSON.stringify(found, null, 2)}\n`); return 0; }
  for (const x of found) stdout.write(`${x.slug} · ${x.state} · ${x.position ?? '-'} · ${x.title}\n`);
  return 0;
}

const DESK_WRITERS = ['person', 'martin', 'desk-prepare', 'decision'];
export function writerRole(env) { const identity = sessionIdentity({ env, cwd: env.cwd || process.cwd() }); return env.MC_ROLE || (env.MC_TOOL && env.MC_TOOL !== 'person' ? 'session' : identity.role || 'person'); }
/** Closed by the source after it was prepared or briefed: the one closed item a close still applies to. */
function sourceClosedWithSort(record) { return record.state === 'closed' && record.outcome?.by === 'source' && record.sort != null; }
function refused(record, verb, stderr, why) { stderr.write(`mc: item ${record.id} is ${record.state}; ${why}; ${record.state === 'new' ? 'prepared' : record.state === 'prepared' ? 'brief or close' : record.state === 'for-martin' || sourceClosedWithSort(record) ? 'close' : 'no verb'} applies\n`); return 2; }
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
// The data is built in desk-opening.js, which only reads, from the item store, the briefs, runs.tsv and the
// ceiling setting; the page reads the same data there and writes nothing. The writes belong to this launch: the
// store's own idempotent sync before the opening is built, and last-open.json after a successful launch.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The opening, or null when the sync could not take the lock: the message is on stderr and nothing is printed or opened. */
function openingFor({ env, home, now, last, deps, stderr }) {
  try { syncDeskItems({ env, home, now: () => now, reportIssue: issue => stderr.write(`mc: source issue ${issue.path}: ${issue.error}\n`), ...(deps.syncDeps || {}) }); }
  catch (error) { stderr.write(`mc: ${error.message}\n`); return null; }
  return buildOpening({ env, home, now, last, read: deps.read || readDeskText });
}

/** What an item blocks, as the end of its line: `, blocks 2 later-phase goals of <programme>`, or nothing. */
function blocksPhrase(item) {
  if (!item.blocks) return '';
  const programme = (item.goal ?? item.reference).split('/')[0];
  return item.blocks_stated ? `, blocks ${plural(item.blocks, 'goal')} of ${programme} whose ${item.blocks === 1 ? 'phase waits' : 'phases wait'} for it`
    : `, blocks ${plural(item.blocks, 'later-phase goal')} of ${programme}`;
}

/** The part Where a new thing goes: reference for placing, never something that waits. */
function renderPlacing(placing) {
  const out = ['## Where a new thing goes', ''];
  out.push(`Today is ${placing.date}. A proposal is a file named \`${placing.file_name}\`, in \`${placing.programs_path}/<programme>/proposals/\` when a programme owns it, else in \`${placing.proposals_path}\`.`);
  out.push('', 'The programmes, one line each:');
  if (!placing.programmes.length) out.push('_none_');
  else for (const programme of placing.programmes) out.push(`- ${programme.name} — ${programme.line}`);
  return out;
}

/** The opening as the text the session starts from. */
export function renderOpening(data) {
  const out = [];
  out.push(`Martin's desk, opened ${data.generated_at}. Decided-without-you covers ${data.since} to ${data.generated_at}${data.last_opened ? '' : ' (first opening)'}.`);
  if (data.horizons) out.push('', ...renderHorizons(data.horizons));
  out.push('', `## Proposed changes to your texts (${data.texts.length})`);
  if (!data.texts.length) out.push('', 'No change to a text of yours is proposed.');
  data.texts.forEach((item, index) => {
    out.push('', `### ${index + 1}. ${item.text}`);
    out.push(`Item ${item.id}, waiting since ${item.source_at}, ${item.goal ? `goal ${item.goal}` : 'no goal'}${blocksPhrase(item)}.`);
    out.push('', item.brief ?? '(brief.md is missing)');
  });
  out.push('', `## Your acts (${data.acts.length})`);
  if (!data.acts.length) out.push('', 'No act of yours waits.');
  data.acts.forEach((item, index) => {
    out.push('', `### ${index + 1}. ${item.reference} · ${item.sort ?? 'unsorted'} · ${item.reversible ? 'reversible' : 'not reversible'}`);
    out.push(`Item ${item.id}, waiting since ${item.source_at}${blocksPhrase(item)}.`);
    out.push('', item.brief ?? '(brief.md is missing)');
  });
  out.push('', '## Decided without you');
  if (!data.decided.programmes.length) out.push('', 'Nothing was decided without you in this interval.');
  for (const group of data.decided.programmes) {
    out.push('', group.programme);
    for (const item of group.items) out.push(`- ${item.flagged ? (item.unread ? 'UNREAD: ' : 'NOT THE RECOMMENDATION: ') : ''}${item.at} · ${item.summary} (${item.reference}, ${item.by}${item.answered_by ? `, answered by ${item.answered_by}` : ''})`);
  }
  out.push('', `Closed by source in the same interval: ${data.decided.closed_by_source}.`);
  out.push('', '## Not ready');
  const nr = data.not_ready;
  out.push('', nr.count ? `${plural(nr.count, 'item')} still new or prepared. Oldest: ${nr.oldest.reference} (${nr.oldest.state}), waiting ${nr.oldest.age_hours} hours since ${nr.oldest.source_at}.` : 'Nothing is waiting for preparation.');
  if (nr.stuck.length) out.push(`Stuck after the decision pass, not yours: ${nr.stuck.map((item) => `${item.reference} (preparation failed ${item.prepare_failures} time${item.prepare_failures === 1 ? '' : 's'}, decision ${item.decision_failures} time${item.decision_failures === 1 ? '' : 's'})`).join('; ')}.`);
  if (nr.failed.length) out.push(`Failed: ${nr.failed.map((item) => `${item.reference} (preparation failed ${item.prepare_failures} time${item.prepare_failures === 1 ? '' : 's'}, decision ${item.decision_failures} time${item.decision_failures === 1 ? '' : 's'})`).join('; ')}.`);
  out.push('', '## Cost');
  const cost = data.cost;
  out.push('', `Today (UTC ${cost.day}): ${cost.today === null ? 'unreadable' : `$${cost.today.toFixed(4)}`}. Last seven days: ${cost.last_seven_days === null ? 'unreadable' : `$${cost.last_seven_days.toFixed(4)}`}. Ceiling: ${cost.ceiling === null ? 'off' : `$${cost.ceiling}/day`}.`);
  if (cost.unknown_cost_runs) out.push(`Runs with unknown cost, not counted: ${cost.unknown_cost_runs}.`);
  if (cost.error) out.push(`Cost reading error: ${cost.error}.`);
  out.push('', ...renderChanges(data.changes));
  out.push('', ...renderPlacing(data.placing));
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
  if (!data) return 1;
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

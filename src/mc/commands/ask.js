/**
 * `mc ask` — the one way to ask for advice. jev is asked first; when jev does not settle it, a fresh read-only
 * reader (`ask-reader.js`) answers inside the same call. The answer is one of four: continue with an option, a
 * goal defect (written as `mc goal defect` writes it), a text of Martin's that would change (a desk item, and the
 * caller continues inside the wording that stands), or the session's own recommendation recorded as unread.
 * Nothing it asks makes a goal wait on Martin except a reserved act and a defect. Every answer is a ledger row.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { commandUsage } from '../command-help.js';
import { writeFileAtomic } from '../atomic-write.js';
import { answerVerb, askReaderCall } from '../ask-reader.js';
import { deskBudget, deskBudgetReason } from '../desk-budget.js';
import { proposeText } from '../desk-texts.js';
import { appendLedgerLine, askJev, askWithinLimit, buildState, documentPath, INSTRUCTIONS, judge, JEV_KEY, ledgerPath, readAnswers, reading, readMartinCall, redactText, redactValue, requestBody, returnInstruction, secretsOf, sha256, WORK_INSTRUCTIONS } from '../jev.js';
import { readKeysDotenv } from '../keys-dotenv.js';
import { mcHome, programsHome } from '../paths.js';
import { repoNameOf } from '../repos.js';
import { appendEntry, goalDirIn, GOAL_FILE, parseGoal, setGoalState } from '../goals.js';
import { knownRepositories } from '../work-area.js';
import { jevContext, reportDefect } from './goal.js';
import { only, scanArgs } from './flags.js';

// --kind stays a value flag so an old call still parses; it is ignored (one stderr line).
const VALUE_FLAGS = ['--reason', '--option', '--recommend', '--kind', '--evidence', '--evidence-file', '--document', '--reserved'];
const SCAN = { strictValues: VALUE_FLAGS, repeatable: ['--option', '--document'] };
const ASK_ROUTE = only(SCAN, VALUE_FLAGS);
const ANSWER_ROUTE = { strictValues: ['--why', '--part', '--found', '--inside', '--text', '--file'], booleans: ['--none'] };
export const ROUTES = { '': ASK_ROUTE, answer: ANSWER_ROUTE, '*': ASK_ROUTE };

const KIND_LINE = 'mc: --kind is not read — whether a text of Martin’s would change is the reader’s finding\n';
const flat = (value) => String(value ?? '').replace(/\s*\n\s*/gu, ' ').trim();

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  if (env.MC_ROLE === 'desk-prepare') { stderr.write('mc: desk-prepare cannot ask or decide\n'); return 2; }
  if (env.MC_ROLE === 'plan-review') { stderr.write('mc: a plan-review session cannot ask or decide — it reads, writes PLAN-REVIEW.md and records its verdict\n'); return 2; }
  if (env.MC_ROLE === 'martin' && env.MC_HEADLESS === '1') {
    stderr.write('mc: the Martin role is interactive-only; unattended sessions cannot use mc ask\n');
    return 2;
  }
  if (env.MC_ROLE === 'ask-reader' && argv[0] !== 'answer') {
    stderr.write('mc: an ask-reader session cannot ask — it answers with mc ask answer <id> continue|defect|text …\n');
    return 2;
  }
  if (argv[0] === 'answer') {
    return answerVerb({ argv: argv.slice(1), ctx: { stdout, stderr, env, now: deps.now ? deps.now() : new Date(), readFile: deps.readFile }, deps: deps.answer || {} });
  }
  const scanned = scanArgs(argv, SCAN);
  const named = scanned.positional?.[0] ?? env.MC_GOAL;
  let values = null;
  try { values = (deps.readKeys || (() => readKeysDotenv({ env, home: env.HOME || process.env.HOME }).values))(); } catch { values = null; }
  const secrets = secretsOf(values);
  const clean = (value) => redactText(value, secrets);
  if (scanned.error) { stderr.write(clean(`mc: ${scanned.error}\n${usage()}`)); return 2; }
  const args = scanned.positional;
  const flags = scanned.flags;
  if (args.length > 1) { stderr.write(clean(usage())); return 2; }
  if (flags.kind !== null && flags.kind !== undefined) stderr.write(KIND_LINE);
  const call = readMartinCall({ reason: flags.reason, option: flags.option, recommend: flags.recommend, reserved: flags.reserved });
  const problems = [...(call.problems || [])];
  if (flags.evidence !== null && flags['evidence-file'] !== null) problems.push('--evidence and --evidence-file are one or the other, not both');
  let evidence = flags.evidence ?? '';
  if (!problems.length && flags['evidence-file'] !== null) {
    try { evidence = (deps.readFile || readEntryFile)(flags['evidence-file']).replace(/\n$/u, ''); }
    catch (error) { problems.push(`--evidence-file ${flags['evidence-file']} cannot be read (${error.message})`); }
  }
  if (problems.length) { stderr.write(clean(returnInstruction(problems, named, 'mc: mc ask is not called'))); return 2; }
  const home = deps.home || programsHome(env);
  const now = deps.now ? deps.now() : new Date();
  const stamp = now.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const read = deps.read || readTextOrNull;
  const cwd = env.cwd || process.cwd();
  let target = null;
  let goal = null;
  let roleStage = null;
  if (named) {
    const [programme, goalName, ...extra] = named.split('/');
    if (extra.length || !/^[a-z][a-z0-9-]*$/u.test(programme || '') || !/^[a-z][a-z0-9-]*$/u.test(goalName || '')) { stderr.write(clean(`mc: ${named} is not <programme>/<goal>\n`)); return 2; }
    target = { programme, goal: goalName, name: named, dir: goalDirIn(home, programme, goalName) };
    const text = read(join(target.dir, GOAL_FILE));
    if (text === null) { stderr.write(clean(`mc: no goal ${named} — ${target.dir} has no ${GOAL_FILE}\n`)); return 1; }
    goal = parseGoal(text);
    if (goal.problems) { for (const problem of goal.problems) stderr.write(clean(`mc: ${named}: ${problem}\n`)); return 1; }
    if (['done', 'dropped'].includes(goal.stage)) { stderr.write(clean(`mc: ${named} is ${goal.stage} — a finished goal cannot be changed by mc ask\n`)); return 1; }
    if (env.MC_GOAL && env.MC_GOAL !== named) { stderr.write(clean(`mc: goal session ${env.MC_GOAL} cannot ask for ${named}\n`)); return 2; }
    if (env.MC_ROLE && !['build-session:goal', 'review-session:goal', 'mend-session', 'plan', 'martin', 'decision'].includes(env.MC_ROLE)) { stderr.write(clean(`mc: ${env.MC_ROLE} cannot change a goal through mc ask\n`)); return 2; }
    roleStage = { 'build-session:goal': 'build', 'review-session:goal': 'review', 'mend-session': 'merge' }[env.MC_ROLE] ?? null;
    if (roleStage && goal.stage !== roleStage) { stderr.write(clean(`mc: ${env.MC_ROLE} cannot ask for ${named} in ${goal.stage}\n`)); return 2; }
  }
  const programme = target?.programme || env.MC_PROGRAMME || programmeFromCwd(cwd, home);
  const writeLedger = (fields) => {
    const ledger = redactValue({ at: now.toISOString(), goal: target?.name ?? null, verb: 'ask', programme: programme ?? null,
      tool: env.MC_TOOL || null, role: env.MC_ROLE || null, question: call.question, options: call.options, recommend: call.recommend, kind: null,
      reserved: null, documents: [], trimmed: [], state_length: null, state_sha256: null, budget: null, error_type: null,
      model: null, answers: null, ...fields }, secrets);
    try { (deps.ledger || ((line) => appendLedgerLine(ledgerPath(mcHome(env)), line)))(`${JSON.stringify(ledger)}\n`); }
    catch (error) { stderr.write(`mc: warning: the jev ledger is not written (${clean(error.message)})\n`); }
  };
  const writeEntry = ({ toMartin, done, comment, next }) => {
    if (!target) return;
    const why = recordGoalAsk({ target, snapshot: goal, roleStage, toMartin, read, write: deps.write || writeFileAtomic,
      entry: { at: stamp, tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: env.MC_ROLE || 'person', done: clean(done), comment: clean(comment), next: clean(next) } });
    if (why) stderr.write(clean(`mc: ${why}\n`));
  };
  const optionLines = [...Object.entries(call.options).map(([key, option]) => `Option ${key}: ${flat(option)}`), `Recommended: ${call.recommend}`, `Evidence: ${evidence || 'none supplied'}`];
  const question = flat(call.question);

  if (call.reserved) {
    const said = `mc: reserved act ${call.reserved} — Martin decides, jev is not asked`;
    writeLedger({ answered_by: 'martin', reserved: call.reserved, outcome: 'reserved', reason: said });
    writeEntry({ toMartin: true, done: said.replace(/^mc: /u, ''), comment: [`Martin is asked: ${call.question}`, ...optionLines.slice(0, -1), `Evidence: ${evidence || 'none supplied'}`, said].join('\n'), next: 'wait for Martin' });
    stdout.write(`${clean(said)}\n`);
    return 1;
  }

  let context;
  const safeStderr = { write: (line) => stderr.write(clean(line)) };
  if (target) context = jevContext(target, goal, flags.document, { read, env, home, stderr: safeStderr, realpath: deps.realpath, cwd });
  else context = noGoalContext(programme, flags.document, { home, env, read, stderr: safeStderr, list: deps.list, known: deps.known || (() => knownRepositories(env)), realpath: deps.realpath, gitRoot: deps.gitRoot, cwd });

  const key = values && typeof values[JEV_KEY] === 'string' && values[JEV_KEY] ? values[JEV_KEY] : null;
  const { built, answer: result, budget, limit } = await askWithinLimit({
    build: (within) => buildState({ question: call.question, options: call.options, evidence, ...context }, { secrets, budget: within }),
    ask: (state) => (values === null ? { unavailable: 'the mc keys source cannot be read' }
      : askJev({ body: requestBody(state, state.options, target ? INSTRUCTIONS : WORK_INSTRUCTIONS), key, ...(deps.jev || {}) })),
  });
  if (built.problems) {
    const core = built.problems[0].includes('alone are');
    if (core) { stderr.write(clean(returnInstruction(built.problems, named, 'mc: mc ask is not called'))); return 2; }
  }
  let asked;
  const sent = { documents: [], trimmed: built.trimmed || [], length: built.text?.length ?? null, sha256: built.text ? sha256(built.text) : null, budget: built.text ? budget : null, error_type: limit };
  if (built.problems) asked = { unavailable: 'state over budget after trimming' };
  else {
    if (key) sent.documents = built.state.documents.map((item) => item.path);
    const parsed = result.unavailable ? result : readAnswers(result.response, call.options);
    if (parsed.unavailable) asked = { unavailable: `jev unavailable: ${parsed.unavailable}` };
    else {
      const outcome = judge(parsed.answers, call.recommend);
      asked = { ...parsed, outcome: outcome.outcome, misses: outcome.misses, reading: reading(parsed.answers, parsed.model) };
    }
  }
  const jevFields = { documents: sent.documents, trimmed: sent.trimmed, state_length: sent.length, state_sha256: sent.sha256, budget: sent.budget, error_type: sent.error_type, model: asked.model ?? null, answers: asked.answers ?? null };
  const optionText = (choice) => call.options[choice];

  if (asked.outcome === 'answered') {
    const said = `mc: jev answered ${asked.reading} — continue with: ${optionText(asked.answers.answer.choice)}`;
    writeLedger({ ...jevFields, answered_by: 'jev', outcome: 'answered', chosen: asked.answers.answer.choice, reason: said.replace(/^mc: /u, '') });
    writeEntry({ toMartin: false, done: `jev answered ${asked.reading}`, comment: [`jev was asked: ${question}`, ...optionLines, said].join('\n'), next: `continue with: ${optionText(asked.answers.answer.choice)}` });
    stdout.write(`${clean(said)}\n`);
    return 0;
  }

  // jev did not settle it: a reader reads it now, or nothing could and the session decides, recorded as unread.
  const jevText = asked.reading ? `${asked.reading} — not answered: ${(asked.misses || []).join('; ')}` : `jev was not read: ${asked.unavailable}`;
  const jevWhy = asked.reading || asked.unavailable;
  const unreadAnswer = ({ why, reader = null }) => {
    const said = `mc: decided by the session, unread (${why}) — continue with: ${optionText(call.recommend)}`;
    writeLedger({ ...jevFields, answered_by: 'session', outcome: 'decided', chosen: call.recommend, unread_reason: why, ...(reader ? { reader } : {}), reason: said.replace(/^mc: /u, '') });
    writeEntry({ toMartin: false, done: `Decided by the session, unread: ${optionText(call.recommend)}`, comment: [`Decided by the session, unread: ${question}`, ...optionLines, `jev reading: ${jevWhy}`, `Unread because: ${why}`, said].join('\n'), next: `continue with: ${optionText(call.recommend)}` });
    stdout.write(`${clean(said)}\n`);
    return 0;
  };
  if (values === null) return unreadAnswer({ why: 'the mc keys source cannot be read, so nothing was copied and no reader was launched' });
  let held = null;
  try { const b = deps.budget ? deps.budget() : deskBudget({ env, now }); if (b.held) held = deskBudgetReason(b); }
  catch (error) { held = `the desk ceiling cannot be read: ${error.message}`; }
  if (held) return unreadAnswer({ why: held });

  stderr.write('mc: jev did not settle it — a reader reads it now (up to 10 minutes)\n');
  const trees = readerTrees({ target, goal, cwd, deps });
  let reader;
  try {
    reader = await (deps.askReader || askReaderCall)({ call, evidence, jevText, goalName: target?.name ?? null, goal, programme, readme: context.programme?.readme ?? null,
      documents: context.documents || [], trees, asker: { tool: env.MC_TOOL || null, model: env.MC_MODEL || null }, env, secrets, stderr: safeStderr, deps: deps.reader || {} });
  } catch (error) { reader = { read: false, reason: `the reader could not be launched: ${error.message}` }; }
  if (!reader?.read) return unreadAnswer({ why: reader?.reason || 'no reader answered', reader: reader?.tool ? { tool: reader.tool, model: reader.model } : null });
  const verdict = reader.verdict;
  const who = { tool: reader.tool, model: reader.model };
  const readerRow = (extra = {}) => ({ ...jevFields, answered_by: 'reader', reader: { ...who, ...extra } });

  if (verdict.kind === 'continue' && optionText(verdict.key) !== undefined) {
    const differs = verdict.key !== call.recommend;
    const said = `mc: the reader answered ${verdict.key} — continue with: ${optionText(verdict.key)}${differs ? `\n  why: ${verdict.why}` : ''}`;
    writeLedger({ ...readerRow({ key: verdict.key, why: verdict.why }), outcome: 'read', chosen: verdict.key, reason: said.replace(/^mc: /u, '').replace(/\n\s*/gu, ' ') });
    writeEntry({ toMartin: false, done: `the reader answered ${verdict.key}`, comment: [`The reader (${who.tool} ${who.model}) was asked: ${question}`, ...optionLines, `jev reading: ${jevWhy}`, said].join('\n'), next: `continue with: ${optionText(verdict.key)}` });
    stdout.write(`${clean(said)}\n`);
    return 0;
  }

  if (verdict.kind === 'defect' && target) {
    const out = { text: '', err: '' };
    const ctx = { stdout: { write: (t) => { out.text += t; } }, stderr: { write: (t) => { out.err += t; } }, env, home, now, read, write: deps.write || writeFileAtomic,
      readFile: deps.readFile || readEntryFile, readKeys: () => values };
    const flagsOf = { part: verdict.part, found: verdict.found, evidence: `the ask reader (${who.tool} ${who.model}) found this answering: ${question}`, 'evidence-file': null, next: null, 'next-file': null };
    const code = reportDefect([target.name], flagsOf, ctx);
    if (code === 0) {
      writeLedger({ ...readerRow({ part: verdict.part, found: verdict.found }), outcome: 'defect', chosen: null, reason: `the reader found a goal defect: ${verdict.part}` });
      stdout.write(`mc: the reader found a goal defect — ${clean(verdict.part)}\n${clean(out.text)}`);
      return 0;
    }
    return unreadAnswer({ why: `the reader found a goal defect, which could not be recorded (${flat(out.err).replace(/^mc: /u, '')})`, reader: who });
  }

  if (verdict.kind === 'text' && (verdict.inside === null || optionText(verdict.inside) !== undefined)) {
    let proposed;
    try { proposed = proposeText({ env, text: verdict.text, brief: verdict.brief, goal: target?.name ?? null, now, ...(deps.lock ? { lock: deps.lock } : {}), ...(deps.proposeRead ? { read: deps.proposeRead } : {}) }); }
    catch (error) { proposed = { error: error.message || String(error) }; }
    if (!proposed.error) {
      const item = proposed.item;
      const other = item.goal && item.goal !== (target?.name ?? null) ? item.goal : null;
      const itemNote = `desk item ${item.id}${proposed.duplicate ? ' (already open)' : ''}${other ? `, also asked by goal ${other}` : ''}`;
      const inside = verdict.inside;
      const said = inside !== null
        ? `mc: a text of Martin’s would change — ${itemNote}; continue inside the wording with: ${optionText(inside)}`
        : `mc: no option stays inside the wording — the part that needs it waits on ${itemNote}; continue with the rest and say in LOG.md what waits`;
      writeLedger({ ...readerRow({ inside, text: verdict.text }), outcome: 'text', chosen: inside, desk_item: item.id, other_goal: other, reason: said.replace(/^mc: /u, '') });
      writeEntry({ toMartin: false, done: inside !== null ? `a text of Martin’s would change: continue with ${optionText(inside)}` : 'a text of Martin’s would change: no option stays inside the wording',
        comment: [`The reader (${who.tool} ${who.model}) was asked: ${question}`, ...optionLines, `jev reading: ${jevWhy}`, `Text: ${verdict.text}`, said].join('\n'),
        next: inside !== null ? `continue with: ${optionText(inside)}` : 'continue with the rest; what needs the text waits on the desk item' });
      stdout.write(`${clean(said)}\n`);
      return inside !== null ? 0 : 1;
    }
    return unreadAnswer({ why: `the reader found a text of Martin’s would change, which could not be recorded (${flat(proposed.error)})`, reader: who });
  }
  return unreadAnswer({ why: 'the reader’s verdict could not be carried out', reader: who });
}

/** The worktrees the reader gets a copy of: the goal's repositories that exist in its directory, or the working directory's repository. */
function readerTrees({ target, goal, cwd, deps }) {
  const exists = deps.exists || existsSync;
  if (target && goal) return (goal.repos || []).map((repo) => ({ repo, path: join(target.dir, repo) })).filter((one) => exists(one.path));
  const top = (deps.gitRoot || gitRoot)(cwd);
  return top ? [{ repo: basename(top), path: top }] : [];
}

/**
 * Logs a goal-bound ask in the goal's LOG.md and, when `toMartin`, sets the goal
 * Martin. It judges the goal as it is now, not as it was read before the model
 * wait, which can outlast a person's move: a finished goal, or one the session's
 * role no longer owns, is not written; a goal a person has moved since keeps its
 * stage and status, and the question is logged for them. Returns why the goal
 * was left alone, or null.
 */
function recordGoalAsk({ target, snapshot, roleStage, toMartin, entry, read, write }) {
  const current = goalNow(target, read);
  if (!current) return `${target.name} no longer reads — the ask is not recorded in its goal`;
  if (['done', 'dropped'].includes(current.stage)) return `${target.name} is ${current.stage} — the ask is not recorded in its goal`;
  if (roleStage && current.stage !== roleStage) return `${target.name} is in ${current.stage}, not ${roleStage} — the ask is not recorded in its goal`;
  const stamped = { ...entry, stage: current.stage, status: current.status };
  const moved = current.stage !== snapshot.stage || current.status !== snapshot.status;
  if (toMartin && !moved) setGoalState({ dir: target.dir, status: 'Martin', entry: stamped, read, write });
  else appendEntry({ dir: target.dir, entry: stamped, read, write });
  return toMartin && moved ? `${target.name} is ${current.stage} · ${current.status} now — the question is logged, Martin is not set over it` : null;
}

/** The goal as it reads now, or null when it does not read or is not valid. */
function goalNow(target, read) {
  const text = read(join(target.dir, GOAL_FILE));
  const parsed = text === null ? null : parseGoal(text);
  return parsed && !parsed.problems ? parsed : null;
}

function noGoalContext(programme, extra, ctx) {
  const documents = [];
  const roots = [];
  if (programme) {
    const base = join(ctx.home, programme);
    const known = new Set((ctx.known?.() || []).map(repoNameOf));
    for (const repo of (ctx.list || listDirs)(base)) {
      const repoRoot = join(base, repo);
      if (!['docs', 'goals', 'proposals'].includes(repo) && (known.has(repo) || existsSync(join(repoRoot, '.git')))) roots.push(repoRoot);
    }
    const readme = ctx.read(join(base, 'README.md'));
    for (const path of extra) addExtra(path);
    return { goal: null, programme: { readme }, documents, log: [] };
  }
  for (const path of extra) addExtra(path);
  return { goal: null, programme: null, documents, log: [] };

  function addExtra(path) {
    const base = programme ? join(ctx.home, programme) : ctx.cwd;
    const resolved = documentPath(path, { goalDir: base, home: ctx.env.HOME || process.env.HOME });
    const top = programme ? null : (ctx.gitRoot?.(ctx.cwd) || gitRoot(ctx.cwd));
    const allowed = programme ? roots : (top ? [top] : []);
    const safePath = confined(resolved, allowed, ctx.realpath);
    if (!safePath) { ctx.stderr.write(`mc: ${path} is outside the goal's and programme's repositories — not sent to jev\n`); return; }
    addDocument(path, null, safePath);
  }
  function addDocument(path, label, absolute) {
    const text = ctx.read(absolute);
    if (text === null) { ctx.stderr.write(`mc: ${path} cannot be read — not sent to jev\n`); return; }
    documents.push({ path, ...(label ? { label } : {}), text });
  }
}

function confined(path, roots, realpath = realpathSync) {
  try {
    const actual = realpath(path);
    const inside = roots.some((root) => {
      const base = realpath(root);
      const rel = relative(base, actual);
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    });
    return inside ? actual : null;
  } catch { return false; }
}
function programmeFromCwd(cwd, home) {
  const rel = relative(home, resolve(cwd));
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' ? rel.split(sep)[0] : null;
}
function gitRoot(cwd) { const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }
function listDirs(path) { try { return readdirSync(path, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name); } catch { return []; } }
function readTextOrNull(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } }
function readEntryFile(path) { return readFileSync(path === '-' ? 0 : path, 'utf8'); }
export function usage() { return commandUsage('ask'); }

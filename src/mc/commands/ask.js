/** `mc ask` — a decision-support question for jev, without changing a goal. */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { commandUsage } from '../command-help.js';
import { writeFileAtomic } from '../atomic-write.js';
import { appendLedgerLine, askJev, buildState, documentPath, judge, JEV_KEY, ledgerPath, readAnswers, reading, readMartinCall, redactText, redactValue, requestBody, returnInstruction, secretsOf, sha256, WORK_INSTRUCTIONS } from '../jev.js';
import { readKeysDotenv } from '../keys-dotenv.js';
import { mcHome, programsHome } from '../paths.js';
import { repoNameOf } from '../repos.js';
import { appendEntry, goalDirIn, GOAL_FILE, parseGoal } from '../goals.js';
import { knownRepositories } from '../work-area.js';
import { jevContext } from './goal.js';
import { only, scanArgs } from './flags.js';

const VALUE_FLAGS = ['--reason', '--option', '--recommend', '--evidence', '--evidence-file', '--document', '--reserved'];
const SCAN = { strictValues: VALUE_FLAGS, repeatable: ['--option', '--document'] };
const ASK_ROUTE = only(SCAN, VALUE_FLAGS);
export const ROUTES = { '': ASK_ROUTE, '*': ASK_ROUTE };

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
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
  const call = readMartinCall({ reason: flags.reason, option: flags.option, recommend: flags.recommend, reserved: flags.reserved });
  const problems = [...(call.problems || [])];
  if (flags.evidence !== null && flags['evidence-file'] !== null) problems.push('--evidence and --evidence-file are one or the other, not both');
  let evidence = flags.evidence ?? '';
  if (!problems.length && flags['evidence-file'] !== null) {
    try { evidence = (deps.readFile || readEntryFile)(flags['evidence-file']).replace(/\n$/u, ''); }
    catch (error) { problems.push(`--evidence-file ${flags['evidence-file']} cannot be read (${error.message})`); }
  }
  if (problems.length) { stderr.write(clean(returnInstruction(problems, named, 'mc: mc ask is not called').replaceAll('mc goal martin', 'mc ask'))); return 2; }
  const home = deps.home || programsHome(env);
  const now = deps.now ? deps.now() : new Date();
  const read = deps.read || readTextOrNull;
  let target = null;
  let goal = null;
  if (named) {
    const [programme, goalName, ...extra] = named.split('/');
    if (extra.length || !/^[a-z][a-z0-9-]*$/u.test(programme || '') || !/^[a-z][a-z0-9-]*$/u.test(goalName || '')) { stderr.write(clean(`mc: ${named} is not <programme>/<goal>\n`)); return 2; }
    target = { programme, goal: goalName, name: named, dir: goalDirIn(home, programme, goalName) };
    const text = read(join(target.dir, GOAL_FILE));
    if (text === null) { stderr.write(clean(`mc: no goal ${named} — ${target.dir} has no ${GOAL_FILE}\n`)); return 1; }
    goal = parseGoal(text);
    if (goal.problems) { for (const problem of goal.problems) stderr.write(clean(`mc: ${named}: ${problem}\n`)); return 1; }
  }
  const programme = target?.programme || env.MC_PROGRAMME || programmeFromCwd(env.cwd || process.cwd(), home);
  if (call.reserved) {
    const said = `mc: reserved act ${call.reserved} — Martin decides, jev is not asked`;
    const ledger = redactValue({ at: now.toISOString(), goal: target?.name ?? null, verb: 'ask', programme: programme ?? null,
      tool: env.MC_TOOL || null, role: env.MC_ROLE || null, question: call.question, options: call.options, recommend: call.recommend,
      reserved: call.reserved, documents: [], trimmed: [], state_length: null, state_sha256: null,
      model: null, answers: null, outcome: 'reserved', reason: said }, secrets);
    try { (deps.ledger || ((line) => appendLedgerLine(ledgerPath(mcHome(env)), line)))(`${JSON.stringify(ledger)}\n`); }
    catch (error) { stderr.write(`mc: warning: the jev ledger is not written (${clean(error.message)})\n`); }
    stdout.write(`${clean(said)}\n`);
    return 1;
  }
  let context;
  const safeStderr = { write: (line) => stderr.write(clean(line)) };
  if (target) context = jevContext(target, goal, flags.document, { read, env, home, stderr: safeStderr, realpath: deps.realpath, cwd: env.cwd || process.cwd() });
  else context = noGoalContext(programme, flags.document, { home, env, read, stderr: safeStderr, list: deps.list, known: deps.known || (() => knownRepositories(env)), realpath: deps.realpath, gitRoot: deps.gitRoot, cwd: env.cwd || process.cwd() });

  const built = buildState({ question: call.question, options: call.options, evidence, ...context }, { secrets });
  if (built.problems) {
    const core = built.problems[0].includes('alone are');
    if (core) { stderr.write(clean(returnInstruction(built.problems, named, 'mc: mc ask is not called').replaceAll('mc goal martin', 'mc ask'))); return 2; }
  }
  let asked;
  let sent = { documents: context.documents.map((item) => item.path), trimmed: built.trimmed || [], length: built.text?.length ?? null, sha256: built.text ? sha256(built.text) : null };
  if (built.problems) asked = { unavailable: 'state over budget after trimming' };
  else {
    const key = values && typeof values[JEV_KEY] === 'string' && values[JEV_KEY] ? values[JEV_KEY] : null;
    const result = values === null ? { unavailable: 'the mc keys source cannot be read' }
      : await askJev({ body: requestBody(built.state, built.state.options, WORK_INSTRUCTIONS), key, ...(deps.jev || {}) });
    const parsed = result.unavailable ? result : readAnswers(result.response, call.options);
    if (parsed.unavailable) asked = { unavailable: `jev unavailable: ${parsed.unavailable}` };
    else {
      const outcome = judge(parsed.answers, call.recommend);
      asked = { ...parsed, outcome: outcome.outcome, misses: outcome.misses, reading: reading(parsed.answers, parsed.model) };
    }
  }
  const answered = asked.outcome === 'answered';
  const said = answered
    ? `mc: jev answered ${asked.reading} — continue with: ${call.options[asked.answers.answer.choice]}`
    : `mc: jev did not settle it: ${asked.reading ? `${asked.reading} — not answered: ${asked.misses.join('; ')}` : asked.unavailable} — take it to Martin`;
  const ledger = redactValue({ at: now.toISOString(), goal: target?.name ?? null, verb: 'ask', programme: programme ?? null,
    tool: env.MC_TOOL || null, role: env.MC_ROLE || null, question: call.question, options: call.options, recommend: call.recommend,
    reserved: null, documents: sent.documents, trimmed: sent.trimmed, state_length: sent.length, state_sha256: sent.sha256,
    model: asked.model ?? null, answers: asked.answers ?? null, outcome: answered ? 'answered' : (asked.outcome || 'unavailable'), reason: said.replace(/^mc: /u, '') }, secrets);
  try { (deps.ledger || ((line) => appendLedgerLine(ledgerPath(mcHome(env)), line)))(`${JSON.stringify(ledger)}\n`); }
  catch (error) { stderr.write(`mc: warning: the jev ledger is not written (${clean(error.message)})\n`); }
  if (answered && target) {
    const logPath = join(target.dir, 'LOG.md');
    const old = read(logPath) || '';
    const entry = { at: now.toISOString().replace(/\.\d{3}Z$/u, 'Z'), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: env.MC_ROLE || 'person', done: clean(`jev answered ${asked.reading}`), comment: clean(said), next: clean(`continue with: ${call.options[asked.answers.answer.choice]}`), stage: goal.stage, status: goal.status };
    appendEntry({ dir: target.dir, entry, read, write: deps.write || writeFileAtomic });
  }
  stdout.write(`${clean(said)}\n`);
  return answered ? 0 : 1;
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
    const rulings = roots.map((root) => {
      const path = `${root.slice(base.length + 1)}/docs/project/${programme}/rulings.md`;
      const text = ctx.read(join(base, path));
      return text === null ? null : { path, text };
    }).filter(Boolean);
    const readme = ctx.read(join(base, 'README.md'));
    for (const path of extra) addExtra(path);
    return { goal: null, programme: { readme, rulings }, documents, log: [] };
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

/**
 * `mc project` — mc's own verbs over a project (ruling 48, `docs/project/mc/mc-project.md`).
 *
 * It writes a plan's draft and records whether a success criterion is met: the
 * register's, never a pull request's. Whoever measured a criterion by its check
 * says so here.
 *
 *   mc project new <programme>/<project> --repo <repo> --goal <text> --contract <text>... --out-of-scope <text>...   draft a plan, as DRAFT.json
 *   mc project edit <project> [--goal <text>] [--contract <text>...] [--out-of-scope <text>...]                     change a draft's goal, contract or out of scope
 *   mc project criterion add <project> <text> --check <command>   add a success criterion, to a draft or a sent plan
 *   mc project criterion edit <project> <n> --check <command>     change success criterion <n>'s check, and record it not met
 *   mc project criterion drop <project> <n> --reason "…"          remove a criterion nobody can measure, from a draft or a sent plan; the register's log records why
 *   mc project step add <project> <title> --model haiku|opus --done-when <text> --instruction-file <md> [--effort <level>] [--after <repo>:<project>]
 *                                                                 add a step, after the others, to a draft or a sent plan
 *   mc project step edit <project> <n> [--title <text>] [--model haiku|opus] [--effort <level>] [--done-when <text>] [--instruction-file <md>]
 *                                                                 change the named fields of a step, of a draft or of a sent plan that has not started
 *   mc project send <project>                    check a draft whole and rename it to PLAN.json: the handover to the runner
 *   mc project archive <project>                 done: its row to the repository's project_log.md, CLOSEOUT.json beside the plan, its step area closed
 *   mc project discard <project> [--apply]       gone: its directory, step area, register file and open pull requests; without --apply it shows what would go
 *   mc project <name> [--json] [--offline]       show a project: a sent plan as mc status <name> does, a draft as it stands
 *   mc project criterion met [<project>] <n>     record that success criterion <n> holds
 *   mc project criterion unmet [<project>] <n>   record that success criterion <n> does not hold
 *
 * The project defaults to MC_STEP's in a runner session, so a step session
 * names only the criterion number.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultRepos, listArchived, listPlans } from '../brief-collect.js';
import { closable, closeArea } from '../close-workarea.js';
import { stopServersUnder } from '../dev-servers.js';
import { runDocsMerge } from '../docs-merge.js';
import { EFFORT_LEVELS, NAME_RE, PLAN_SCHEMA, PLAN_VERSION, planState, readPlanText, validatePlan } from '../plan-schema.js';
import { PLAN_FILE, programsPlans } from '../plan-source.js';
import { bannedWords, checkWords, dependencyWords, DRAFT_FILE, draftProblems, findProjectDir, instructionParagraphs, MODELS, readDraftOrPlan, sendProblems, withPlanLock, writePlanFile } from '../plan-write.js';
import { applyEntry, dropCriterion as dropRegisterCriterion, parseStepEnv, readEntry, registerPath, stepKey, updateCriterion } from '../register.js';
import { layoutVersion, programsHome, runnerDir, runnerTablePath, stepAreaName, UNDOCUMENTED_CLOSURES, workRoot } from '../paths.js';
import { archivePrograms, closeoutFileOf } from '../project-archive.js';
import { discardWorkArea } from '../work-area.js';
import { scanArgs } from './flags.js';

/** The flags each verb takes; any other flag given to a verb is refused with exit 2. */
const NEW_FLAGS = ['--repo', '--goal', '--contract', '--out-of-scope'];
const EDIT_FLAGS = ['--goal', '--contract', '--out-of-scope'];
const STEP_ADD_FLAGS = ['--model', '--effort', '--done-when', '--instruction-file', '--after'];
const STEP_EDIT_FLAGS = ['--title', '--model', '--effort', '--done-when', '--instruction-file'];
/** The words `mc project` takes as its verb. Any other single word is a project's name, for `mc project <name>`. */
const VERB_WORDS = ['criterion', 'new', 'edit', 'step', 'send', 'archive', 'discard'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const now = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const io = { read: deps.read, write: deps.write, lock: deps.lock, append: deps.append };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];

  const scanned = scanArgs(argv, {
    booleans: ['--apply', '--json', '--offline'],
    strictValues: ['--repo', '--goal', '--check', '--model', '--effort', '--done-when', '--after', '--instruction-file', '--title', '--reason'],
    repeatable: ['--contract', '--out-of-scope'],
  });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const [noun, verb, ...rest] = scanned.positional;
  if (scanned.flags.apply && noun !== 'discard') { stderr.write(usage()); return 2; }
  if (noun === 'send') {
    const extra = onlyFlags(scanned, []);
    if (extra) { stderr.write(`mc: send takes no ${extra}\n`); return 2; }
    return sendPlan(scanned, { ...deps, env, stdout, stderr });
  }
  if (noun === 'archive') {
    const extra = onlyFlags(scanned, []);
    if (extra) { stderr.write(`mc: archive takes no ${extra}\n`); return 2; }
    return archiveProject(scanned, { ...deps, env, stdout, stderr, root });
  }
  if (noun === 'discard') {
    const extra = onlyFlags(scanned, ['--apply']);
    if (extra) { stderr.write(usage()); return 2; }
    return discardProject(scanned, { ...deps, env, stdout, stderr, root });
  }
  if (noun !== undefined && !VERB_WORDS.includes(noun)) {
    if (scanned.positional.length !== 1) { stderr.write(usage()); return 2; }
    const extra = onlyFlags(scanned, ['--json', '--offline']);
    if (extra) { stderr.write(`mc: ${noun} takes no ${extra}\n`); return 2; }
    return showProject(noun, scanned.flags, { ...deps, env, stdout, stderr });
  }
  if (noun === 'new') {
    const extra = onlyFlags(scanned, NEW_FLAGS);
    if (extra) { stderr.write(`mc: new takes no ${extra}\n`); return 2; }
    return newPlan(scanned, { ...deps, env, stdout, stderr });
  }
  if (noun === 'edit') {
    const extra = onlyFlags(scanned, EDIT_FLAGS);
    if (extra) { stderr.write(`mc: edit takes no ${extra}\n`); return 2; }
    return editPlan(scanned, { ...deps, env, stdout, stderr });
  }
  if (noun === 'criterion' && verb === 'add') {
    const extra = onlyFlags(scanned, ['--check']);
    if (extra) { stderr.write(`mc: criterion add takes no ${extra}\n`); return 2; }
    return addCriterion(scanned, { ...deps, env, stdout, stderr });
  }
  if (noun === 'criterion' && verb === 'edit') {
    const extra = onlyFlags(scanned, ['--check']);
    if (extra) { stderr.write(`mc: criterion edit takes no ${extra}\n`); return 2; }
    return editCriterion(scanned, { ...deps, env, stdout, stderr, root, now, io });
  }
  if (noun === 'criterion' && verb === 'drop') {
    const extra = onlyFlags(scanned, ['--reason']);
    if (extra) { stderr.write(`mc: criterion drop takes no ${extra}\n`); return 2; }
    return dropCriterion(scanned, { ...deps, env, stdout, stderr, root, now, io });
  }
  if (noun === 'step' && verb === 'add') {
    const extra = onlyFlags(scanned, STEP_ADD_FLAGS);
    if (extra) { stderr.write(`mc: step add takes no ${extra}\n`); return 2; }
    return addStep(scanned, { ...deps, env, stdout, stderr });
  }
  if (noun === 'step' && verb === 'edit') {
    const extra = onlyFlags(scanned, STEP_EDIT_FLAGS);
    if (extra) { stderr.write(`mc: step edit takes no ${extra}\n`); return 2; }
    return editStep(scanned, { ...deps, env, stdout, stderr, root, io });
  }
  if (noun !== 'criterion' || (verb !== 'met' && verb !== 'unmet') || rest.length < 1 || rest.length > 2) {
    stderr.write(usage());
    return 2;
  }
  const extra = onlyFlags(scanned, []);
  if (extra) { stderr.write(`mc: criterion ${verb} takes no ${extra}\n`); return 2; }
  const [project, number] = rest.length === 2 ? rest : [parseStepEnv(env.MC_STEP)?.project, rest[0]];
  if (!project) { stderr.write('mc: which project? mc project criterion met <project> <n>, or MC_STEP in a runner session\n'); return 2; }
  if (!/^\d+$/u.test(number)) { stderr.write(`mc: ${number} is not a criterion number — 1 is the plan's first\n`); return 2; }
  const entry = readEntry(root, project, io);
  if (!entry) { stderr.write(`mc: ${project} is not in the register\n`); return 1; }

  try {
    updateCriterion({ root, project, number: Number(number), met: verb === 'met', now, ...io });
    stdout.write(`mc: ${project} criterion ${number} — ${verb === 'met' ? 'met' : 'not met'}\n`);
    return 0;
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
}

/**
 * `mc project send <project>` — checks a draft whole (`sendProblems`) and, when it
 * passes, renames it to `PLAN.json`. That rename is the handover: the runner and
 * every reader take a plan from `PLAN.json`, and none of them reads a draft. A
 * refused draft stays where it is, and says why, one problem a line.
 */
function sendPlan(scanned, deps) {
  const { env, stdout, stderr } = deps;
  const home = deps.home || programsHome(env);
  const rename = deps.rename || renameSync;

  const target = scanned.positional.slice(1);
  if (target.length !== 1) { stderr.write(usage()); return 2; }
  const [project] = target;
  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: no project ${project} under ${home}\n`); return 1; }
  if (found.sent) { stderr.write(`mc: ${project} is sent already — ${found.file}\n`); return 1; }
  const sentFile = join(found.dir, PLAN_FILE);

  let outcome;
  try {
    outcome = withPlanLock(found.dir, () => {
      const plan = readDraftOrPlan(found.file);
      const problems = sendProblems(plan);
      if (problems.length) return { problems };
      rename(found.file, sentFile);
      return { plan };
    });
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  if (outcome.problems) {
    stderr.write(`mc: ${project} is not sent:\n`);
    for (const problem of outcome.problems) stderr.write(`  ${problem}\n`);
    return 1;
  }
  stdout.write(`mc: ${project} sent — ${sentFile}\n`);
  stdout.write(`${runnerLine(outcome.plan)}\n`);
  return 0;
}

/** What the runner does with a sent plan's first step, read off `planState`: it takes it, or says what it waits for. */
function runnerLine(plan) {
  const state = planState(plan);
  if (state.status === 'ready') return 'the runner takes step 1 on its next pass';
  const { kind, name } = state.step?.blocked_by ?? {};
  return `step 1 waits: ${kind} ${name}`;
}

/**
 * `mc project <name> [--json] [--offline]` — a sent plan, or a project of a
 * repository with no draft here, is `mc status <name>`: the same call, so the two
 * print the same. A draft is printed as it stands, with whether `send` would take
 * it. `--json` and `--offline` are `mc status`'s, and a draft has neither to give.
 */
async function showProject(name, flags, deps) {
  const { env, stdout, stderr } = deps;
  const home = deps.home || programsHome(env);
  const found = findProjectDir(home, name);
  if (!found || found.sent) {
    const argv = [name, ...(flags.json ? ['--json'] : []), ...(flags.offline ? ['--offline'] : [])];
    const statusProject = deps.statusProject || (async (args, opts) => (await import('./status-project.js')).run(args, opts));
    return statusProject(argv, { stdout, stderr });
  }
  const given = ['--json', '--offline'].filter((flag) => flags[flag.slice(2)]);
  if (given.length) { stderr.write(`mc: ${name} is a draft — it has no ${given[0]}\n`); return 2; }

  let plan;
  try {
    plan = readDraftOrPlan(found.file);
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  for (const line of draftLines(name, found, plan)) stdout.write(`${line}\n`);
  return 0;
}

/** The lines `mc project <name>` prints for a draft: what it is, its criteria and steps, and whether `send` would take it. */
function draftLines(name, found, plan) {
  const lines = [`${name} — draft · ${plan.repo} · ${found.programme}`, `  file   ${found.file}`, ''];
  const goal = Array.isArray(plan.goal) ? plan.goal[0] : undefined;
  if (goal) lines.push(goal, '');

  lines.push('CRITERIA');
  const criteria = Array.isArray(plan.success_criteria) ? plan.success_criteria : [];
  if (criteria.length === 0) lines.push('  none yet');
  criteria.forEach((criterion, index) => lines.push(`  ${index + 1}  ${criterion?.criterion}`));
  lines.push('', 'STEPS');
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length === 0) lines.push('  none yet');
  steps.forEach((step, index) => {
    const runner = [step?.runner?.model, step?.runner?.effort].filter(Boolean).join(' ');
    lines.push(`  ${index + 1}  ${step?.title}  ${runner}`.trimEnd());
    if (step?.status === 'blocked') lines.push(`  waits for ${step.blocked_by?.name}`);
  });

  lines.push('');
  const problems = sendProblems(plan);
  if (problems.length === 0) {
    lines.push(`send: mc project send ${name}`);
  } else {
    lines.push('send would refuse:');
    for (const problem of problems) lines.push(`  ${problem}`);
  }
  return lines;
}

/**
 * `mc project new <programme>/<project>` — writes a draft plan, `DRAFT.json`,
 * beside where `PLAN.json` will be. The name must be free: no draft or plan of
 * that project under the programmes home, and no repository's plan or closeout
 * of that name on origin/main. Nothing is fetched to decide it.
 */
function newPlan(scanned, deps) {
  const { env, stdout, stderr } = deps;
  const home = deps.home || programsHome(env);
  const repos = deps.repos || defaultRepos(env);
  const records = deps.listPlans || listPlans;
  const archived = deps.listArchived || listArchived;
  const { flags } = scanned;

  const target = scanned.positional.slice(1);
  if (target.length !== 1) { stderr.write(usage()); return 2; }
  const parts = target[0].split('/');
  if (parts.length !== 2 || !NAME_RE.test(parts[0]) || !NAME_RE.test(parts[1])) {
    stderr.write(`mc: ${target[0]} is not <programme>/<project> — lower-case letters, digits and hyphens\n`);
    return 2;
  }
  const [programme, project] = parts;

  const given = {
    '--repo': flags.repo !== null,
    '--goal': flags.goal !== null,
    '--contract': flags.contract.length > 0,
    '--out-of-scope': flags['out-of-scope'].length > 0,
  };
  const absent = Object.keys(given).filter((flag) => !given[flag]);
  if (absent.length) { stderr.write(`mc: new needs ${absent.join(', ')}\n`); return 2; }
  const repoNames = repos.map((repo) => repo.name);
  if (!repoNames.includes(flags.repo)) {
    stderr.write(`mc: ${flags.repo} is not a repository mc knows — ${repoNames.join(', ')}\n`);
    return 2;
  }
  // A project named like a repository would take that repository's worktree
  // name in the programme's directory (ruling 51), so it is refused here.
  if (repoNames.includes(project)) {
    stderr.write(`mc: ${project} is the name of a repository — the programme's worktree of it stands at ~/mc/programs/${programme}/${project}; choose another name\n`);
    return 2;
  }

  const found = findProjectDir(home, project);
  if (found) { stderr.write(`mc: ${project} exists — ${found.file}\n`); return 1; }
  for (const repo of repos) {
    if (records(repo).some((record) => record.project === project) || archived(repo).includes(project)) {
      stderr.write(`mc: ${project} is a project of ${repo.name} already\n`);
      return 1;
    }
  }

  const plan = {
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    repo: flags.repo,
    goal: [flags.goal],
    contract: flags.contract,
    out_of_scope: flags['out-of-scope'],
    success_criteria: [],
    documents: [],
    steps: [],
  };
  const issues = draftProblems(plan);
  if (issues.length) {
    for (const issue of issues) stderr.write(`mc: ${issue}\n`);
    return 1;
  }
  const dir = join(home, programme, project);
  const file = join(dir, DRAFT_FILE);
  try {
    withPlanLock(dir, () => writePlanFile(file, plan));
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  stdout.write(`mc: ${programme}/${project} drafted — ${file}\n`);
  stdout.write(`next: mc project criterion add ${project} "…" --check "<command>"\n`);
  return 0;
}

/**
 * `mc project edit <project>` — changes a draft's goal, contract or out of scope:
 * each flag given replaces that field whole. A sent plan (`PLAN.json`) has those
 * three frozen, so it is refused here, as is a project mc does not hold.
 */
function editPlan(scanned, deps) {
  const { env, stdout, stderr } = deps;
  const home = deps.home || programsHome(env);
  const { flags } = scanned;

  const target = scanned.positional.slice(1);
  if (target.length !== 1) { stderr.write(usage()); return 2; }
  const [project] = target;
  const changed = [];
  if (flags.goal !== null) changed.push('goal');
  if (flags.contract.length > 0) changed.push('contract');
  if (flags['out-of-scope'].length > 0) changed.push('out_of_scope');
  if (changed.length === 0) { stderr.write('mc: edit needs --goal, --contract or --out-of-scope\n'); return 2; }

  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: no project ${project} under ${home}\n`); return 1; }
  if (found.sent) { stderr.write(`mc: ${project} is sent — its goal, contract and out of scope are frozen\n`); return 1; }

  let problems;
  try {
    problems = withPlanLock(found.dir, () => {
      const plan = readDraftOrPlan(found.file);
      if (flags.goal !== null) plan.goal = [flags.goal];
      if (flags.contract.length > 0) plan.contract = flags.contract;
      if (flags['out-of-scope'].length > 0) plan.out_of_scope = flags['out-of-scope'];
      const issues = draftProblems(plan);
      if (issues.length === 0) writePlanFile(found.file, plan);
      return issues;
    });
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  if (problems.length) {
    for (const problem of problems) stderr.write(`mc: ${problem}\n`);
    return 1;
  }
  stdout.write(`mc: ${project} — ${changed.join(', ')}\n`);
  return 0;
}

/**
 * `mc project criterion add <project> <text> --check <command>` — appends a
 * success criterion, unmet, to a draft or to a sent plan. Its check is a command
 * the last step runs, so a check that names a person is refused here, as is a
 * dependency written in prose and a criterion whose text is already there. A
 * draft's first criterion says which verb comes next.
 */
function addCriterion(scanned, deps) {
  const { env, stdout, stderr } = deps;
  const home = deps.home || programsHome(env);
  const { flags } = scanned;

  const target = scanned.positional.slice(2);
  if (target.length !== 2) { stderr.write(usage()); return 2; }
  const [project, text] = target;
  const check = flags.check;
  if (check === null || check.trim() === '') {
    stderr.write('mc: a criterion needs --check "<command>" — the command that shows it holds\n');
    return 2;
  }
  const names = bannedWords(check);
  if (names.length) {
    stderr.write(`mc: the check names ${names.join(', ')} — a check is a command the last step runs, never a person\n`);
    return 1;
  }
  const says = checkWords(check);
  if (says.length) {
    stderr.write(`mc: the check says ${says.join(', ')} — a check runs from the step's own branch, before the merge; a wait for a deploy is mc step blocked --after-deploy\n`);
    return 1;
  }
  const named = bannedWords(text);
  if (named.length) {
    stderr.write(`mc: the criterion names ${named.join(', ')} — a criterion is measured by its check, never by a person\n`);
    return 1;
  }
  if (dependencyWords(text).length || dependencyWords(check).length) {
    stderr.write('mc: a dependency goes in mc project step add … --after <repo>:<project>\n');
    return 1;
  }
  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: no project ${project} under ${home}\n`); return 1; }

  let outcome;
  try {
    outcome = withPlanLock(found.dir, () => {
      const plan = readDraftOrPlan(found.file);
      const criteria = plan.success_criteria;
      if (!Array.isArray(criteria)) return { problems: ['success_criteria: a list of criteria'] };
      const same = criteria.findIndex((criterion) => criterion?.criterion === text);
      if (same !== -1) return { refused: `${project} has that criterion already (${same + 1})` };
      plan.success_criteria = [...criteria, { met: false, criterion: text, check }];
      const problems = found.sent ? validatePlan(plan).problems : draftProblems(plan);
      if (problems.length) return { problems };
      writePlanFile(found.file, plan);
      return { number: criteria.length + 1, first: !found.sent && criteria.length === 0 };
    });
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  if (outcome.refused) { stderr.write(`mc: ${outcome.refused}\n`); return 1; }
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${problem}\n`);
    return 1;
  }
  stdout.write(`mc: ${project} criterion ${outcome.number} — ${text}\n`);
  if (outcome.first) stdout.write(`next: mc project step add ${project} "<title>" --model haiku|opus --done-when "…" --instruction-file <md>\n`);
  return 0;
}

/**
 * `mc project criterion edit <project> <n> --check <command>` — changes the check
 * of success criterion `n` (1-based), of a draft or a sent plan, and nothing else:
 * its text is how the register matches it, so it stays. The new check is refused
 * as `criterion add` refuses one. A criterion the register holds as met goes back
 * to not met, since nobody has measured it by the new check.
 */
function editCriterion(scanned, deps) {
  const { env, stdout, stderr, root, now, io } = deps;
  const home = deps.home || programsHome(env);
  const { flags } = scanned;

  const target = scanned.positional.slice(2);
  if (target.length !== 2) { stderr.write(usage()); return 2; }
  const [project, number] = target;
  const check = flags.check;
  if (check === null || check.trim() === '') {
    stderr.write('mc: criterion edit needs --check "<command>" — the command that shows it holds\n');
    return 2;
  }
  if (!/^\d+$/u.test(number) || Number(number) < 1) { stderr.write(`mc: ${number} is not a criterion number — 1 is the plan's first\n`); return 2; }
  const n = Number(number);
  const names = bannedWords(check);
  if (names.length) {
    stderr.write(`mc: the check names ${names.join(', ')} — a check is a command the last step runs, never a person\n`);
    return 1;
  }
  const says = checkWords(check);
  if (says.length) {
    stderr.write(`mc: the check says ${says.join(', ')} — a check runs from the step's own branch, before the merge; a wait for a deploy is mc step blocked --after-deploy\n`);
    return 1;
  }
  if (dependencyWords(check).length) {
    stderr.write('mc: a dependency goes in mc project step add … --after <repo>:<project>\n');
    return 1;
  }
  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: no project ${project} under ${home}\n`); return 1; }

  let outcome;
  try {
    outcome = withPlanLock(found.dir, () => {
      const plan = readDraftOrPlan(found.file);
      const criteria = plan.success_criteria;
      if (!Array.isArray(criteria)) return { problems: ['success_criteria: a list of criteria'] };
      if (n > criteria.length) return { outOfRange: `${project} has ${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'} — criterion ${n} is not one` };
      if (criteria[n - 1].check === check) return { refused: `criterion ${n} of ${project} has that check already` };
      plan.success_criteria = criteria.map((criterion, i) => (i === n - 1 ? { ...criterion, check } : criterion));
      const problems = found.sent ? validatePlan(plan).problems : draftProblems(plan);
      if (problems.length) return { problems };
      writePlanFile(found.file, plan);
      return { text: criteria[n - 1].criterion };
    });
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  if (outcome.outOfRange) { stderr.write(`mc: ${outcome.outOfRange}\n`); return 2; }
  if (outcome.refused) { stderr.write(`mc: ${outcome.refused}\n`); return 1; }
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${problem}\n`);
    return 1;
  }
  stdout.write(`mc: ${project} criterion ${n} — check changed\n`);
  const held = found.sent ? (readEntry(root, project, io)?.criteria ?? []).findIndex((c) => c.criterion === outcome.text && c.met) : -1;
  if (held !== -1) {
    try {
      updateCriterion({ root, project, number: held + 1, met: false, now, ...io });
      stdout.write(`mc: ${project} criterion ${n} — not met, until its new check is run\n`);
    } catch (error) {
      stderr.write(`mc: ${error?.message || error}\n`);
      return 1;
    }
  }
  return 0;
}

/**
 * `mc project criterion drop <project> <n> --reason "…"` — removes success
 * criterion `n` (1-based) from a draft or a sent plan, and the register's held
 * criterion of the same text when there is one, with the reason in the
 * register's log. For a criterion nobody can measure: a check that waits for a
 * deploy, names a person, or is not a step's to run. A plan keeps at least one
 * criterion, so the last one is edited, not dropped.
 */
function dropCriterion(scanned, deps) {
  const { env, stdout, stderr, root, now, io } = deps;
  const home = deps.home || programsHome(env);
  const { flags } = scanned;

  const target = scanned.positional.slice(2);
  if (target.length !== 2) { stderr.write(usage()); return 2; }
  const [project, number] = target;
  const reason = flags.reason;
  if (!reason?.trim()) {
    stderr.write('mc: criterion drop needs --reason "…" — why the criterion is not a step\'s to measure\n');
    return 2;
  }
  if (!/^\d+$/u.test(number) || Number(number) < 1) { stderr.write(`mc: ${number} is not a criterion number — 1 is the plan's first\n`); return 2; }
  const n = Number(number);
  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: no project ${project} under ${home}\n`); return 1; }

  let outcome;
  try {
    outcome = withPlanLock(found.dir, () => {
      const plan = readDraftOrPlan(found.file);
      const criteria = plan.success_criteria;
      if (!Array.isArray(criteria)) return { problems: ['success_criteria: a list of criteria'] };
      if (n > criteria.length) return { outOfRange: `${project} has ${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'} — criterion ${n} is not one` };
      if (criteria.length === 1) return { refused: 'a plan keeps at least one criterion — edit it instead' };
      const text = criteria[n - 1].criterion;
      plan.success_criteria = criteria.filter((_, i) => i !== n - 1);
      const problems = found.sent ? validatePlan(plan).problems : draftProblems(plan);
      if (problems.length) return { problems };
      writePlanFile(found.file, plan);
      return { text, count: criteria.length };
    });
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  if (outcome.outOfRange) { stderr.write(`mc: ${outcome.outOfRange}\n`); return 2; }
  if (outcome.refused) { stderr.write(`mc: ${outcome.refused}\n`); return 1; }
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${problem}\n`);
    return 1;
  }
  // A project the register does not hold has nothing to drop; that is not a failure.
  if (found.sent && readEntry(root, project, io)) {
    try {
      dropRegisterCriterion({ root, project, text: outcome.text, reason, now, ...io });
    } catch (error) {
      stderr.write(`mc: ${error?.message || error}\n`);
      return 1;
    }
  }
  stdout.write(`mc: ${project} criterion ${n} dropped — ${outcome.text}\n`);
  if (n < outcome.count) {
    const last = outcome.count - 1;
    stdout.write(n + 1 === outcome.count ? `mc: criterion ${outcome.count} is now ${n}\n` : `mc: criteria ${n + 1}–${outcome.count} are now ${n}–${last}\n`);
  }
  return 0;
}

/**
 * `mc project step add <project> <title> --model haiku|opus --done-when <text>
 * --instruction-file <md> [--effort <level>] [--after <repo>:<project>]` —
 * appends a step, after the others, to a draft or a sent plan. The model is the
 * step's own (ruling 42), and `done_when` ends on a check, never on a person.
 * The instruction is the markdown file's paragraphs. `--after` makes the step
 * wait, `blocked` on that project, which `blockerDue` releases once it is done
 * or archived; the project is looked up over every project mc knows.
 */
function addStep(scanned, deps) {
  const { env, stdout, stderr } = deps;
  const home = deps.home || programsHome(env);
  const repos = deps.repos || defaultRepos(env);
  const programs = deps.programs || (() => programsPlans({ home }));
  const records = deps.listPlans || listPlans;
  const archived = deps.listArchived || listArchived;
  const { flags } = scanned;

  const target = scanned.positional.slice(2);
  if (target.length !== 2) { stderr.write(usage()); return 2; }
  const [project, title] = target;
  const { model, effort, after } = flags;
  const modelIssue = modelProblem(model) ?? effortProblem(effort);
  if (modelIssue) { stderr.write(`mc: ${modelIssue}\n`); return 2; }
  const doneWhen = flags['done-when'];
  const doneWhenIssue = doneWhenProblem(doneWhen);
  if (doneWhenIssue) { stderr.write(`mc: ${doneWhenIssue.message}\n`); return doneWhenIssue.code; }
  const path = flags['instruction-file'];
  if (path === null) { stderr.write('mc: a step needs --instruction-file <md> — its instruction\n'); return 2; }
  const paragraphs = instructionOfFile(path);
  if (paragraphs === null) { stderr.write(`mc: cannot read ${path}\n`); return 2; }

  let waits = null;
  if (after !== null) {
    const [, repoName, name] = after.match(/^([^:]+):([^:]+)$/u) ?? [];
    if (!repoName) { stderr.write(`mc: --after is <repo>:<project> — ${after} is not\n`); return 2; }
    if (!repos.some((repo) => repo.name === repoName)) {
      stderr.write(`mc: ${repoName} is not a repository mc knows — ${repos.map((repo) => repo.name).join(', ')}\n`);
      return 2;
    }
    if (!NAME_RE.test(name)) { stderr.write(`mc: ${name} is not a project name — lower-case letters, digits and hyphens\n`); return 2; }
    waits = { repo: repos.find((repo) => repo.name === repoName), name };
  }

  const paragraphsIssue = paragraphsProblem(paragraphs, path);
  if (paragraphsIssue) { stderr.write(`mc: ${paragraphsIssue}\n`); return 1; }

  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: no project ${project} under ${home}\n`); return 1; }
  if (waits) {
    if (waits.name === project) { stderr.write(`mc: ${project} cannot wait on itself\n`); return 1; }
    if (!knownProject(waits.repo, waits.name, { home, programs, records, archived })) {
      stderr.write(`mc: ${after} is not a project mc knows — not under ~/mc/programs/, not on ${waits.repo.name}'s origin/main, not archived\n`);
      return 1;
    }
  }

  let outcome;
  try {
    outcome = withPlanLock(found.dir, () => {
      const plan = readDraftOrPlan(found.file);
      const steps = plan.steps;
      if (!Array.isArray(steps)) return { problems: ['steps: a list of steps'] };
      const key = stepKey({ title });
      const same = steps.findIndex((step) => stepKey(step) === key);
      if (same !== -1) return { refused: `step ${same + 1} is called that already` };
      const step = {
        title,
        status: waits ? 'blocked' : 'ready',
        done_when: doneWhen,
        instruction: paragraphs,
        runner: { model, ...(effort ? { effort } : {}) },
      };
      if (waits) step.blocked_by = { kind: 'project', name: waits.name };
      plan.steps = [...steps, step];
      const problems = found.sent ? validatePlan(plan).problems : draftProblems(plan);
      if (problems.length) return { problems };
      writePlanFile(found.file, plan);
      const criteria = Array.isArray(plan.success_criteria) ? plan.success_criteria.length : 0;
      return { number: plan.steps.length, sendable: !found.sent && criteria > 0 };
    });
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  if (outcome.refused) { stderr.write(`mc: ${outcome.refused}\n`); return 1; }
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${problem}\n`);
    return 1;
  }
  stdout.write(`mc: ${project} step ${outcome.number} — ${title} (${model}${effort ? `, ${effort}` : ''})\n`);
  if (waits) stdout.write(`  waits for ${after}\n`);
  if (outcome.sendable) stdout.write(`next: mc project send ${project}\n`);
  return 0;
}

/**
 * `mc project step edit <project> <n> [--title …] [--model …] [--effort …]
 * [--done-when …] [--instruction-file <md>]` — changes the fields given, and only
 * those, of step `n` (1-based). Each is checked as `step add` checks it. A draft's
 * steps are all editable. A sent plan's step is frozen once it has started (the
 * register holds it at a status other than `ready`, or with a pull request), and
 * a project mc does not hold is exit 1. Changing a ready step's title is a rename
 * the register already follows: `reconcileEntry` carries its state by position.
 */
function editStep(scanned, deps) {
  const { env, stdout, stderr, root, io } = deps;
  const home = deps.home || programsHome(env);
  const { flags } = scanned;

  const target = scanned.positional.slice(2);
  if (target.length !== 2) { stderr.write(usage()); return 2; }
  const [project, number] = target;
  const { title, model, effort } = flags;
  const doneWhen = flags['done-when'];
  const path = flags['instruction-file'];
  const given = { title: title !== null, model: model !== null, effort: effort !== null, done_when: doneWhen !== null, instruction: path !== null };
  const changed = Object.keys(given).filter((field) => given[field]);
  if (changed.length === 0) { stderr.write('mc: step edit needs --title, --model, --effort, --done-when or --instruction-file\n'); return 2; }
  if (!/^\d+$/u.test(number) || Number(number) < 1) { stderr.write(`mc: ${number} is not a step number — 1 is the plan's first\n`); return 2; }
  const n = Number(number);

  const issue = (model !== null ? modelProblem(model) : null) ?? effortProblem(effort);
  if (issue) { stderr.write(`mc: ${issue}\n`); return 2; }
  const doneWhenIssue = doneWhen !== null ? doneWhenProblem(doneWhen) : null;
  if (doneWhenIssue) { stderr.write(`mc: ${doneWhenIssue.message}\n`); return doneWhenIssue.code; }
  let paragraphs = null;
  if (path !== null) {
    paragraphs = instructionOfFile(path);
    if (paragraphs === null) { stderr.write(`mc: cannot read ${path}\n`); return 2; }
    const paragraphsIssue = paragraphsProblem(paragraphs, path);
    if (paragraphsIssue) { stderr.write(`mc: ${paragraphsIssue}\n`); return 1; }
  }

  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: no project ${project} under ${home}\n`); return 1; }

  let outcome;
  try {
    outcome = withPlanLock(found.dir, () => {
      const plan = readDraftOrPlan(found.file);
      const steps = plan.steps;
      if (!Array.isArray(steps)) return { problems: ['steps: a list of steps'] };
      if (n > steps.length) return { outOfRange: `${project} has ${steps.length} step${steps.length === 1 ? '' : 's'} — step ${n} is not one` };
      if (found.sent) {
        const started = startedAs(readEntry(root, project, io), n);
        if (started) return { frozen: `step ${n} of ${project} is ${started} — a step that has started is frozen` };
      }
      const index = n - 1;
      if (title !== null) {
        const key = stepKey({ title });
        const same = steps.findIndex((other, i) => i !== index && stepKey(other) === key);
        if (same !== -1) return { refused: `step ${same + 1} is called that already` };
      }
      const step = steps[index];
      const edited = { ...step };
      if (title !== null) edited.title = title;
      if (doneWhen !== null) edited.done_when = doneWhen;
      if (paragraphs !== null) edited.instruction = paragraphs;
      if (model !== null || effort !== null) {
        edited.runner = { ...step.runner, ...(model !== null ? { model } : {}), ...(effort !== null ? { effort } : {}) };
      }
      plan.steps = steps.map((other, i) => (i === index ? edited : other));
      const problems = found.sent ? validatePlan(plan).problems : draftProblems(plan);
      if (problems.length) return { problems };
      writePlanFile(found.file, plan);
      return {};
    });
  } catch (error) {
    stderr.write(`mc: ${error?.message || error}\n`);
    return 1;
  }
  if (outcome.outOfRange) { stderr.write(`mc: ${outcome.outOfRange}\n`); return 2; }
  const refusal = outcome.frozen ?? outcome.refused;
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 1; }
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${problem}\n`);
    return 1;
  }
  stdout.write(`mc: ${project} step ${n} — ${changed.join(', ')}\n`);
  return 0;
}

/** What is wrong with a step's model, or null: a step names haiku or opus (ruling 42), so `step add` and `step edit` refuse any other. */
function modelProblem(model) {
  return MODELS.includes(model) ? null : 'a step names --model haiku or opus (ruling 42) — no default';
}

/** What is wrong with a step's effort, or null: none is fine, and otherwise it is one of `EFFORT_LEVELS`. */
function effortProblem(effort) {
  return effort === null || EFFORT_LEVELS.includes(effort) ? null : `--effort ${effort} is not one of ${EFFORT_LEVELS.join(', ')}`;
}

/**
 * What is wrong with a step's `done-when`, as `{ code, message }`, or null. Blank
 * is missing (exit 2); a person named, or a dependency written in it, is exit 1,
 * since a step ends on a check and waits on `--after`.
 */
function doneWhenProblem(doneWhen) {
  if (doneWhen === null || doneWhen.trim() === '') return { code: 2, message: 'a step needs --done-when "<check>" — when it is finished' };
  const names = bannedWords(doneWhen);
  if (names.length) return { code: 1, message: `--done-when names ${names.join(', ')} — a step ends on a check, never on a person` };
  if (dependencyWords(doneWhen).length) return { code: 1, message: 'a dependency goes in --after <repo>:<project>' };
  return null;
}

/** What is wrong with a step's instruction paragraphs, or null: a dependency in prose, or none at all. */
function paragraphsProblem(paragraphs, path) {
  if (paragraphs.some((paragraph) => dependencyWords(paragraph).length)) return 'a dependency goes in --after <repo>:<project>';
  if (paragraphs.length === 0) return `${path} has no paragraph`;
  return null;
}

/** The paragraphs of the markdown instruction file at `path`, or null when it cannot be read. */
function instructionOfFile(path) {
  try {
    return instructionParagraphs(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * How step `n` has started, as the register holds it, or null while it has not:
 * a step has started once its status is anything but `ready`, or it has a pull
 * request. No entry in the register is no step started.
 */
function startedAs(entry, n) {
  const state = entry?.steps?.[n - 1];
  if (!state || (state.status === 'ready' && !state.pr)) return null;
  return state.pr ? `${state.status} (PR #${state.pr})` : state.status;
}

/**
 * Whether mc knows `name` as a project of `repo`, in any place a project is: a
 * plan under `~/mc/programs/` that names `repo`, a draft that names it, a plan
 * on the repository's origin/main, or its closeout there. Archived projects
 * count — a step may wait on one that has already landed.
 */
function knownProject(repo, name, { home, programs, records, archived }) {
  if (programs().some((plan) => plan.project === name && plan.repo === repo.name)) return true;
  const draft = findProjectDir(home, name);
  if (draft && !draft.sent && draftRepo(draft.file) === repo.name) return true;
  if (records(repo).some((record) => record.project === name)) return true;
  return archived(repo).includes(name);
}

/** The repository a draft names, or null when it names none or is not JSON. */
function draftRepo(file) {
  try {
    return readDraftOrPlan(file).repo ?? null;
  } catch {
    return null;
  }
}

/**
 * The first flag `scanned` was given that `allowed` does not name, with its
 * dashes, or null when every flag given is allowed. A repeatable flag counts as
 * given when its array is not empty.
 */
function onlyFlags(scanned, allowed) {
  for (const [key, value] of Object.entries(scanned.flags)) {
    const given = Array.isArray(value) ? value.length > 0 : value !== null && value !== false;
    if (given && !allowed.includes(`--${key}`)) return `--${key}`;
  }
  return null;
}

/** Writes a file whole: its directory is made, and the text lands under its name in one rename. */
function writeTextFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * `mc project archive <project>` — archives one done project now, without the
 * runner's day of waiting (ruling 48). It takes a sent plan the register says is
 * done and that is not archived yet; the row and the closeout are the ones the
 * runner writes, through `archivePrograms`. Then the project's step area is
 * closed, unless a checkout in it has an uncommitted change or its tmux session
 * is live: the area stays, and the line says why. The archive stands either way.
 */
async function archiveProject(scanned, deps) {
  const { env, stdout, stderr, root } = deps;
  const home = deps.home || programsHome(env);
  const repos = deps.repos || defaultRepos(env);
  const git = deps.git || gitIn;
  const tmuxHas = deps.tmuxHas || hasTmuxSession;
  const target = scanned.positional.slice(1);
  if (target.length !== 1) { stderr.write(usage()); return 2; }
  const [project] = target;

  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: ${project} is not a project under ~/mc/programs/\n`); return 1; }
  if (!found.sent) { stderr.write(`mc: ${project} is a draft — mc project discard ${project} removes it\n`); return 1; }
  if (existsSync(closeoutFileOf(found.file))) { stderr.write(`mc: ${project} is already archived\n`); return 1; }

  const { plan, problems } = readPlanText(readFileOrNull(found.file) ?? '');
  if (!plan) { stderr.write(`mc: ${project} does not read: ${problems[0]}\n`); return 1; }
  const entry = readEntry(root, project, { read: deps.read });
  const status = entry ? applyEntry({ plan, path: found.file }, entry).status : null;
  if (status !== 'done') {
    stderr.write(`mc: ${project} is ${status || 'not in the register'} — only a done project is archived; mc project discard ${project} removes it\n`);
    return 1;
  }
  const repo = repos.find((candidate) => candidate.name === plan.repo);
  if (!repo) { stderr.write(`mc: ${project} names ${plan.repo || 'no repository'}, which is not one of the repositories mc knows\n`); return 1; }

  const log = join(runnerDir(env), 'log');
  const say = (line) => stdout.write(`${line}\n`);
  const result = await archivePrograms({
    repo,
    items: [{ record: { path: found.file, programme: found.programme, project, repo: repo.name, status: 'done' }, entry }],
    root,
    paths: { runs: join(log, 'runs.tsv'), log, undocumented: runnerTablePath(UNDOCUMENTED_CLOSURES, env) },
    deps: {
      git, gh: deps.gh || ghIn, read: deps.read || readFileOrNull, write: deps.write || writeTextFile,
      exists: deps.exists || existsSync, append: deps.append || appendText, list: deps.list || listEntries,
      readBytes: deps.readBytes || readBytesOrNull,
    },
    docsMerge: deps.docsMerge || runDocsMerge,
    now: () => (deps.now ? deps.now() : new Date()),
    say,
  });
  if (result.held.length) { stderr.write(`mc: ${project} held — ${result.held[0].why}\n`); return 1; }

  const area = join(workRoot(env), stepAreaName(project, { root: workRoot(env) }));
  if (!existsSync(area)) { stdout.write(`mc: ${project} archived\n`); return 0; }
  const checkouts = repos.filter((candidate) => existsSync(join(area, candidate.name, '.git')));
  const verdict = closable({
    plan: { status: 'done' }, archived: true, legacy: false,
    dirty: checkouts.some((candidate) => {
      const status = git(join(area, candidate.name), ['status', '--porcelain']);
      return !status.ok || status.stdout.trim() !== '';
    }),
    live: tmuxHas(`mc-${project}`),
    stepsDone: Array.isArray(entry.steps) && entry.steps.every((step) => step.status === 'done'),
  });
  if (!verdict.close) { stdout.write(`mc: ${project} archived; its step area stays — ${verdict.why}\n`); return 0; }
  stdout.write(`mc: ${project} archived\n`);
  closeArea({
    name: project, area, repos, closedDir: join(log, 'closed'), git, list: listEntries, move: moveEntry,
    rmdir: removeEmptyDir, exists: existsSync, stopServers: deps.stopServers || stopServersUnder, say,
  });
  return 0;
}

/** A file's text, or null when it cannot be read. */
function readFileOrNull(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** A file's bytes, or null when it cannot be read: a gzipped session result. */
function readBytesOrNull(path) {
  try { return readFileSync(path); } catch { return null; }
}

/** `git -C <cwd> <args>`, as `{ ok, stdout, stderr }`. */
function gitIn(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** `gh <args>` in `cwd`, as `{ ok, stdout, stderr }`. */
function ghIn(cwd, args) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Whether a tmux session of this name is running. */
function hasTmuxSession(name) {
  return spawnSync('tmux', ['has-session', '-t', name]).status === 0;
}

/** The names in a directory; none when it cannot be read. */
function listEntries(path) {
  try { return readdirSync(path); } catch { return []; }
}

/** Appends to a file, its directory made first. */
function appendText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text);
}

/** Moves a file or folder; false when it cannot, so the caller keeps its folder. */
function moveEntry(from, to) {
  try { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); return true; } catch { return false; }
}

/** Removes a folder only when it is empty; false when it is not, or cannot be. */
function removeEmptyDir(path) {
  try { rmdirSync(path); return true; } catch { return false; }
}

/**
 * `mc project discard <project> [--apply]` — takes a project out whole (ruling 48:
 * "Om man tar bort ett projekt så är väl hela tanken att hela projektet ska bort"):
 * its open pull requests are closed with their branches, its step area is
 * discarded, its register file goes, and last its directory. A draft never ran
 * a step, so only its directory goes. An archived project is not discarded:
 * archive is the way out it took. Without `apply` it says what would go and
 * removes nothing. With it, every refusal is checked before anything is removed:
 * a step running or landing, a live session, a worktree in use, pull requests
 * that cannot be listed. A plan whose step waits on this project is noted, not refused.
 */
function discardProject(scanned, deps) {
  const { env, stdout, stderr, root } = deps;
  const home = deps.home || programsHome(env);
  const repos = deps.repos || defaultRepos(env);
  const programs = deps.programs || (() => programsPlans({ home }));
  const gh = deps.gh || ghIn;
  const discardArea = deps.discardArea || discardWorkArea;
  const rm = deps.rm || rmSync;
  const tmuxHas = deps.tmuxHas || hasTmuxSession;
  const apply = Boolean(scanned.flags.apply);

  const target = scanned.positional.slice(1);
  if (target.length !== 1) { stderr.write(usage()); return 2; }
  const [project] = target;
  const found = findProjectDir(home, project);
  if (!found) { stderr.write(`mc: ${project} is not a project under ~/mc/programs/\n`); return 1; }
  if (existsSync(closeoutFileOf(found.file))) { stderr.write(`mc: ${project} is archived — archive is the way out it took\n`); return 1; }

  // A draft never ran a step, so its directory is all there is to it.
  const repo = found.sent ? repos.find((candidate) => candidate.name === draftRepo(found.file)) : undefined;
  const pulls = repo ? projectPulls(repo, project, gh) : { list: [] };
  if (pulls.error) {
    stderr.write(`mc: could not list ${repo.name}'s open pull requests — ${pulls.error}\n`);
    if (apply) return 1;
  }
  const areaName = found.sent ? stepAreaName(project, { root }) : null;
  const area = areaName && existsSync(join(root, areaName)) ? discardArea(areaName, { env, dryRun: true }) : null;
  // In layout 2 the register is the project directory's STATE.json, removed with it.
  const register = layoutVersion({ root }) === 2 ? null : registerPath(root, project);
  const hasRegister = Boolean(register) && found.sent && existsSync(register);
  const waiting = waitingOn(project, programs());

  if (apply && found.sent) {
    const busy = readEntry(root, project, { read: deps.read })?.steps?.map((step, index) => ({ step, n: index + 1 }))
      .find(({ step }) => step.status === 'running' || step.status === 'landing');
    if (busy) { stderr.write(`mc: ${project} step ${busy.n} is ${busy.step.status} — wait for it, or mc step failed it first\n`); return 1; }
    if (tmuxHas(`mc-${project}`)) { stderr.write(`mc: ${project} has a live session mc-${project} — stop it first\n`); return 1; }
    if (area?.kept.length) {
      stderr.write(`mc: ${project} has a worktree in use — ${area.kept.map((item) => `${item.path} (${item.why})`).join(', ')}\n`);
      return 1;
    }
  }

  const removing = apply ? 'removed' : 'would remove';
  const say = (line) => stdout.write(`  ${line}\n`);
  for (const pull of pulls.list) {
    const label = `pull request #${pull.number} (branch ${pull.headRefName})`;
    if (!apply) { say(`would remove ${label}`); continue; }
    const closed = gh(repo.path, ['pr', 'close', String(pull.number), '--delete-branch', '--comment', 'Discarded with mc project discard.']);
    if (closed.ok) say(`removed ${label}`);
    else stderr.write(`mc: could not close pull request #${pull.number} — ${closed.stderr.trim()}\n`);
  }
  if (area) {
    const done = apply ? discardArea(areaName, { env, dryRun: false }) : area;
    for (const item of done.discarded) say(`${removing} ${item.path}${item.branch ? ` (branch ${item.branch})` : ''}`);
    for (const item of done.kept) say(`kept ${item.path} — ${item.why}`);
    if (done.removes_area) say(`${removing} ${join(root, areaName)}`);
  }
  if (hasRegister) {
    if (apply) rm(register, { force: true });
    say(`${removing} ${register}`);
  }
  if (apply) rm(found.dir, { recursive: true, force: true });
  say(`${removing} ${found.dir}`);
  for (const { other, n } of waiting) stdout.write(`  note: ${other} step ${n} waits on ${project} and will wait for ever\n`);
  if (apply) { stdout.write(`mc: ${project} discarded\n`); return 0; }
  stdout.write(`mc project discard ${project} --apply to remove them\n`);
  return 0;
}

/**
 * The open pull requests of `project` in `repo`, as `{ list }`: those whose head
 * branch is `<project>` or `<project>-<n>`, the branches mc names for its steps.
 * `{ error, list: [] }` when gh cannot list them.
 */
function projectPulls(repo, project, gh) {
  const listed = gh(repo.path, ['pr', 'list', '--state', 'open', '--json', 'number,headRefName']);
  if (!listed.ok) return { error: listed.stderr.trim() || 'gh pr list failed', list: [] };
  let pulls;
  try { pulls = JSON.parse(listed.stdout || '[]'); } catch { return { error: 'gh pr list printed no JSON', list: [] }; }
  const list = pulls.filter((pull) => {
    const branch = String(pull.headRefName);
    return branch === project || (branch.startsWith(`${project}-`) && /^\d+$/u.test(branch.slice(project.length + 1)));
  });
  return { list };
}

/**
 * The steps of the other plans under `~/mc/programs/` that wait on `project`, as
 * `{ other, n }` in listing order, `n` the step's number. A step waits on a
 * project when its `blocked_by` is that project, as `blockerDue` reads it.
 */
function waitingOn(project, records) {
  const waiting = [];
  for (const record of records) {
    if (record.project === project) continue;
    let steps;
    try { steps = JSON.parse(record.text)?.steps; } catch { continue; }
    if (!Array.isArray(steps)) continue;
    steps.forEach((step, index) => {
      if (step?.blocked_by?.kind === 'project' && step.blocked_by.name === project) waiting.push({ other: record.project, n: index + 1 });
    });
  }
  return waiting;
}

export function usage() {
  return [
    'usage — mc project new <programme>/<project> --repo <repo> --goal <text> --contract <text>... --out-of-scope <text>...   draft a plan, as DRAFT.json\n',
    '        mc project edit <project> [--goal <text>] [--contract <text>...] [--out-of-scope <text>...]                     change a draft\'s goal, contract or out of scope\n',
    '        mc project criterion add <project> <text> --check <command>   add a success criterion, to a draft or a sent plan\n',
    '        mc project criterion edit <project> <n> --check <command>     change success criterion <n>\'s check, and record it not met\n',
    '        mc project step add <project> <title> --model haiku|opus --done-when <text> --instruction-file <md> [--effort <level>] [--after <repo>:<project>]   add a step, after the others\n',
    '        mc project step edit <project> <n> [--title <text>] [--model haiku|opus] [--effort <level>] [--done-when <text>] [--instruction-file <md>]   change the named fields of a step, of a draft or of a sent plan that has not started\n',
    '        mc project send <project>                    check a draft whole and rename it to PLAN.json: the handover to the runner\n',
    '        mc project archive <project>                done: its row to the repository\'s project_log.md, CLOSEOUT.json beside the plan, its step area closed\n',
    '        mc project discard <project> [--apply]      gone: its directory, step area, register file and open pull requests; without --apply it shows what would go\n',
    '        mc project <name> [--json] [--offline]      show a project: a sent plan as mc status <name> does, a draft as it stands\n',
    '        mc project criterion drop <project> <n> --reason "…"          remove a criterion nobody can measure from a draft or a sent plan; the register and its log record why\n',
    '        mc project criterion met [<project>] <n>     record that success criterion <n> holds — it was measured by its check\n',
    '        mc project criterion unmet [<project>] <n>   record that success criterion <n> does not hold\n',
    '        the project defaults to MC_STEP\'s in a runner session\n',
  ].join('');
}

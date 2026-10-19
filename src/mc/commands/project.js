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
 *   mc project criterion met [<project>] <n>     record that success criterion <n> holds
 *   mc project criterion unmet [<project>] <n>   record that success criterion <n> does not hold
 *   mc project import [--apply]                  copy every plan on origin/main that is not under ~/mc/programs/ there
 *
 * The project defaults to MC_STEP's in a runner session, so a step session
 * names only the criterion number.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultRepos, listArchived, listPlans, listRepoPlans } from '../brief-collect.js';
import { NAME_RE, PLAN_SCHEMA, PLAN_VERSION, readPlanText, validatePlan } from '../plan-schema.js';
import { PLAN_FILE, programsPlans } from '../plan-source.js';
import { bannedWords, dependencyWords, DRAFT_FILE, draftProblems, findProjectDir, readDraftOrPlan, withPlanLock, writePlanFile } from '../plan-write.js';
import { parseStepEnv, readEntry, updateCriterion } from '../register.js';
import { programsHome, workRoot } from '../paths.js';
import { scanArgs } from './flags.js';

/** The flags each verb takes; any other flag given to a verb is refused with exit 2. */
const NEW_FLAGS = ['--repo', '--goal', '--contract', '--out-of-scope'];
const EDIT_FLAGS = ['--goal', '--contract', '--out-of-scope'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const now = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const io = { read: deps.read, write: deps.write, lock: deps.lock };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];

  const scanned = scanArgs(argv, {
    booleans: ['--apply'],
    strictValues: ['--repo', '--goal', '--check', '--model', '--effort', '--done-when', '--after', '--instruction-file', '--title'],
    repeatable: ['--contract', '--out-of-scope'],
  });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const [noun, verb, ...rest] = scanned.positional;
  if (noun === 'import') {
    if (scanned.positional.length !== 1) { stderr.write(usage()); return 2; }
    const extra = onlyFlags(scanned, ['--apply']);
    if (extra) { stderr.write(`mc: import takes no ${extra}\n`); return 2; }
    return importPlans(scanned.flags.apply, { ...deps, env, stdout, stderr });
  }
  if (scanned.flags.apply) { stderr.write(usage()); return 2; }
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

/**
 * `mc project import` — copies each repository plan on origin/main that is not
 * under `~/mc/programs/` yet to `<home>/<programme>/<project>/PLAN.json`, with
 * the repository it came from named in `repo` (ruling 48). A file that exists is
 * never written, and no repository is touched; the register is brought to the
 * new path by the next reader. Without `apply` it says what would go.
 */
function importPlans(apply, deps) {
  const { env, stdout, stderr } = deps;
  const repos = deps.repos || defaultRepos(env);
  const home = deps.home || programsHome(env);
  const programs = deps.programs || (() => programsPlans({ home }));
  const records = deps.listRepoPlans || listRepoPlans;
  const fetch = deps.fetch || fetchOrigin;
  const writeText = deps.writeText || writeTextFile;

  const held = new Set(programs().map((e) => e.project));
  const claimed = new Map();
  const kept = [];
  for (const repo of repos) {
    if (!existsSync(join(repo.path, '.git'))) continue;
    fetch(repo);
    for (const record of records(repo)) {
      if (record.legacy || held.has(record.project)) continue;
      const where = `${repo.name}:${record.programme}/${record.project}`;
      // The first repository in `repos` order owns a project's name; a second
      // plan of that name is not imported, whatever state either is in.
      if (claimed.has(record.project)) {
        stdout.write(`skip ${where} — ${record.project} is ${claimed.get(record.project)}'s\n`);
        continue;
      }
      claimed.set(record.project, repo.name);
      if (record.problems.length) {
        stdout.write(`skip ${where} — does not read: ${record.problems[0]}\n`);
        continue;
      }
      const { schema, version, ...plan } = record.plan;
      delete plan.repo;
      const text = `${JSON.stringify({ schema, version, repo: repo.name, ...plan }, null, 2)}\n`;
      const { problems } = readPlanText(text);
      if (problems.length) { stdout.write(`skip ${where} — ${problems[0]}\n`); continue; }
      const target = join(home, record.programme, record.project, PLAN_FILE);
      if (existsSync(target)) { stdout.write(`skip ${where} — ${target} exists\n`); continue; }
      kept.push({ where, target, text });
    }
  }

  if (kept.length === 0) { stdout.write('nothing to import\n'); return 0; }
  if (!apply) {
    for (const item of kept) stdout.write(`would import ${item.where} → ${item.target}\n`);
    stdout.write('mc project import --apply to write them\n');
    return 0;
  }
  let failed = false;
  for (const item of kept) {
    try {
      writeText(item.target, item.text);
      stdout.write(`imported ${item.where} → ${item.target}\n`);
    } catch (error) {
      stderr.write(`mc: ${error?.message || error}\n`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

/** Brings origin's refs up to date, so the listing is origin/main as it is now. Its status is ignored: a failed fetch leaves the last one in place. */
function fetchOrigin(repo) {
  spawnSync('git', ['-C', repo.path, 'fetch', '-q', 'origin']);
}

/** Writes a file whole: its directory is made, and the text lands under its name in one rename. */
function writeTextFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function usage() {
  return [
    'usage — mc project new <programme>/<project> --repo <repo> --goal <text> --contract <text>... --out-of-scope <text>...   draft a plan, as DRAFT.json\n',
    '        mc project edit <project> [--goal <text>] [--contract <text>...] [--out-of-scope <text>...]                     change a draft\'s goal, contract or out of scope\n',
    '        mc project criterion add <project> <text> --check <command>   add a success criterion, to a draft or a sent plan\n',
    '        mc project criterion met [<project>] <n>     record that success criterion <n> holds — it was measured by its check\n',
    '        mc project criterion unmet [<project>] <n>   record that success criterion <n> does not hold\n',
    '        the project defaults to MC_STEP\'s in a runner session\n',
    '        mc project import [--apply]                  copy every plan on origin/main that is not under ~/mc/programs/ there, with its repo — without --apply it shows what would go\n',
  ].join('');
}

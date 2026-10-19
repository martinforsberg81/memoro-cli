/**
 * `mc project` — mc's own verbs over a project (ruling 48, `docs/project/mc/mc-project.md`).
 *
 * For now it records whether a success criterion is met: the register's, never
 * a pull request's. Whoever measured a criterion by its check says so here.
 *
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

import { defaultRepos, listRepoPlans } from '../brief-collect.js';
import { readPlanText } from '../plan-schema.js';
import { PLAN_FILE, programsPlans } from '../plan-source.js';
import { parseStepEnv, readEntry, updateCriterion } from '../register.js';
import { programsHome, workRoot } from '../paths.js';
import { scanArgs } from './flags.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const now = (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const io = { read: deps.read, write: deps.write, lock: deps.lock };
  for (const key of Object.keys(io)) if (io[key] === undefined) delete io[key];

  const scanned = scanArgs(argv, { booleans: ['--apply'], strictValues: [] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const [noun, verb, ...rest] = scanned.positional;
  if (noun === 'import') {
    if (scanned.positional.length !== 1) { stderr.write(usage()); return 2; }
    return importPlans(scanned.flags.apply, { ...deps, env, stdout, stderr });
  }
  if (scanned.flags.apply) { stderr.write(usage()); return 2; }
  if (noun !== 'criterion' || (verb !== 'met' && verb !== 'unmet') || rest.length < 1 || rest.length > 2) {
    stderr.write(usage());
    return 2;
  }
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
    'usage — mc project criterion met [<project>] <n>     record that success criterion <n> holds — it was measured by its check\n',
    '        mc project criterion unmet [<project>] <n>   record that success criterion <n> does not hold\n',
    '        the project defaults to MC_STEP\'s in a runner session\n',
    '        mc project import [--apply]                  copy every plan on origin/main that is not under ~/mc/programs/ there, with its repo — without --apply it shows what would go\n',
  ].join('');
}

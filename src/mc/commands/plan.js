/**
 * `mc plan [<programme>]` — a planning session for one programme.
 *
 * A programme is the unit, not a project. The session writes the programme's
 * document and one `PLAN.json` per project that can start now, and `mc run`
 * picks those up later from origin/main. That file on main is the whole
 * coupling between the two: nothing else is shared, and in particular not a
 * directory.
 *
 * It used to be shared, and that is what this replaces. `mc plan <name>` made
 * `~/mc/<name>` on branch `<name>` — exactly the workarea and the branch the
 * runner gives the project of that name — so one word did three jobs, and the
 * planning session sat in the folder `mc run` would later merge into, close,
 * and hand back to git. The two are not the same kind of thing. A planning
 * session is Martin's, lasts as long as it takes, and spans both repositories
 * because a programme does; a project's workarea is the runner's, single-repo,
 * and removed the round its plan says done (Martin, 2026-08-31: "en mc plan
 * sessions workarea ska aldrig vara hopkopplad till något som körs av mc run").
 *
 * So planning sessions live under `~/mc/plan/` — mc's own directory, beside
 * `runner/`, `intake/` and `brief/` — as `~/mc/plan/<programme>/`, holding a
 * checkout of both repositories on branch `plan/<programme>`. The runner
 * cannot reach one, and not by a rule about names that could be forgotten:
 * `mc run`'s `workareas()` and `mc status`'s `areasWithCheckout()` both list
 * top-level directories that hold a checkout, and `~/mc/plan/` holds none. The
 * programmes are one level below that, where neither looks.
 *
 * With no programme named the command asks rather than requiring the name to
 * be remembered: every programme on main in either repository, the ones
 * already being planned, and naming a new one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

import { defaultRepos, listPlans, listProgrammes } from '../brief-collect.js';
import { addWorktree, createWorkArea, inspectWorkArea } from '../work-area.js';
import { openInWorkArea } from '../work-open.js';
import { PLAN_HOME, planHome } from '../paths.js';
import { readCanonRole, reservedRoleHint, reservedRoleName } from '../roles.js';
import { ask, interactive, select } from '../prompt.js';
import { scanArgs } from './flags.js';

const NAME = /^[A-Za-z0-9._-]{1,64}$/u;

/** `~/mc/plan/<programme>`, as `inspectWorkArea` and friends name a directory. */
export const planArea = (programme) => `${PLAN_HOME}/${programme}`;

/** The branch a planning session commits on, in every repository it holds. */
export const planBranch = (programme) => `${PLAN_HOME}/${programme}`;

const USAGE = 'usage — mc plan [<programme>] [--codex|--claude] [--model <model>]\n';

/** What `chooseProgramme` returns for "not one of these" — never a real name. */
const NEW_PROGRAMME = Symbol('new programme');

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(USAGE);
    return 2;
  }

  const env = deps.env || process.env;
  const repos = deps.repos || defaultRepos(env);

  let programme = opts.name;
  if (!programme) {
    // Never ask when there is nobody to answer: a pipe, a script and `--json`
    // get the usage line they always did rather than a question into the void.
    if (!(deps.interactive || interactive)(env)) {
      stderr.write('mc: plan what? mc plan <programme>\n');
      stderr.write(USAGE);
      return 2;
    }
    programme = (deps.choose || chooseProgramme)({ repos, env, stdout });
    // A refusal to choose is not an error to report back at them.
    if (!programme) return 0;
  }
  if (!NAME.test(programme)) {
    stderr.write(`mc: not a valid programme name: ${programme}\n`);
    return 1;
  }
  if (reservedRoleName(programme)) {
    stderr.write(`mc: ${reservedRoleHint(programme)}\n`);
    return 1;
  }

  const role = readCanonRole('plan');
  if (!role?.overlay) {
    stderr.write('mc: the plan role is missing from this install — expected canon/roles/plan.md with an overlay body\n');
    return 1;
  }

  const ready = (deps.ensure || ensurePlanArea)(programme, { repos, env, stdout, stderr, git: deps.git });
  if (!ready.ok) return 1;

  // The session stands in the programme's own directory rather than in either
  // checkout: both repositories are siblings under it, and a programme that
  // spans them should not have to be opened in one of them by guess.
  const launch = planLaunch({ programme, repos: ready.repos, role });
  const result = await (deps.open || openInWorkArea)({
    areaRoot: ready.path,
    worktree: { repo: null, path: ready.path, is_git: false },
    tool: opts.tool || role.tools?.[0] || 'claude',
    pick: 'new',
    verb: 'plan',
    areaName: planArea(programme),
    model: opts.model,
    overlay: launch.overlay,
    prompt: launch.prompt,
    defaultModel: role.model,
    defaultModelTool: role.tools?.[0] || null,
  });
  if (!result.ok) {
    stderr.write(`mc: ${result.reason}${result.hint ? ` — ${result.hint}` : ''}\n`);
    return 1;
  }
  return result.code ?? 0;
}

/* ----------------------------------------------------------------- the area */

/**
 * `~/mc/plan/<programme>/` with a checkout of every repository mc knows, each
 * on `plan/<programme>` from origin/main. An existing area is used as it is and
 * only what is missing is added, so re-opening a programme carries on where it
 * was left rather than starting again.
 *
 * A repository that is not on this machine is said and skipped rather than
 * refused: a programme is usually planned against one of the two, and losing
 * the session over the other one's absence helps nobody. Nothing at all is the
 * only failure.
 */
export function ensurePlanArea(programme, { repos, env = process.env, stdout, stderr, git = null } = {}) {
  const name = planArea(programme);
  const branch = planBranch(programme);
  const runGit = git || ((args) => spawnSync('git', args, { stdio: 'ignore' }));
  let area = inspectWorkArea(name, env);
  if (!area.exists) createWorkArea(name, env);

  for (const repo of repos) {
    if (area.worktrees.some((item) => item.repo === repo.name && item.is_git)) continue;
    if (!existsSync(repo.path)) {
      stderr.write(`mc: no ${repo.name} checkout at ${repo.path} — planning without it\n`);
      continue;
    }
    const fetched = runGit(['-C', repo.path, 'fetch', '-q', 'origin']);
    if (fetched?.status !== 0) stderr.write(`mc: git fetch in ${repo.path} failed — origin/main may be stale\n`);
    const added = addWorktree({
      name, repo: repo.path, branch, from: 'origin/main', env,
    });
    if (!added.ok) {
      stderr.write(`mc: could not add ${repo.name} to ${name} (${added.reason})\n`);
      continue;
    }
    stdout.write(`mc: ${added.path} on ${added.branch}${added.base ? ` from ${added.base}` : ''}\n`);
  }

  area = inspectWorkArea(name, env);
  const held = area.worktrees.filter((item) => item.is_git).map((item) => item.repo).sort();
  if (!held.length) {
    stderr.write(`mc: no repository could be checked out for ${name} — nothing to plan in\n`);
    return { ok: false };
  }
  return { ok: true, path: area.path, repos: held };
}

/* ------------------------------------------------------------- the choosing */

/**
 * Which programme? Every one on main in either repository, every one already
 * being planned under `~/mc/plan/`, and a way to name a new one.
 *
 * A programme is offered whether or not it has a plan the runner can read
 * today. `listProgrammes` asks the tree, so a programme whose projects have all
 * been archived is still on the list — which is the case where the offer is
 * worth most, because the next piece of that work belongs under the heading
 * that already exists rather than under a parallel one somebody invents.
 */
export function chooseProgramme({ repos, env = process.env, stdout, rows = null } = {}) {
  const listed = rows || programmeRows({ repos, env });
  const items = listed.map((row, index) => ({
    key: index + 1,
    name: row.name,
    label: programmeLabel(row),
    value: row.name,
  }));
  items.push({ key: 'n', name: 'new', label: 'a new programme', value: NEW_PROGRAMME });
  const chosen = select('\nwhich programme?', items, { stdout });
  if (chosen === null) return null;
  if (chosen !== NEW_PROGRAMME) return chosen;
  return ask('name it:', { stdout }) || null;
}

/**
 * One row per programme: where it lives, how many projects it has on main and
 * how many of those are unfinished, and whether it is already open in a
 * planning session.
 *
 * The two readings are separate on purpose. `listProgrammes` is the tree and
 * answers *which programmes exist*; `listPlans` is the plans and answers *what
 * is in them*. A programme whose projects have all been archived is a real
 * answer to the first and an empty one to the second, and asking only the
 * second would drop it off the list.
 */
export function programmeRows({ repos, env = process.env, read = null } = {}) {
  const source = read || ((repo) => ({ programmes: listProgrammes(repo), plans: listPlans(repo) }));
  const rows = new Map();
  const touch = (name) => {
    if (!rows.has(name)) rows.set(name, { name, repos: [], projects: 0, unfinished: 0, planning: false });
    return rows.get(name);
  };
  const seenIn = (row, repo) => { if (!row.repos.includes(repo)) row.repos.push(repo); };
  for (const repo of repos) {
    const { programmes = [], plans = [] } = source(repo) || {};
    for (const name of programmes) seenIn(touch(name), repo.name);
    for (const plan of plans) {
      const row = touch(plan.programme);
      seenIn(row, repo.name);
      row.projects += 1;
      if (plan.status !== 'done') row.unfinished += 1;
    }
  }
  // A programme being planned right now may have nothing on main yet — its PR
  // is still open, or still unwritten — and is exactly the one somebody
  // re-opening `mc plan` is looking for. So the sessions on disk count too.
  for (const name of openPlanAreas(env)) touch(name).planning = true;
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The programmes that already have a planning session directory. */
export function openPlanAreas(env = process.env) {
  try {
    return readdirSync(planHome(env), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
}

/** The one line the picker shows for a programme. */
export function programmeLabel(row) {
  const parts = [row.repos.join(', ') || 'not on main'];
  if (row.projects) {
    parts.push(`${row.projects} project${row.projects === 1 ? '' : 's'}`
      + (row.unfinished ? `, ${row.unfinished} unfinished` : ', all done'));
  } else if (row.repos.length) {
    parts.push('no projects on main');
  }
  if (row.planning) parts.push('being planned');
  return `${row.name}  —  ${parts.join(' · ')}`;
}

/* --------------------------------------------------------------- the launch */

/**
 * What the session is told, assembled without starting anything: the role
 * overlay as written, and the first prompt naming the programme, the
 * repositories it can see, and the deliverable.
 *
 * The last line is the docs merge, not "and stop": a plan PR touches only
 * `docs/`, so it is `mc merge <repo> <pr> --docs`' case, and the runner cannot
 * queue a project whose plan is still sitting in an open PR.
 */
export function planLaunch({ programme, repos = [], role }) {
  const beside = repos.map((repo) => `\`${repo}/\``).join(' and ') || 'no checkout';
  const prompt = [
    `You are the planning session for the \`${programme}\` programme. You stand in`,
    `\`~/mc/plan/${programme}/\`, with ${beside} beside you — each a worktree on`,
    `branch \`plan/${programme}\` from origin/main. This directory is not a workarea:`,
    'nothing `mc run` does can reach it, and no project belongs to it.',
    '',
    'Start by reading, and say what you found. What already exists under',
    `\`docs/project/${programme}/\` in each checkout here; the open "Plan:" PRs in`,
    'both repositories (`gh pr list --search "Plan:" --state open`); and',
    '`~/mc/intake/proposals/`, where work nobody has planned yet arrives.',
    '',
    'Then talk it through with Martin and write, as your role describes: the',
    `programme document if the programme is new or its shape has changed, and one`,
    `\`docs/project/${programme}/<project>/PLAN.json\` for every project that can`,
    'start against the code as it stands — not every state the programme will ever',
    'pass through. Each `<project>` name you choose is what the runner will later',
    'call that project\'s branch and its workarea; choosing it is the whole of your',
    'part in that, and you make neither.',
    '',
    `Open a PR titled "Plan: ${programme}" in each repository you changed, and land`,
    'it yourself — it is documentation only: `mc merge <repo> <pr> --docs`. If it',
    'refuses, leave the PR open and say why. Then stop.',
  ].join('\n');
  return { overlay: role.overlay, prompt, model: role.model || null };
}

function parseArgs(argv) {
  // `--repo` was how the old, project-shaped `mc plan` chose which repository
  // to make a workarea in. A programme is not in one repository, so the flag
  // has nothing left to select — said plainly, because "unknown flag" reads
  // like a typo to whoever typed what worked yesterday.
  if (argv.includes('--repo')) {
    return { error: 'a programme spans both repositories — mc plan takes no --repo' };
  }
  const scanned = scanArgs(argv, { strictValues: ['--model'], toolSugar: true });
  if (scanned.error) return { error: scanned.error };
  const words = scanned.positional;
  if (words.length > 1) return { error: `unexpected argument ${words[1]}` };
  return {
    name: words[0] || null,
    model: scanned.flags.model || null,
    tool: scanned.flags.tool || null,
  };
}

/**
 * `mc plan [<programme>]` — a session in a directory, told which programme it
 * is for. That is the whole verb.
 *
 * It opens a foreground session in the programme's planning directory and hands it one
 * prompt naming the programme. What comes out of it — one goal or four, under
 * which names, reaching `main` by which route, or nothing this time — is not
 * this command's business and cannot be known when it starts (Martin,
 * 2026-08-31).
 *
 * A programme is the unit rather than a project, and the directory is not a
 * workarea. That is what this replaces: `mc plan <name>` made
 * `~/mc/<name>` on branch `<name>` — exactly the workarea and the branch the
 * runner gives the project of that name — so one word did three jobs, and the
 * planning session sat in the folder `mc run` would later merge into, close,
 * and hand back to git. The two are not the same kind of thing. A planning
 * session is Martin's, lasts as long as it takes, and spans both repositories
 * because a programme does; a project's workarea is the runner's, single-repo,
 * and removed the round its plan says done (Martin, 2026-08-31: "en mc plan
 * sessions workarea ska aldrig vara hopkopplad till något som körs av mc run").
 *
 * Planning sessions live under `programs/<programme>/` (layout 2),
 * or `plan/<programme>/` on a legacy layout-1 machine, holding a
 * checkout of both repositories on branch `plan/<programme>`. The runner
 * cannot reach one, and not by a rule about names that could be forgotten:
 * `mc run`'s `workareas()` and `mc status`'s `areasWithCheckout()` both list
 * top-level directories that hold a checkout, and the planning root holds none. The
 * programmes are one level below that, where neither looks.
 *
 * With no programme named the command asks rather than requiring the name to
 * be remembered: every programme on main in either repository, the ones
 * already being planned, and naming a new one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultRepos, listProgrammes } from '../brief-collect.js';
import { archiveProgramme } from '../archive-programme.js';
import { runDocsMerge } from '../docs-merge.js';
import { addWorktree, createWorkArea, dropEmptyArea, inspectWorkArea, releaseWorkArea } from '../work-area.js';
import { attachRepoDeps } from '../shared-deps.js';
import { openInWorkArea } from '../work-open.js';
import { layoutVersion, planAreaName, planAreaRoot, workRoot } from '../paths.js';
import { readCanonRole, reservedRoleHint, reservedRoleName, roleSourceOf } from '../roles.js';
import { ask, interactive, select } from '../prompt.js';
import { run as runGit } from '../git.js';
import { planSessionRefusal } from '../session-role.js';
import { PLAN_ROLE } from '../goals.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';
import { canonRoot } from '../canon.js';

function sh(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** The entrance under another name, for `ensurePlanArea`, whose own `runGit` shadows the import. */
const gitRun = runGit;

/** `sh`, for git: the same shape, through the one git entrance. */
function shGit(args, { cwd } = {}) {
  const r = runGit(cwd, args, { maxBuffer: 64 << 20 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/u;

/**
 * A programme's planning area, as `inspectWorkArea` and friends name a
 * directory: `plan/<programme>` in layout 1, `programs/<programme>` in layout 2.
 */
export const planArea = (programme, env = process.env) => planAreaName(programme, { root: workRoot(env) });

/**
 * The branch a planning session commits on, in every repository it holds.
 * `plan/<programme>` in both layouts: the branch is the session's name, not
 * the directory's, so it does not follow the planning root.
 */
export const planBranch = (programme) => `plan/${programme}`;

const USAGE = commandUsage('plan');

/** What `chooseProgramme` returns for "not one of these" — never a real name. */
const NEW_PROGRAMME = Symbol('new programme');

export function usage() {
  return commandUsage('plan');
}

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
  const refusal = planSessionRefusal({ cwd: deps.cwd || process.cwd(), env });
  if (refusal) {
    stderr.write(`mc: ${refusal}\n`);
    return 1;
  }
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

  // A programme that is over: off main in both repositories, and its planning
  // session released. Never triggered — only typed (archive-programme.js).
  if (opts.archive) {
    return archiveProgramme(programme, {
      repos,
      env,
      areaName: planArea(programme, env),
      areaPath: join(workRoot(env), planArea(programme, env)),
      stdout,
      stderr,
      deps: {
        git: deps.git || ((cwd, args) => shGit(['-C', cwd, ...args])),
        gh: deps.gh || ((cwd, args) => sh('gh', args, { cwd })),
        docsMerge: deps.docsMerge || runDocsMerge,
        release: deps.release || releaseWorkArea,
      },
    });
  }

  // The role is the model and the tools this session defaults to, and — since
  // #656 — a body saying what a planning session is for and how a plan is
  // written. A role file with no body is a session told nothing about
  // planning, which is what that change ended; refused here rather than
  // launched, the way every other role command refuses its own.
  const role = (deps.role || (() => readCanonRole(PLAN_ROLE)))();
  if (!role?.overlay) {
    stderr.write('mc: the plan role is missing from this install — expected canon/roles/plan-session.md with an overlay body\n');
    return 1;
  }

  const ready = (deps.ensure || ensurePlanArea)(programme, { repos, env, stdout, stderr, git: deps.git });
  if (!ready.ok) return 1;

  // The session stands in the programme's own directory rather than in either
  // checkout: both repositories are siblings under it, and a programme that
  // spans them should not have to be opened in one of them by guess.
  //
  // A programme's session is picked up where it was, not started over: a
  // compatible conversation here is resumed, with no intro; unknown or
  // incompatible history starts fresh, as does `--new` (Martin, 2026-09-13:
  // "Existerar det en
  // session, ska samma öppnas utan intro").
  const launch = planLaunch({ programme, repos: ready.repos, role, env, readmeWritten: ready.readme === 'written' });
  const result = await (deps.open || openInWorkArea)({
    env,
    stderr,
    programme,
    areaRoot: ready.path,
    worktree: { repo: null, path: ready.path, is_git: false },
    tool: opts.tool || role.tools?.[0] || 'claude',
    pick: opts.fresh ? 'new' : opts.resume,
    resumeTool: opts.tool,
    stdout,
    verb: 'plan',
    areaName: planArea(programme, env),
    roleName: role.name || PLAN_ROLE,
    roleSource: roleSourceOf(role),
    cache: role.cache,
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
 * The programme's planning directory with a checkout of every repository mc knows, each
 * on `plan/<programme>` from origin/main. An existing area is used as it is and
 * only what is missing is added, so re-opening a programme carries on where it
 * was left rather than starting again.
 *
 * A repository that is not on this machine is said and skipped rather than
 * refused: a programme is usually planned against one of the two, and losing
 * the session over the other one's absence helps nobody. Nothing at all is the
 * only failure.
 */
export function ensurePlanArea(programme, { repos, env = process.env, stdout, stderr, git = null, attach = attachRepoDeps, exists = existsSync } = {}) {
  const name = planArea(programme, env);
  const branch = planBranch(programme);
  const runGit = git || ((args) => gitRun(undefined, args, { stdio: 'ignore' }));
  let area = inspectWorkArea(name, env);
  // Made here rather than by the first `addWorktree`, so a programme whose
  // repositories all fail leaves this call holding the empty directory — and
  // the one that made it is the one that takes it away again.
  const madeTheArea = !area.exists;
  if (madeTheArea) createWorkArea(name, env);

  for (const repo of repos) {
    // A checkout that stands is reopened, and its attachment may predate the
    // lockfile on main, so it is attached again here and what it says is said.
    // A new one is attached by `addWorktree`.
    if (area.worktrees.some((item) => item.repo === repo.name && item.is_git)) {
      const path = join(area.path, repo.name);
      const attached = attach(path);
      if (!attached.ok) stderr.write(`mc: dependencies not attached in ${path} — ${attached.why}\n`);
      continue;
    }
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
    if (madeTheArea) dropEmptyArea(area.path);
    stderr.write(`mc: no repository could be checked out for ${name} — nothing to plan in\n`);
    return { ok: false };
  }
  const readmePath = join(area.path, 'README.md');
  let readme = 'kept';
  if (!exists(readmePath)) {
    const template = programmeReadmeTemplate(programme);
    if (template === null) {
      stderr.write(`mc: could not read the programme template for ${readmePath} — starting without a README\n`);
      readme = 'unavailable';
    } else {
      try {
        writeFileSync(readmePath, template, { flag: 'wx' });
        stdout.write(`mc: ${readmePath} written from the programme template — a page to fill in\n`);
        readme = 'written';
      } catch (error) {
        if (error.code === 'EEXIST') {
          readme = 'kept';
        } else {
          stderr.write(`mc: could not write the programme template to ${readmePath} — starting without a README\n`);
          readme = 'unavailable';
        }
      }
    }
  }
  return { ok: true, path: area.path, repos: held, readme };
}

/** The programme page inside the packaged canon's fenced markdown block. */
export function programmeReadmeTemplate(programme) {
  let source;
  try {
    source = readFileSync(join(canonRoot(), 'tasks', 'references', 'programme-readme.md'), 'utf8');
  } catch {
    return null;
  }
  const block = source.match(/^```markdown\r?\n([\s\S]*?)\r?\n```/mu)?.[1];
  if (block === undefined) return null;
  return block.replace(/^# <programme>/mu, `# ${programme}`);
}

/* ------------------------------------------------------------- the choosing */

/**
 * Which programme? Every one on main in either repository, every one already
 * being planned under the planning root, and a way to name a new one.
 *
 * A programme is offered whether or not it has work the runner can start
 * today: the next piece of that work belongs under the heading that already
 * exists rather than under a parallel one somebody invents.
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
 * One row per programme: the repositories whose tree holds it
 * (`listProgrammes`), and whether it is already open in a planning session.
 */
export function programmeRows({ repos, env = process.env, read = null } = {}) {
  const source = read || ((repo) => ({ programmes: listProgrammes(repo) }));
  const rows = new Map();
  const touch = (name) => {
    if (!rows.has(name)) rows.set(name, { name, repos: [], planning: false });
    return rows.get(name);
  };
  const seenIn = (row, repo) => { if (!row.repos.includes(repo)) row.repos.push(repo); };
  for (const repo of repos) {
    const { programmes = [] } = source(repo) || {};
    for (const name of programmes) seenIn(touch(name), repo.name);
  }
  // A programme being planned right now may have nothing on main yet — its PR
  // is still open, or still unwritten — and is exactly the one somebody
  // re-opening `mc plan` is looking for. So the sessions on disk count too.
  for (const name of openPlanAreas(env)) touch(name).planning = true;
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The programmes that already have a planning session: a directory under the
 * planning root that holds a checkout in at least one child directory. In
 * layout 2 a programme's directory can hold only its goals and documents (no
 * checkout), and such a programme is not being planned.
 */
export function openPlanAreas(env = process.env) {
  const root = planAreaRoot({ root: workRoot(env) });
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .filter((entry) => holdsCheckout(join(root, entry.name)))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
}

/** Whether a directory holds a checkout in one of its child directories. */
function holdsCheckout(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, '.git')));
  } catch { return false; }
}

/** The one line the picker shows for a programme. */
export function programmeLabel(row) {
  const parts = [row.repos.join(', ') || 'not on main'];
  if (row.planning) parts.push('being planned');
  return `${row.name}  —  ${parts.join(' · ')}`;
}

/* --------------------------------------------------------------- the launch */

/**
 * The whole of what a new planning session is told: which programme and where
 * it stands. Martin opens; what to read follows from what he asks.
 *
 * It stops there on purpose. An earlier version of this prompt went on to name
 * the deliverable — a programme document, one plan per piece of work that can
 * start now, a `Plan: <programme>` PR, the docs merge that lands it — and none
 * of that is knowable when the session opens (Martin, 2026-08-31: "Hur en
 * EVENTUELL PLAN SENARE SKA LÄGGAS PÅ MAIN OCH I VILKET PROJEKT GÅR INTE ATT
 * FÖRUTSÄGA"). Whether this programme needs one goal or four, whether it
 * needs one at all this time, and how what comes out of it reaches `main`
 * are the session's and Martin's to work out together, at the terminal. A
 * prompt that answers them in advance is guessing, and a session that follows
 * the guess is doing the wrong work confidently.
 *
 * It used to go on to name what to read first. That is in
 * `canon/roles/plan-session.md`, which reaches the session the way every other
 * role's does, and a session told to start by reading and reporting spent its
 * first turn on an intro Martin had not asked for (Martin, 2026-09-13). What a
 * planning session *is* is the role's to say.
 *
 * When this call wrote a README, it reports the directory's state, not a
 * prediction about what the session will make.
 *
 * This function used to read the shared role text and paste it into the
 * prompt, because a role with no overlay inherits nothing: `instructionsFor`
 * hangs the shared text on the overlay, and this role had none. It has one now
 * (#656), so the shared text arrives by the same door as every other session's
 * and pasting it here as well would tell a planning session the same rules
 * twice. The `shared` parameter is gone with it.
 */
/**
 * What a branch of the session's own is named: `goal/<goal>` is a goal's
 * worktree's, so one of the session's is `plan/<slug>`. Said as the
 * consequence, not a ban (Martin, 2026-11-03: a plan session has full
 * freedom; text says what breaks, never who may).
 */
export const BRANCH_LINE = 'A branch named `goal/<goal>` is that goal\'s worktree\'s; name yours `plan/<slug>`.';

export function planLaunch({ programme, repos = [], role, env = process.env, readmeWritten = false }) {
  const beside = repos.map((repo) => `\`${repo}/\``).join(' and ') || 'no checkout';
  const layoutTwo = layoutVersion({ root: workRoot(env) }) === 2;
  const lines = [
    `You are the plan session for the \`${programme}\` programme. Its aim is in \`~/mc/${planArea(programme, env)}/README.md\`; read it first.`,
    ...(readmeWritten ? ['This README was written just now from the programme template; its sections have placeholder text. Fill it in as `tasks/designing-a-programme.md` says.'] : []),
    'With Martin at the terminal you have full freedom toward that aim: investigate, plan, build and land the work yourself.',
    '',
    `You stand in \`~/mc/${planArea(programme, env)}/\`, with ${beside} beside you — each a`,
    `worktree on branch \`plan/${programme}\`. This is not a runner area: the runner`,
    'never works in it.',
    ...(layoutTwo ? ['Your programme\'s goals are under `goals/`, each with its GOAL.json and LOG.md: `mc goal` writes them.'] : []),
    BRANCH_LINE,
    '',
    'Martin is at the terminal. Wait for him.',
  ];
  return { overlay: role.overlay || null, prompt: lines.join('\n'), model: role.model || null };
}

export function parseArgs(argv) {
  // `--repo` was how the old, single-repository `mc plan` chose which repository
  // to make a workarea in. A programme is not in one repository, so the flag
  // has nothing left to select — said plainly, because "unknown flag" reads
  // like a typo to whoever typed what worked yesterday.
  if (argv.includes('--repo')) {
    return { error: 'a programme spans both repositories — mc plan takes no --repo' };
  }
  const scanned = scanArgs(argv, { booleans: ['--new', '--archive', '--resume'], strictValues: ['--model'], toolSugar: true });
  if (scanned.error) return { error: scanned.error };
  const words = scanned.positional;
  if (words.length > (scanned.flags.resume ? 2 : 1)) return { error: `unexpected argument ${words[scanned.flags.resume ? 2 : 1]}` };
  if (scanned.flags.resume && scanned.flags.new) return { error: '--resume and --new cannot be combined' };
  if (scanned.flags.resume && words[1] === 'new') return { error: '--resume expects a conversation ID or prefix' };
  if (scanned.flags.resume && scanned.flags.archive) return { error: '--resume requires an interactive session' };
  // Archiving starts no session, so the session's flags have nothing to do —
  // and a picker is no way to choose what to remove.
  if (scanned.flags.archive) {
    if (!words[0]) return { error: 'archive which programme? mc plan <programme> --archive' };
    if (scanned.flags.new || scanned.flags.model || scanned.flags.tool) {
      return { error: '--archive starts no session — it takes no --new, --model, --codex or --claude' };
    }
  }
  return {
    name: words[0] || null,
    model: scanned.flags.model || null,
    tool: scanned.flags.tool || null,
    fresh: Boolean(scanned.flags.new),
    resume: scanned.flags.resume ? words[1] || true : null,
    archive: Boolean(scanned.flags.archive),
  };
}

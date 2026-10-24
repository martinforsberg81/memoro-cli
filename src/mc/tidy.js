/**
 * `mc tidy` — what mc keeps, per root, and what it may remove (ruling 39).
 *
 * Measured 2026-09-26: the data volume had 2.6 GB free of 228, and 17 GB came
 * back by hand. The same day an ad-hoc shell loop meant to remove orphaned
 * transcripts deleted nearly all of `~/.claude/projects` — every transcript
 * and every project's `memory/` — because a `find` that errored read as
 * "nothing here". So this is mostly about what is never removed:
 *
 *   - One list, written first. `gatherTidyFacts` reads everything, the pure
 *     `tidyPlan` decides, and `runTidy` writes the list whole to
 *     `~/mc/runner/tidy/<stamp>.json` — on a dry run too — before
 *     `applyTidy` reads it back and acts on nothing but its `targets`.
 *   - Each target is asked again at removal: its realpath must lie under the
 *     root its kind allows, and its rule must still say so on fresh facts.
 *   - A question that fails means keep. Every rule is one function returning
 *     `{ target, why }`; one that throws keeps its item with the error.
 *   - Deletion is node `fs` and `git worktree remove` without `--force`: no
 *     shell, no `find`, no globbing. `memory/` is never opened.
 *   - Work areas and step areas are never targets: `mc work release` /
 *     `discard` and the runner's `closeWorkareas` remove them.
 *   - (C) `mc shot --compare`'s trees under `~/.memoro/mc/compare/`
 *     (`shot-compare.js`) go when unused for a day — by the directory's
 *     mtime, which `compareTree` touches on every reuse — and no dev server
 *     runs in them, through `git worktree remove` in the repository that
 *     owns each one.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { logRows } from './archive-plan.js';
import { writeJsonAtomic } from './atomic-write.js';
import { mergedPullAtTip } from './branch-landed.js';
import { defaultRepos } from './brief-collect.js';
import { repositoryDir } from './repos.js';
import { closeoutPath } from './closeout.js';
import { SESSION_ID, claudeHome, readHead, treeBytes } from './conversations.js';
import { log } from './logger.js';
import {
  PLAN_HOME, PROGRAMS_HOME, RUNNER_DEPS, RUNNER_STEP, STEP_HOME, WORK_HOME, areaKindOf, areaOfPath, mcHome,
  planAreaRoot, runnerDir, stepAreaName, stepAreaRoot, workRoot,
} from './paths.js';
import { lsTreeArgs, planPath } from './plan-source.js';
import { closeoutFileOf } from './project-archive.js';
import { listEntries, registerDir, registerPath } from './register.js';
import { cwdsOfUser, processesStandingIn } from './standing.js';
import { serversFor } from './test-environment.js';
import {
  inspectWorktree, listStepAreas, pruneWorktrees, releaseVerdict, releaseWorktree,
} from './work-area.js';

export const DEFAULT_DAYS = 14;
export const RULES_VERSION = 1;
/** List files kept in `~/mc/runner/tidy/`; older ones go in the next apply. */
export const LIST_KEEP = 30;
/**
 * How long a planning session's transcript is kept once it is not its
 * directory's newest. Martin, 2026-10-11: "alltid behålla den aktuella; gamla
 * kan städas efter 72h" — always keep the current one; old ones may go after
 * 72 hours.
 */
export const PROGRAMME_TRANSCRIPT_KEEP_MS = 72 * 60 * 60 * 1000;
/** How long a `mc shot --compare` tree is kept after its last use — the day `shot-compare.js` prunes by. */
export const COMPARE_KEEP_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSCRIPT = /^(.+)\.jsonl$/u;
const LIST_FILE = /^\d{8}T\d{6}Z(-\d+)?\.json$/u;
/** A planning area's own checkouts: never a target. */
const PLAN_CHECKOUTS = new Set(['memoro', 'memoro-cli']);
/** Keeps that are the ordinary case, left out of the printout. */
export const ROUTINE = new Set(['T1', 'T2', 'T5', 'recent', 'project', 'plan-checkout', 'work-area', 'step-area', 'G']);

/** Every root tidy reads, by name. A kind removes only under its own. */
export function tidyRoots(env = process.env) {
  const root = workRoot(env);
  const runner = runnerDir(env);
  return {
    root,
    plan: planAreaRoot({ root }),
    step: stepAreaRoot({ root }),
    work: join(root, WORK_HOME),
    // Null in layout 2: a project's STATE.json is its knowledge (ruling 51), never a target.
    register: registerDir(root),
    log: join(runner, 'log'),
    closed: join(runner, 'log', 'closed'),
    scratch: join(runner, 'scratch'),
    tidy: join(runner, 'tidy'),
    claude: join(claudeHome(env), 'projects'),
    compare: join(mcHome(env), 'compare'),
  };
}

/** The root each kind of target must lie under, by `tidyRoots` key. */
const KIND_ROOT = {
  register: 'register',
  'session-log': 'log',
  'closed-log': 'closed',
  scratch: 'scratch',
  transcript: 'claude',
  leftover: 'claude',
  'plan-worktree': 'plan',
  'compare-worktree': 'compare',
};

const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * A runner session file of one project under `runner/log/`:
 * `<project>-<yyyymmddThhmmssZ>.{jsonl,json,json.err}`, gzipped or not.
 * Exact, like `sessionFileRe`: a prefix would give `ui-faults` the files of
 * `ui-faults-2`.
 */
export function sessionLogRe(project) {
  return new RegExp(`^${escape(project)}-\\d{8}T\\d{6}Z\\.(jsonl|json|json\\.err)(\\.gz)?$`, 'u');
}

/** A runner scratch directory of one project: `<project>-<yyyymmddThhmmssZ>`. */
export function scratchRe(project) {
  return new RegExp(`^${escape(project)}-\\d{8}T\\d{6}Z$`, 'u');
}

/** The directories every area of a kind sits under, in both layouts: never an area themselves. */
const KIND_ROOTS = new Set([PLAN_HOME, PROGRAMS_HOME, STEP_HOME, WORK_HOME, RUNNER_STEP, RUNNER_DEPS]);

/**
 * The area a transcript's cwd belongs to, by `areaOfPath` (paths.js), in both
 * layouts: `plan/<p>`, `programs/<p>`, `step/<x>`, `runner/step/<x>`,
 * `runner/deps/<n>`, `work/<n>`, or a legacy area's own name. A directory
 * that is no area — `brief/`, `runner/log/` — keeps the first segment below
 * the work root, as before. Null outside the work root, and for the root and
 * the kinds' own roots themselves.
 */
export function areaOf(cwd, root) {
  if (typeof cwd !== 'string' || !cwd.startsWith(`${root}/`)) return null;
  const area = areaOfPath(cwd, root);
  if (area) return area.area;
  const rest = cwd.slice(root.length + 1).replace(/\/+$/u, '');
  const [first] = rest.split('/');
  if (!first || KIND_ROOTS.has(first) || KIND_ROOTS.has(rest)) return null;
  return first;
}

/* ------------------------------------------------------------ gathering */

function realGit(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
}

/**
 * Everything the plan is decided from, read now. Every door is injectable:
 * `git(cwd, args)` answers text or null, `cwds()` is the one lsof of the run,
 * `inspect` and `pullAtTip` are `inspectWorktree` and `mergedPullAtTip`,
 * `servers(dir)` the live dev servers standing in a directory.
 */
export function gatherTidyFacts({
  env = process.env, now = Date.now(), gh = null, git = realGit, cwds = cwdsOfUser,
  inspect = inspectWorktree, pullAtTip = null, repos = defaultRepos(env), command = commandOf,
  servers = serversFor,
} = {}) {
  const roots = tidyRoots(env);
  const root = roots.root;
  const facts = {
    now, work_root: root, projects_root: roots.claude, roots,
    git_error: null, register_error: null, projects: [], plan_checkouts: [], plan_worktrees: [],
    work_areas: [], step_areas: [], foreign: [], compare_worktrees: [], transcripts: [], leftovers: [],
  };

  // origin/main, one `ls-tree` and one `show` per repository. A repository
  // that cannot answer stops every purge this run.
  const main = new Map();
  for (const repo of repos) {
    const tree = git(repo.path, lsTreeArgs());
    const text = git(repo.path, ['show', 'origin/main:docs/project/project_log.md']);
    if (tree == null || text == null) { facts.git_error = `${repo.name} could not say what origin/main holds`; continue; }
    main.set(repo.name, { tree: new Set(tree.split('\n').filter(Boolean)), rows: logRows(text) });
  }

  let entries = [];
  try { entries = listEntries(root); } catch (error) { facts.register_error = message(error); }
  const logFiles = listNames(roots.log);
  const scratchDirs = listNames(roots.scratch);
  for (const entry of entries) {
    const item = {
      project: entry.project, programme: entry.programme, repo: entry.repo,
      register_path: registerPath(root, entry.project),
      in_log: false, plan_on_main: null, closeout_on_main: false, area_exists: null,
      files: [],
    };
    facts.projects.push(item);
    try {
      const repo = main.get(entry.repo);
      if (repo) {
        item.in_log = repo.rows.some((row) => row.project === entry.project
          && (!row.programme || !entry.programme || row.programme === entry.programme));
        // A plan under `~/mc/programs/` is a file on this machine, not a path in origin/main's tree.
        // Its archiving leaves a CLOSEOUT.json beside it (ruling 48): that file is the closeout.
        if (isAbsolute(entry.plan || '')) {
          item.plan_on_main = present(entry.plan) && !present(closeoutFileOf(entry.plan));
          item.closeout_on_main = present(closeoutFileOf(entry.plan));
        } else {
          const planDir = entry.plan ? dirname(entry.plan) : dirname(planPath(entry.programme, entry.project));
          item.plan_on_main = [...repo.tree].some((path) => path.startsWith(`${planDir}/`));
          item.closeout_on_main = Boolean(entry.programme) && repo.tree.has(closeoutPath(entry.programme, entry.project));
        }
      } else if (!facts.git_error) {
        item.error = `its repository ${entry.repo || '(none)'} is not one tidy asks`;
      }
      item.area_exists = directoryExists(join(root, stepAreaName(entry.project, { root }))) || directoryExists(join(root, entry.project));
      // Only a project the rule would take has its files listed and weighed.
      if (!projectPurge(item, facts).target) continue;
      if (roots.register) item.files.push({ path: item.register_path, kind: 'register', bytes: treeBytes(item.register_path) });
      const logRe = sessionLogRe(entry.project);
      for (const name of logFiles) {
        if (logRe.test(name)) item.files.push({ path: join(roots.log, name), kind: 'session-log', bytes: treeBytes(join(roots.log, name)) });
      }
      const closed = join(roots.closed, entry.project);
      if (directoryExists(closed)) item.files.push({ path: closed, kind: 'closed-log', bytes: treeBytes(closed) });
      const dirRe = scratchRe(entry.project);
      for (const name of scratchDirs) {
        if (dirRe.test(name)) item.files.push({ path: join(roots.scratch, name), kind: 'scratch', bytes: treeBytes(join(roots.scratch, name)) });
      }
    } catch (error) { item.error = message(error); }
  }

  // One lsof for every plan worktree. It always sees this process, so an
  // empty answer is lsof failing — and then nothing can be said to be unused.
  let running = null;
  try { running = cwds(); } catch { running = null; }
  if (running && running.length === 0) running = null;
  const tip = pullAtTip || ((wt) => mergedPullAtTip(wt.path, wt.branch, gh ? { gh } : {}));
  for (const programme of listNames(roots.plan)) {
    const area = join(roots.plan, programme);
    for (const name of listNames(area)) {
      const path = join(area, name);
      if (!present(join(path, '.git'))) continue;
      if (PLAN_CHECKOUTS.has(name)) { facts.plan_checkouts.push({ path }); continue; }
      const item = { path, programme, name, wt: null, verdict: null, bytes: 0 };
      facts.plan_worktrees.push(item);
      try {
        if (!running) throw new Error('lsof could not say who stands in it');
        const wt = inspect(path, name);
        if (!wt.is_git) throw new Error('not a git worktree');
        item.wt = wt;
        const pids = [...new Set(processesStandingIn([path], { cwds: running }).map((p) => p.pid))];
        item.verdict = releaseVerdict(wt, { inUse: [...new Set(pids.map(command))], pullAtTip: tip });
        if (item.verdict.remove) item.bytes = treeBytes(path);
      } catch (error) { item.error = message(error); }
    }
  }

  facts.work_areas = listNames(roots.work).map((name) => ({ path: join(roots.work, name) }));
  facts.step_areas = listStepAreas({ root }).map((area) => ({ path: area.path }));

  // (C) `mc shot --compare`'s trees: last used by the directory's mtime,
  // which shot-compare touches on reuse; owned by the repository git names.
  for (const name of listNames(roots.compare)) {
    const path = join(roots.compare, name);
    if (!present(join(path, '.git'))) continue;
    const item = { path, owner: null, last_used_ms: null, live: null, bytes: 0 };
    facts.compare_worktrees.push(item);
    try {
      item.last_used_ms = statSync(path).mtimeMs;
      const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (!common?.trim()) throw new Error('git could not name the repository that owns it');
      item.owner = repositoryDir(common.trim());
      item.live = servers(path).length;
      if (!compareWorktree(item, now).target) continue;
      item.bytes = treeBytes(path);
    } catch (error) { item.error = message(error); }
  }

  // Worktrees git knows of outside the work root: listed, never removed.
  for (const repo of repos) {
    const text = git(repo.path, ['worktree', 'list', '--porcelain']);
    for (const line of String(text || '').split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path = line.slice('worktree '.length).trim();
      if (path === repo.path || path.startsWith(`${root}/`) || path.startsWith(`${roots.compare}/`)) continue;
      facts.foreign.push({ path, repo: repo.name });
    }
  }

  let dirs = [];
  try { dirs = readdirSync(roots.claude, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { dirs = []; }
  for (const dir of dirs) {
    const directory = join(roots.claude, dir.name);
    let entries2;
    try { entries2 = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    const names = new Set(entries2.map((entry) => entry.name));
    for (const entry of entries2) {
      const path = join(directory, entry.name);
      const id = TRANSCRIPT.exec(entry.name)?.[1];
      if (id && SESSION_ID.test(id) && entry.isFile()) {
        const item = { path, id, cwd: null, cwd_exists: null, mtime_ms: null, bytes: 0 };
        facts.transcripts.push(item);
        try {
          item.cwd = readHead(path).cwd;
          item.mtime_ms = statSync(path).mtimeMs;
          item.bytes = treeBytes(path) + treeBytes(join(directory, id));
          if (item.cwd) item.cwd_exists = directoryExists(item.cwd);
        } catch (error) { item.error = message(error); }
        continue;
      }
      // A `<uuid>/` with no transcript beside it. Every other directory —
      // `memory/` first of all — is never read.
      if (SESSION_ID.test(entry.name) && entry.isDirectory() && !names.has(`${entry.name}.jsonl`)) {
        const item = { path, newest_ms: null, bytes: 0 };
        facts.leftovers.push(item);
        try {
          item.newest_ms = newestMtime(path);
          item.bytes = treeBytes(path);
        } catch (error) { item.error = message(error); }
      }
    }
  }
  return facts;
}

/** The names in a directory; none when it cannot be read. */
function listNames(dir) {
  try { return readdirSync(dir).filter((name) => !name.startsWith('.')).sort(); } catch { return []; }
}

/** What `ps` calls a process, or its pid. */
function commandOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('/').pop() || `pid ${pid}`;
  } catch { return `pid ${pid}`; }
}

/** false only for "there is nothing there"; any other failure throws. */
function directoryExists(path) {
  try { statSync(path); return true; } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** The newest mtime anywhere under a path. Throws on anything unreadable. */
function newestMtime(path) {
  const stat = lstatSync(path);
  let newest = stat.mtimeMs;
  if (!stat.isDirectory()) return newest;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

function message(error) {
  return String(error?.message || error).split('\n')[0].slice(0, 200);
}

/* ---------------------------------------------------------------- rules */

/** A rule's answer; one that throws keeps its item and says why. */
function judge(rule, ...args) {
  try { return rule(...args); } catch (error) { return { target: false, why: `error: ${message(error)}` }; }
}

/**
 * (P) A project's local data goes once git holds what is worth keeping: its
 * row in project_log.md, no plan directory and its closeout, all on
 * origin/main, and no area for it on this machine. A project under
 * `~/mc/programs/` is archived with its CLOSEOUT.json beside its plan
 * (ruling 48): that file on this machine is its closeout, and a plan with
 * one beside it counts as no plan directory.
 */
export function projectPurge(item, facts) {
  if (facts.git_error) return { target: false, why: `git could not answer — ${facts.git_error}` };
  if (item.error) throw new Error(item.error);
  if (!item.in_log) return { target: false, why: 'not archived: no row in project_log.md on origin/main' };
  if (item.plan_on_main !== false) return { target: false, why: 'its plan directory is still on origin/main' };
  if (!item.closeout_on_main) return { target: false, why: 'no closeout on origin/main' };
  if (item.area_exists !== false) return { target: false, why: 'an area for it still exists' };
  return { target: true, why: `${item.project} is archived with its closeout on main` };
}

/**
 * (G) A planning session's transcripts: the newest of its directory stays,
 * and so does every one touched within `PROGRAMME_TRANSCRIPT_KEEP_MS`.
 */
export function programmeTranscript(item, group, now) {
  if (item.error) throw new Error(item.error);
  if (group.error) throw new Error(`a transcript beside it could not be read — ${group.error}`);
  if (group.newest === item) return { target: false, why: 'the newest of its directory' };
  if (!(item.mtime_ms <= now - PROGRAMME_TRANSCRIPT_KEEP_MS)) return { target: false, why: 'touched in the last 72 hours' };
  return { target: true, why: `older than 72 hours and not the newest of its directory (${group.area})` };
}

/** (X) A planning area's extra worktree, by the release verdict. */
export function planWorktree(item) {
  if (item.error) throw new Error(item.error);
  if (!item.verdict?.remove || item.verdict.what !== 'worktree and branch') {
    return { target: false, why: item.verdict?.why || 'not a git worktree' };
  }
  const pr = item.verdict.landed_by?.pr;
  return { target: true, why: pr ? `#${pr} merged at this tip` : 'its content is on main' };
}

/** (C) A compare tree: unused for a day and no dev server in it. */
export function compareWorktree(item, now) {
  if (item.error) throw new Error(item.error);
  if (item.live === null || item.live === undefined) throw new Error('could not tell whether a dev server runs in it');
  if (item.live) return { target: false, why: `a dev server runs in it (${item.live})` };
  if (!(item.last_used_ms <= now - COMPARE_KEEP_MS)) return { target: false, why: 'used in the last day' };
  if (!item.owner) throw new Error('no repository owns it');
  return { target: true, why: 'a mc shot --compare tree unused for a day, with no dev server' };
}

/** (L) T1–T5: a transcript neither P nor G claims. `rule` names which one answered. */
export function looseTranscript(item, { cutoff, days, root, newest }) {
  if (item.error) throw new Error(item.error);
  if (!item.cwd) return { target: false, why: 'no cwd in its head', rule: 'T1' };
  if (!(item.mtime_ms <= cutoff)) return { target: false, why: `touched in the last ${days} days`, rule: 'T2' };
  // T3: `null` is a stat that failed, not an absence.
  if (item.cwd_exists === null || item.cwd_exists === undefined) throw new Error('could not tell whether its directory exists');
  if (item.cwd_exists === false) return { target: true, why: 'its directory is gone', rule: 'T3' };
  const area = areaOf(item.cwd, root);
  if (area) {
    if (newest.get(area) === item) return { target: false, why: 'its workarea\'s latest', rule: 'T4' };
    return { target: true, why: `older than ${days} days and not ${area}'s latest`, rule: 'T4' };
  }
  return { target: false, why: 'outside the work root', rule: 'T5' };
}

/** (L) A `<uuid>/` left behind by an earlier delete. */
export function leftover(item, { cutoff, days }) {
  if (item.error) throw new Error(item.error);
  if (!(item.newest_ms <= cutoff)) return { target: false, why: `touched in the last ${days} days`, rule: 'recent' };
  return { target: true, why: 'left behind by an earlier delete', rule: 'leftover' };
}

/* ------------------------------------------------------------- deciding */

/**
 * The list, pure: `{ days, targets: [{ path, kind, rule, why, bytes }],
 * kept: [{ path, rule, why }] }`.
 */
export function tidyPlan(facts, { days = DEFAULT_DAYS } = {}) {
  const targets = [];
  const kept = [];
  const root = facts.work_root;
  const keep = (path, rule, why) => kept.push({ path, rule: why.startsWith('error: ') ? 'error' : rule, why });

  // (P)
  const purged = new Set();
  for (const item of facts.projects || []) {
    const verdict = judge(projectPurge, item, facts);
    if (!verdict.target) { keep(item.register_path, item.in_log ? 'P' : 'project', verdict.why); continue; }
    purged.add(item.project);
    // The register file last: a run cut short finds the project again.
    const files = [...item.files.filter((file) => file.kind !== 'register'), ...item.files.filter((file) => file.kind === 'register')];
    for (const file of files) targets.push({ path: file.path, kind: file.kind, rule: 'P', why: verdict.why, bytes: file.bytes || 0 });
  }

  const claimed = new Set();
  const transcripts = facts.transcripts || [];
  for (const item of transcripts) {
    // A project's areas are its step area and a legacy one; a planning, work
    // or deps area is never a project's.
    const area = item.error ? null : areaKindOf(areaOf(item.cwd, root) || '');
    if (area?.kind !== 'step' && area?.kind !== 'legacy') continue;
    const project = area.name;
    if (!purged.has(project)) continue;
    claimed.add(item);
    targets.push({ path: item.path, kind: 'transcript', rule: 'P', why: `a session of ${project}, which is archived`, bytes: item.bytes || 0 });
  }

  // (G) per `~/.claude/projects/<dir>`, its planning transcripts.
  const groups = new Map();
  for (const item of transcripts) {
    if (claimed.has(item) || item.error) continue;
    const area = areaOf(item.cwd, root);
    if (areaKindOf(area || '')?.kind !== 'plan') continue;
    const dir = dirname(item.path);
    if (!groups.has(dir)) groups.set(dir, { area, items: [], newest: null, error: null });
    groups.get(dir).items.push(item);
  }
  for (const item of transcripts) {
    // A transcript that could not be read in a directory of planning
    // transcripts may be the newest: then no other one is known not to be.
    if (item.error && groups.has(dirname(item.path))) groups.get(dirname(item.path)).error = item.error;
  }
  for (const group of groups.values()) {
    for (const item of group.items) if (!group.newest || item.mtime_ms > group.newest.mtime_ms) group.newest = item;
    for (const item of group.items) {
      claimed.add(item);
      const verdict = judge(programmeTranscript, item, group, facts.now);
      if (verdict.target) targets.push({ path: item.path, kind: 'transcript', rule: 'G', why: verdict.why, bytes: item.bytes || 0 });
      else keep(item.path, 'G', verdict.why);
    }
  }

  // (X), with the planning area's own checkouts kept.
  for (const item of facts.plan_checkouts || []) keep(item.path, 'plan-checkout', 'a planning area\'s own checkout');
  for (const item of facts.plan_worktrees || []) {
    const verdict = judge(planWorktree, item);
    if (verdict.target) targets.push({ path: item.path, kind: 'plan-worktree', rule: 'X', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'X', verdict.why);
  }

  // (W) and (S): never targets.
  for (const item of facts.work_areas || []) keep(item.path, 'work-area', 'only mc work release or discard removes a work area');
  for (const item of facts.step_areas || []) keep(item.path, 'step-area', 'the runner closes a step area when its project is done');
  // (R)
  for (const item of facts.foreign || []) keep(item.path, 'foreign-worktree', `a worktree of ${item.repo} outside ${root}`);
  // (C)
  for (const item of facts.compare_worktrees || []) {
    const verdict = judge(compareWorktree, item, facts.now);
    if (verdict.target) targets.push({ path: item.path, kind: 'compare-worktree', rule: 'C', why: verdict.why, bytes: item.bytes || 0, owner: item.owner });
    else keep(item.path, 'C', verdict.why);
  }

  // (L) T1–T5 and leftovers, unchanged, over what P and G left.
  const cutoff = facts.now - days * DAY_MS;
  const loose = transcripts.filter((item) => !claimed.has(item));
  const newest = new Map();
  for (const item of loose) {
    if (item.error || !item.cwd) continue;
    const area = areaOf(item.cwd, root);
    if (!area) continue;
    const best = newest.get(area);
    if (!best || item.mtime_ms > best.mtime_ms) newest.set(area, item);
  }
  for (const item of loose) {
    const verdict = judge(looseTranscript, item, { cutoff, days, root, newest });
    if (verdict.target) targets.push({ path: item.path, kind: 'transcript', rule: verdict.rule, why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, verdict.rule || 'error', verdict.why);
  }
  for (const item of facts.leftovers || []) {
    const verdict = judge(leftover, item, { cutoff, days });
    if (verdict.target) targets.push({ path: item.path, kind: 'leftover', rule: verdict.rule, why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, verdict.rule || 'error', verdict.why);
  }

  return { days, targets, kept };
}

/* ------------------------------------------------------------ executing */

function present(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

const realRemove = (path) => rmSync(path, { recursive: true });

/** `git worktree remove` in the owning repository, without `--force`: a tree with edits stays. */
const realRemoveWorktree = (owner, path) => realGit(owner, ['worktree', 'remove', path]) !== null;

/** `<stamp>` of a list file: `yyyymmddThhmmssZ`. */
function listStamp(now) {
  return new Date(now).toISOString().slice(0, 19).replace(/[-:]/gu, '') + 'Z';
}

/**
 * Why a target may not be removed where it stands, or null. Its realpath must
 * lie under the realpath of its kind's root, in the one shape that kind has.
 */
export function outsideRoots(target, roots) {
  const key = KIND_ROOT[target?.kind];
  if (!key || typeof target.path !== 'string') return `not a kind tidy removes: ${target?.kind}`;
  if (!roots[key]) return `no ${key} root in this layout`;
  const base = realpathSync(roots[key]);
  const real = realpathSync(target.path);
  if (!real.startsWith(`${base}/`)) return `not under ${roots[key]}`;
  const name = basename(real);
  const parent = dirname(real);
  const shaped = {
    register: parent === base && name.endsWith('.json'),
    'session-log': parent === base,
    'closed-log': parent === base,
    scratch: parent === base,
    transcript: dirname(parent) === base && SESSION_ID.test(TRANSCRIPT.exec(name)?.[1] || ''),
    leftover: dirname(parent) === base && SESSION_ID.test(name) && lstatSync(real).isDirectory(),
    // `<planAreaRoot>/<programme>/<worktree>`: `roots.plan` is `plan/` or `programs/` by the layout.
    'plan-worktree': dirname(parent) === base && !PLAN_CHECKOUTS.has(name),
    'compare-worktree': parent === base,
  }[target.kind];
  return shaped ? null : `not the shape a ${target.kind} has under ${roots[key]}`;
}

/**
 * The whole run: gather, decide, write the list, and with `apply` remove
 * from it. Returns `{ list, listPath, outcome }`; `outcome` is `applyTidy`'s.
 */
export function runTidy({ apply = false, days = DEFAULT_DAYS, env = process.env, now = Date.now(), write = writeJsonAtomic, ...doors } = {}) {
  const roots = tidyRoots(env);
  const plan = tidyPlan(gatherTidyFacts({ env, now, ...doors }), { days });
  const list = { at: new Date(now).toISOString(), rules_version: RULES_VERSION, days, targets: plan.targets, kept: plan.kept };
  let listPath = join(roots.tidy, `${listStamp(now)}.json`);
  for (let n = 2; present(listPath); n += 1) listPath = join(roots.tidy, `${listStamp(now)}-${n}.json`);
  write(listPath, list);
  if (!apply) return { list, listPath, outcome: null };
  const outcome = applyTidy({ listPath, env, now, write, ...doors });
  return { list: outcome.list, listPath, outcome };
}

/**
 * Remove what the list file at `listPath` names, and nothing else. Each
 * target is asked again first — its root, then its rule on facts read now —
 * and anything that does not answer yes is kept with the reason. What
 * happened is written back into the same file as `applied`.
 */
export function applyTidy({
  listPath, env = process.env, now = Date.now(), write = writeJsonAtomic,
  remove = realRemove, release = releaseWorktree, prune = pruneWorktrees, removeWorktree = realRemoveWorktree, ...doors
} = {}) {
  const roots = tidyRoots(env);
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  const targets = Array.isArray(list.targets) ? list.targets : [];
  const facts = gatherTidyFacts({ env, now, ...doors });
  const fresh = tidyPlan(facts, { days: Number.isInteger(list.days) && list.days >= 1 ? list.days : DEFAULT_DAYS });
  const holds = new Map(fresh.targets.map((item) => [item.path, item]));
  const keptNow = new Map(fresh.kept.map((item) => [item.path, item]));
  const worktrees = new Map((facts.plan_worktrees || []).map((item) => [item.path, item]));
  const compares = new Map((facts.compare_worktrees || []).map((item) => [item.path, item]));

  const applied = [];
  let freed = 0;
  // Register files last, so a run cut short finds the project again.
  const ordered = [...targets.filter((t) => t?.kind !== 'register'), ...targets.filter((t) => t?.kind === 'register')];
  for (const target of ordered) {
    const path = target?.path;
    try {
      const refused = outsideRoots(target, roots);
      if (refused) { applied.push({ path, ok: false, why: `refused: ${refused}` }); continue; }
      const again = holds.get(path);
      if (!again || again.rule !== target.rule || again.kind !== target.kind) {
        applied.push({ path, ok: false, why: `re-check: ${keptNow.get(path)?.why || 'the rule no longer holds'}` });
        continue;
      }
      if (target.kind === 'plan-worktree') {
        const wt = worktrees.get(path)?.wt;
        if (!wt || !release(wt)) { applied.push({ path, ok: false, why: 'git worktree remove refused' }); continue; }
      } else if (target.kind === 'compare-worktree') {
        // The owner read now, never the one the list file names.
        const owner = compares.get(path)?.owner;
        if (!owner || !removeWorktree(owner, path)) { applied.push({ path, ok: false, why: 'git worktree remove refused' }); continue; }
      } else if (target.kind === 'transcript') {
        const sibling = join(dirname(path), TRANSCRIPT.exec(basename(path))[1]);
        remove(path);
        if (present(sibling) && !outsideRoots({ kind: 'leftover', path: sibling }, roots)) remove(sibling);
      } else {
        remove(path);
      }
      if (present(path)) { applied.push({ path, ok: false, why: 'still there' }); continue; }
      freed += again.bytes || 0;
      applied.push({ path, ok: true, why: target.why });
    } catch (error) {
      applied.push({ path, ok: false, why: `error: ${message(error)}` });
    }
  }

  // git's own bookkeeping for worktrees that are gone, on both repositories.
  try { prune((doors.repos || defaultRepos(env)).map((repo) => repo.path)); } catch { /* git keeps its registrations */ }
  pruneLists(roots, { keep: listPath, remove });

  const done = { ...list, applied };
  write(listPath, done);
  const removed = applied.filter((item) => item.ok).length;
  const kept = applied.length - removed;
  log('tidy', { removed, kept, bytes: freed });
  return { list: done, applied, freed, removed, kept };
}

/** The newest `LIST_KEEP` list files stay, `keep` among them; older ones go. */
function pruneLists(roots, { keep, remove }) {
  const names = listNames(roots.tidy).filter((name) => LIST_FILE.test(name)).sort();
  const keepName = basename(keep);
  const old = names.filter((name) => name !== keepName).slice(0, Math.max(0, names.length - LIST_KEEP));
  for (const name of old) {
    try {
      const real = realpathSync(join(roots.tidy, name));
      if (dirname(real) === realpathSync(roots.tidy)) remove(real);
    } catch { /* kept: the next apply tries again */ }
  }
}

/** `~/mc/x` rather than `/Users/…/mc/x`. */
export function shortPath(path, home = homedir()) {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

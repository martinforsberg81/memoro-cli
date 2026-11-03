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
 *   - (U) A step area under the step root, left from the project steps that
 *     went on 2026-11-03 (goal mc/projects-to-goals) — nothing closes one any
 *     more — is judged as (W) is, by the same `person` rule; one left directly
 *     under `~/mc` is only listed.
 *   - (W) What is left under `~/mc/work/` — the workareas, retired on
 *     2026-11-03 (goal mc/no-work) — is listed, every one, with why it stays
 *     or why it may go. One goes only when every checkout in it is a worktree
 *     with nothing uncommitted whose branch has landed (`releaseVerdict`), it
 *     holds nothing else, and no process stands in it — and only when a
 *     person runs `mc tidy --apply` (`person`): the runner's daily apply
 *     lists them and removes none.
 *   - (C) `mc shot --compare`'s trees under `~/.memoro/mc/compare/`
 *     (`shot-compare.js`) go when unused for a day — by the directory's
 *     mtime, which `compareTree` touches on every reuse — and no dev server
 *     runs in them, through `git worktree remove` in the repository that
 *     owns each one.
 *   - (I) A planning area's own checkouts (`memoro/`, `memoro-cli/`) go when
 *     their programme has no goal that is not finished, judged as (X) judges an
 *     extra worktree. `mc plan` adds them back when it next opens the programme.
 *   - (K) A slug directory under `~/mc/gate-cache/`, `~/mc/gate/` or
 *     `~/.memoro/mc/selection/` that no repository mc knows hashes to — a
 *     repository's path moved and left it — goes when untouched for a day and no
 *     process stands in it, through `rmTree`. A known one is never judged.
 *   - (A) A `~/mc/gate-cache/<slug>/<key>/` entry under a slug a repository mc knows has goes when no round has used it for fourteen days
 *     (`meta.at`), and a `<key>.tmp-<pid>` staging directory once it is a day old, through `rmTree`. The dependency cache is bounded by
 *     count (`prepare-cache.js`); this bounds it by age too.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mergedPullAtTip } from './branch-landed.js';
import { defaultRepos } from './brief-collect.js';
import { run as runGit } from './git.js';
import { repoFileSlug } from './repo-snapshot.js';
import { repositoryDir } from './repos.js';
import { SESSION_ID, claudeHome, readHead, treeBytes } from './conversations.js';
import { FINISHED, GOAL_FILE, GOALS_DIR, parseGoal } from './goals.js';
import { log } from './logger.js';
import {
  PLAN_HOME, PROGRAMS_HOME, RUNNER_DEPS, RUNNER_STEP, STEP_HOME, WORK_HOME, areaKindOf, areaOfPath, mcHome,
  planAreaRoot, runnerDir, stepAreaRoot, workGateCachePath, workGatePath, workRoot,
} from './paths.js';
import { PREPARE_CACHE_MAX_AGE_MS } from './prepare-cache.js';
import { rmTree } from './rm-tree.js';
import { cwdsOfUser, processesStandingIn } from './standing.js';
import { serversFor } from './test-environment.js';
import {
  inspectWorktree, listStepAreas, pruneWorktrees, releaseVerdict, releaseWorktree,
} from './work-area.js';

export const DEFAULT_DAYS = 14;
export const RULES_VERSION = 7;
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
/** mc's own files in a workarea: never what keeps one, and gone with it. */
const WORK_AREA_OWN = new Set(['.mc.json', '.mc-role', '.mc-stopped', '.DS_Store']);
/** Keeps that are the ordinary case, left out of the printout. */
export const ROUTINE = new Set(['T1', 'T2', 'T5', 'recent', 'plan-checkout', 'G', 'K', 'A']);

/** Every root tidy reads, by name. A kind removes only under its own. */
export function tidyRoots(env = process.env) {
  const root = workRoot(env);
  const runner = runnerDir(env);
  return {
    root,
    plan: planAreaRoot({ root }),
    step: stepAreaRoot({ root }),
    work: join(root, WORK_HOME),
    tidy: join(runner, 'tidy'),
    claude: join(claudeHome(env), 'projects'),
    compare: join(mcHome(env), 'compare'),
    // The gate's dependency cache, the gate's own directory and the selection state: each holds a directory per repository slug (K).
    gate_cache: workGateCachePath(env),
    gate: workGatePath(env),
    selection: join(mcHome(env), 'selection'),
  };
}

/** The root each kind of target must lie under, by `tidyRoots` key. */
const KIND_ROOT = {
  transcript: 'claude',
  leftover: 'claude',
  'plan-checkout': 'plan',
  'plan-worktree': 'plan',
  'work-area': 'work',
  'orphan-step-area': 'step',
  'compare-worktree': 'compare',
  'gate-cache-slug': 'gate_cache',
  'gate-slug': 'gate',
  'selection-slug': 'selection',
  'gate-cache-entry': 'gate_cache',
};

/** The roots whose directories are named by a repository's slug, and the kind of target each one holds (K). */
const SLUG_ROOTS = [['gate_cache', 'gate-cache-slug'], ['gate', 'gate-slug'], ['selection', 'selection-slug']];

/** The directories directly under `dir`: none when it cannot be read. */
function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch { return []; }
}

/**
 * The slugs a repository mc knows has: `repoFileSlug` of its bare path and of its checkout. A slug that is none of them is one a move left.
 */
function knownSlugs(repos) {
  const known = new Set();
  for (const repo of repos) for (const path of [repo.path, repo.checkout]) if (path) known.add(repoFileSlug(path));
  return known;
}

/** The `at` a store or a hit wrote into a gate-cache entry's meta.json: null when there is none, or it cannot be read. */
function entryUsedAt(path) {
  try { return Number(JSON.parse(readFileSync(join(path, 'meta.json'), 'utf8')).at) || null; } catch { return null; }
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
    const r = runGit(undefined, ['-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return r.error || r.status !== 0 ? null : r.stdout;
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
    plan_checkouts: [], plan_worktrees: [],
    work_areas: [], step_areas: [], foreign: [], compare_worktrees: [], transcripts: [], leftovers: [], cache_slugs: [], gate_cache_entries: [],
  };

  // One lsof for every plan worktree. It always sees this process, so an
  // empty answer is lsof failing — and then nothing can be said to be unused.
  let running = null;
  try { running = cwds(); } catch { running = null; }
  if (running && running.length === 0) running = null;
  const tip = pullAtTip || ((wt) => mergedPullAtTip(wt.path, wt.branch, gh ? { gh } : {}));
  for (const programme of listNames(roots.plan)) {
    const area = join(roots.plan, programme);
    const active = programmeHasOpenGoal(area);
    for (const name of listNames(area)) {
      const path = join(area, name);
      if (!present(join(path, '.git'))) continue;
      if (PLAN_CHECKOUTS.has(name)) {
        // (I) asks who stands anywhere in the programme's directory: a planning session stands there, not in the checkout.
        const item = { path, programme, name, active, wt: null, verdict: null, bytes: 0 };
        facts.plan_checkouts.push(item);
        try {
          if (!running) throw new Error('lsof could not say who stands in it');
          const wt = inspect(path, name);
          if (!wt.is_git) throw new Error('not a git worktree');
          item.wt = wt;
          const pids = [...new Set(processesStandingIn([area], { cwds: running }).map((p) => p.pid))];
          item.verdict = releaseVerdict(wt, { inUse: [...new Set(pids.map(command))], pullAtTip: tip });
          if (idlePlanCheckout(item).target) item.bytes = treeBytes(path);
        } catch (error) { item.error = message(error); }
        continue;
      }
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

  // (W) and (U): an area read the way the release verdict reads one — its
  // checkouts, whatever else it holds, and who stands in it.
  const readArea = (item) => {
    try {
      if (!running) throw new Error('lsof could not say who stands in it');
      for (const entry of readdirSync(item.path, { withFileTypes: true })) {
        if (WORK_AREA_OWN.has(entry.name)) continue;
        const child = join(item.path, entry.name);
        if (!entry.isDirectory() || !present(join(child, '.git'))) { item.others.push(entry.name); continue; }
        const wt = inspect(child, entry.name);
        if (!wt.is_git) { item.others.push(entry.name); continue; }
        const pids = [...new Set(processesStandingIn([child], { cwds: running }).map((p) => p.pid))];
        item.worktrees.push({ path: child, repo: entry.name, wt, verdict: releaseVerdict(wt, { inUse: [...new Set(pids.map(command))], pullAtTip: tip }) });
      }
      item.live = [...new Set(processesStandingIn([item.path], { cwds: running }).map((p) => p.pid))];
      if (workArea(item, { person: true }).target) item.bytes = treeBytes(item.path);
    } catch (error) { item.error = message(error); }
    return item;
  };
  // (W) every directory under `~/mc/work/`.
  for (const name of listNames(roots.work)) {
    facts.work_areas.push(readArea({ path: join(roots.work, name), name, worktrees: [], others: [], live: null, bytes: 0 }));
  }
  // (U) every step area, left from the retired project steps: one under the
  // step root is read as (W) is; one directly under `~/mc` is only listed.
  for (const area of listStepAreas({ root })) {
    if (dirname(area.path) !== roots.step) { facts.step_areas.push({ path: area.path, name: area.name, legacy: true }); continue; }
    facts.step_areas.push(readArea({ path: area.path, name: area.name, legacy: false, worktrees: [], others: [], live: null, bytes: 0 }));
  }

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

  // (K) The slug directories of the gate, its dependency cache and the selection state. A slug is the hash of a repository's path
  // (`repoFileSlug`), so one that no repository mc knows hashes to is what a move left. A known one is kept whatever its age, and
  // its tree is not walked.
  const known = knownSlugs(repos);
  for (const [key, kind] of SLUG_ROOTS) {
    for (const name of listDirs(roots[key])) {
      const path = join(roots[key], name);
      // A gate's `<slug>-freshen` is known by its `<slug>`.
      const isKnown = known.has(key === 'gate' ? name.replace(/-freshen$/u, '') : name);
      const item = { path, kind, slug: name, known: isKnown, live: null, newest_ms: null, bytes: 0 };
      facts.cache_slugs.push(item);
      if (isKnown) continue;
      try {
        if (!running) throw new Error('lsof could not say who stands in it');
        item.newest_ms = newestMtime(path);
        item.live = [...new Set(processesStandingIn([path], { cwds: running }).map((p) => p.pid))];
        if (!orphanSlug(item, now).target) continue;
        item.bytes = treeBytes(path);
      } catch (error) { item.error = message(error); }
    }
  }

  // (A) The entries of the gate's dependency cache under a slug a repository mc knows has: an unknown slug is (K)'s whole. An entry is
  // judged by its last use, `meta.at` (a hit renews it) or without a meta the directory's own mtime — never by walking it. Only an entry
  // the rule takes is weighed.
  for (const name of listDirs(roots.gate_cache)) {
    if (!known.has(name)) continue;
    for (const key of listDirs(join(roots.gate_cache, name))) {
      const path = join(roots.gate_cache, name, key);
      const item = { path, key, staging: key.includes('.tmp-'), at: null, newest_ms: null, bytes: 0 };
      facts.gate_cache_entries.push(item);
      try {
        item.at = entryUsedAt(path);
        item.newest_ms = statSync(path).mtimeMs;
        if (staleGateCacheEntry(item, now).target) item.bytes = treeBytes(path);
      } catch (error) { item.error = message(error); }
    }
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

/**
 * Whether a programme has a goal that is not finished: a `goals/<goal>/GOAL.json`
 * whose status is not done or dropped. One that cannot be read or parsed counts
 * as not finished.
 */
function programmeHasOpenGoal(area) {
  const goals = join(area, GOALS_DIR);
  for (const goal of listNames(goals)) {
    const file = join(goals, goal, GOAL_FILE);
    if (!present(file)) continue;
    let parsed = null;
    try { parsed = parseGoal(readFileSync(file, 'utf8')); } catch { return true; }
    if (parsed?.problems || !FINISHED.includes(parsed?.stage)) return true;
  }
  return false;
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

/** (I) A planning area's own checkout: idle once its programme has no goal that is not finished. */
export function idlePlanCheckout(item) {
  if (item.error) throw new Error(item.error);
  if (item.active) return { target: false, why: 'its programme has a goal that is not finished' };
  if (!item.verdict?.remove || item.verdict.what !== 'worktree and branch') {
    return { target: false, why: item.verdict?.why || 'not a git worktree' };
  }
  return { target: true, why: 'its programme has no goal that is not finished; mc plan adds it back' };
}

/**
 * (W) A directory under `~/mc/work/`, left from the retired workareas. It may
 * go when every checkout in it may (`releaseVerdict`: nothing uncommitted,
 * its branch's content on main), it holds nothing else, and no process stands
 * in it — and then only for a person (`person`): the runner's apply keeps it.
 */
export function workArea(item, { person = false, label = 'a retired workarea' } = {}) {
  if (item.error) throw new Error(item.error);
  if (item.live === null || item.live === undefined) throw new Error('could not tell whether a process stands in it');
  if (item.live.length) return { target: false, why: `process ${item.live.join(', ')} stands in it` };
  if (item.others.length) {
    const named = item.others.slice(0, 3).join(', ');
    return { target: false, why: `it holds more than checkouts: ${named}${item.others.length > 3 ? ` and ${item.others.length - 3} more` : ''}` };
  }
  for (const worktree of item.worktrees) {
    if (!worktree.verdict?.remove || worktree.verdict.what !== 'worktree and branch') {
      return { target: false, why: `${worktree.repo}: ${worktree.verdict?.why || 'not a git worktree'}` };
    }
  }
  const what = item.worktrees.length
    ? `${item.worktrees.map((worktree) => worktree.repo).join(', ')} landed with nothing uncommitted`
    : 'nothing in it';
  if (!person) return { target: false, why: `${label} that could go (${what}) — only a person's mc tidy --apply removes one` };
  return { target: true, why: `${label}: ${what}` };
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

/**
 * (K) A slug directory no repository mc knows hashes to: untouched for a day,
 * with no process standing in it. A known slug is never a target.
 */
export function orphanSlug(item, now) {
  if (item.error) throw new Error(item.error);
  if (item.known) return { target: false, why: 'a repository mc knows uses it' };
  if (item.live === null || item.live === undefined) throw new Error('could not tell whether a process stands in it');
  if (item.live.length) return { target: false, why: `process ${item.live.join(', ')} stands in it` };
  if (typeof item.newest_ms !== 'number') throw new Error('could not tell when it was last touched');
  if (!(item.newest_ms <= now - DAY_MS)) return { target: false, why: 'touched in the last day' };
  return { target: true, why: `no repository mc knows has the slug ${item.slug}` };
}

/** (L) T1–T5: a transcript G does not claim. `rule` names which one answered. */
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

/**
 * (A) A gate-cache entry no round has used for fourteen days, and a staging
 * directory `<key>.tmp-<pid>` a killed store left, once it is a day old. A
 * store that is running renews its staging directory's mtime as it writes, so
 * a fresh one is kept. A time that cannot be read throws, and the item is kept.
 */
export function staleGateCacheEntry(item, now) {
  if (item.error) throw new Error(item.error);
  if (item.staging) {
    if (typeof item.newest_ms !== 'number') throw new Error('could not tell when it was last touched');
    if (!(item.newest_ms <= now - DAY_MS)) return { target: false, why: 'a store may be running' };
    return { target: true, why: 'a store that never finished' };
  }
  const used = item.at ?? item.newest_ms;
  if (typeof used !== 'number') throw new Error('could not tell when it was last used');
  if (!(used <= now - PREPARE_CACHE_MAX_AGE_MS)) return { target: false, why: 'used in the last 14 days' };
  return { target: true, why: `no round has used it for ${Math.floor((now - used) / DAY_MS)} days` };
}

/* ------------------------------------------------------------- deciding */

/**
 * The list, pure: `{ days, targets: [{ path, kind, rule, why, bytes }],
 * kept: [{ path, rule, why }] }`.
 */
export function tidyPlan(facts, { days = DEFAULT_DAYS, person = false } = {}) {
  const targets = [];
  const kept = [];
  const root = facts.work_root;
  const keep = (path, rule, why) => kept.push({ path, rule: why.startsWith('error: ') ? 'error' : rule, why });

  const claimed = new Set();
  const transcripts = facts.transcripts || [];

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

  // (I) a planning area's own checkouts, then (X) its extra worktrees.
  for (const item of facts.plan_checkouts || []) {
    const verdict = judge(idlePlanCheckout, item);
    if (verdict.target) targets.push({ path: item.path, kind: 'plan-checkout', rule: 'I', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'plan-checkout', verdict.why);
  }
  for (const item of facts.plan_worktrees || []) {
    const verdict = judge(planWorktree, item);
    if (verdict.target) targets.push({ path: item.path, kind: 'plan-worktree', rule: 'X', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'X', verdict.why);
  }

  // (W) every retired workarea, listed with its verdict.
  for (const item of facts.work_areas || []) {
    const verdict = judge(workArea, item, { person });
    if (verdict.target) targets.push({ path: item.path, kind: 'work-area', rule: 'W', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'W', verdict.why);
  }
  // (U) a step area left from the retired project steps is judged as (W) is —
  // and one left directly under `~/mc` is only listed.
  for (const item of facts.step_areas || []) {
    if (item.legacy) { keep(item.path, 'U', 'a step area left from the retired project steps, directly under ~/mc: a person removes it'); continue; }
    const verdict = judge(workArea, item, { person, label: 'a step area left from the retired project steps' });
    if (verdict.target) targets.push({ path: item.path, kind: 'orphan-step-area', rule: 'U', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'U', verdict.why.startsWith('a step area') ? verdict.why : `a step area left from the retired project steps; ${verdict.why}`);
  }
  // (R)
  for (const item of facts.foreign || []) keep(item.path, 'foreign-worktree', `a worktree of ${item.repo} outside ${root}`);
  // (C)
  for (const item of facts.compare_worktrees || []) {
    const verdict = judge(compareWorktree, item, facts.now);
    if (verdict.target) targets.push({ path: item.path, kind: 'compare-worktree', rule: 'C', why: verdict.why, bytes: item.bytes || 0, owner: item.owner });
    else keep(item.path, 'C', verdict.why);
  }

  // (K) the slug directories no repository mc knows has, judged as orphanSlug judges them.
  for (const item of facts.cache_slugs || []) {
    const verdict = judge(orphanSlug, item, facts.now);
    if (verdict.target) targets.push({ path: item.path, kind: item.kind, rule: 'K', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'K', verdict.why);
  }

  // (A) the entries of the gate's dependency cache under a known slug, by their last use. A round that is cloning an entry as it is
  // removed falls back to `npm ci` (prepare-cache.js), which is why no lock is taken here.
  for (const item of facts.gate_cache_entries || []) {
    const verdict = judge(staleGateCacheEntry, item, facts.now);
    if (verdict.target) targets.push({ path: item.path, kind: 'gate-cache-entry', rule: 'A', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'A', verdict.why);
  }

  // (L) T1–T5 and leftovers, unchanged, over what G left.
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

  return { days, person, targets, kept };
}

/* ------------------------------------------------------------ executing */

function present(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Read-only files and all (rm-tree.js): a gate-cache tree a session's `deps:ensure` made read-only still goes. */
const realRemove = (path) => { if (!rmTree(path)) throw new Error('could not remove it'); };

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
    transcript: dirname(parent) === base && SESSION_ID.test(TRANSCRIPT.exec(name)?.[1] || ''),
    leftover: dirname(parent) === base && SESSION_ID.test(name) && lstatSync(real).isDirectory(),
    // `<planAreaRoot>/<programme>/<worktree>`: `roots.plan` is `plan/` or `programs/` by the layout.
    'plan-checkout': dirname(parent) === base && PLAN_CHECKOUTS.has(name),
    'plan-worktree': dirname(parent) === base && !PLAN_CHECKOUTS.has(name),
    'work-area': parent === base,
    'orphan-step-area': parent === base,
    'compare-worktree': parent === base,
    'gate-cache-slug': parent === base,
    'gate-slug': parent === base,
    'selection-slug': parent === base,
    // `<gate-cache>/<slug>/<key>`: two levels down, as the entry of a repository's cache.
    'gate-cache-entry': dirname(parent) === base,
  }[target.kind];
  return shaped ? null : `not the shape a ${target.kind} has under ${roots[key]}`;
}

/**
 * The whole run: gather, decide, write the list, and with `apply` remove
 * from it. Returns `{ list, listPath, outcome }`; `outcome` is `applyTidy`'s.
 */
export function runTidy({
  apply = false, days = DEFAULT_DAYS, person = false, env = process.env, now = Date.now(), write = writeJsonAtomic, ...doors
} = {}) {
  const roots = tidyRoots(env);
  const plan = tidyPlan(gatherTidyFacts({ env, now, ...doors }), { days, person });
  const list = { at: new Date(now).toISOString(), rules_version: RULES_VERSION, days, person, targets: plan.targets, kept: plan.kept };
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
  const fresh = tidyPlan(facts, { days: Number.isInteger(list.days) && list.days >= 1 ? list.days : DEFAULT_DAYS, person: list.person === true });
  const holds = new Map(fresh.targets.map((item) => [item.path, item]));
  const keptNow = new Map(fresh.kept.map((item) => [item.path, item]));
  const worktrees = new Map([...(facts.plan_worktrees || []), ...(facts.plan_checkouts || [])].map((item) => [item.path, item]));
  const workAreas = new Map([...(facts.work_areas || []), ...(facts.step_areas || []).filter((item) => item.worktrees)].map((item) => [item.path, item]));
  const compares = new Map((facts.compare_worktrees || []).map((item) => [item.path, item]));

  const applied = [];
  let freed = 0;
  for (const target of targets) {
    const path = target?.path;
    try {
      const refused = outsideRoots(target, roots);
      if (refused) { applied.push({ path, ok: false, why: `refused: ${refused}` }); continue; }
      const again = holds.get(path);
      if (!again || again.rule !== target.rule || again.kind !== target.kind) {
        applied.push({ path, ok: false, why: `re-check: ${keptNow.get(path)?.why || 'the rule no longer holds'}` });
        continue;
      }
      if (target.kind === 'plan-worktree' || target.kind === 'plan-checkout') {
        const wt = worktrees.get(path)?.wt;
        if (!wt || !release(wt)) { applied.push({ path, ok: false, why: 'git worktree remove refused' }); continue; }
      } else if (target.kind === 'work-area' || target.kind === 'orphan-step-area') {
        // Its checkouts read now, each handed back to git without --force —
        // git refuses one that changed since — and then the directory.
        const item = workAreas.get(path);
        const refused = (item?.worktrees || []).find((worktree) => !release(worktree.wt));
        if (!item || refused) { applied.push({ path, ok: false, why: `git worktree remove refused${refused ? ` for ${refused.repo}` : ''}` }); continue; }
        remove(path);
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

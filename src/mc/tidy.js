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
 *   - (I) A planning area's own checkouts (`memoro/`, `memoro-cli/`) go when no
 *     planning session of their programme is running (a foreground `mc plan`, or
 *     a process standing in the programme's directory) and they have been
 *     untouched for 72 hours (younger only in pressure), judged as (X) judges an
 *     extra worktree: nothing uncommitted and nothing main lacks. `mc plan` adds
 *     them back.
 *   - (P) A clean inactive registered goal checkout may go after 72 hours
 *     (younger only in pressure) when its goal cannot start a build or review
 *     session now: in `stage: draft`, or with `status: Martin`, or in a phase
 *     above its programme's lowest unfinished phase (`phaseOpen`). A goal with
 *     `status: blocked` keeps its checkout. Clean means no tracked, untracked
 *     or ignored entry, except the `node_modules/` dependency link the runner
 *     attaches (it carries `.memoro-deps.json` and is re-attached at the next
 *     session); any other ignored entry keeps the checkout. Its branch and goal directory stay,
 *     and the runner re-adds the checkout on that branch when it next needs it.
 *   - (K) A slug directory under `~/mc/gate-cache/`, `~/mc/gate/` or
 *     `~/.memoro/mc/selection/` that no repository mc knows hashes to — a
 *     repository's path moved and left it — goes when untouched for a day and no
 *     process stands in it, through `rmTree`. A known one is never judged.
 *   - (A) A `~/mc/gate-cache/<slug>/<key>/` entry under a slug a repository mc knows has goes when no round has used it for fourteen days
 *     (`meta.at`), and a `<key>.tmp-<pid>` staging directory once it is a day old, through `rmTree`. The dependency cache is bounded by
 *     count (`prepare-cache.js`); this bounds it by age too.
 *   - (S) Inside a runner session's scratch directory
 *     (`~/mc/runner/scratch/<stem>/`), a git worktree and a `DerivedData`
 *     directory are the two things that may go, and only when the directory's
 *     ownership record (`.mc-scratch.json`, written by the runner when it made
 *     it) says its session has ended, or records no end while the runner that
 *     owned it is gone (its `runner_pid` is not alive, or now runs something
 *     other than `mc run`). In both cases no process stands in it or holds a
 *     file open in the candidate, and — for a worktree — nothing is uncommitted
 *     and its HEAD is on a branch or tag, or retained first. Logs, patches and
 *     everything else in the directory stay. A directory with no record is
 *     legacy and is kept: its age says nothing about whether it is idle. A
 *     session whose runner is alive and has recorded no end is kept.
 *   - (B) Exact rebuildable caches (tidy-caches.js): five native-phone output
 *     paths in ended runner scratch whose owning goal has finished, idle worker bundles, and four
 *     named per-user caches. Shared caches/bundles retain 72 hours. Every
 *     removal rechecks ownership, process/open-file evidence and tree identity.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mergedPullAtTip } from './branch-landed.js';
import { defaultRepos } from './brief-collect.js';
import { run as runGit } from './git.js';
import { repoFileSlug } from './repo-snapshot.js';
import { repositoryDir } from './repos.js';
import { SESSION_ID, claudeHome, readHead, treeBytes } from './conversations.js';
import { currentPhase, FINISHED, GOAL_FILE, GOALS_DIR, parseGoal, phaseOpen, programsGoals } from './goals.js';
import { log } from './logger.js';
import {
  PLAN_HOME, PROGRAMS_HOME, RUNNER_DEPS, RUNNER_STEP, STEP_HOME, WORK_HOME, areaKindOf, areaOfPath, mcHome,
  planAreaRoot, runnerDir, runnerScratchDir, stepAreaRoot, workGateCachePath, workGatePath, workRoot,
} from './paths.js';
import { PREPARE_CACHE_MAX_AGE_MS } from './prepare-cache.js';
import { rmTree } from './rm-tree.js';
import { ATTACHED_MARK } from './shared-deps.js';
import { realLock } from './runner-lock.js';
import { CACHE_KIND_ROOT, cachePathAllowed, gatherCacheFacts, rebuildableCache } from './tidy-caches.js';
import { cwdsOfUser, processesStandingIn } from './standing.js';
import { pidAlive } from './status-collect.js';
import { serversFor } from './test-environment.js';
import {
  inspectWorktree, listStepAreas, pruneWorktrees, releaseVerdict, releaseWorktree,
} from './work-area.js';

export const DEFAULT_DAYS = 14;
export const RULES_VERSION = 11;
export const GENERATED_KEEP_MS = 72 * 60 * 60 * 1000;
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
const HOUR_MS = 60 * 60 * 1000;
const TRANSCRIPT = /^(.+)\.jsonl$/u;
const LIST_FILE = /^\d{8}T\d{6}Z(-\d+)?\.json$/u;
/** A planning area's own checkouts: never a target. */
const PLAN_CHECKOUTS = new Set(['memoro', 'memoro-cli']);
/** mc's own files in a workarea: never what keeps one, and gone with it. */
const WORK_AREA_OWN = new Set(['.mc.json', '.mc-role', '.mc-stopped', '.DS_Store']);
/** Keeps that are the ordinary case, left out of the printout. */
export const ROUTINE = new Set(['T1', 'T2', 'T5', 'recent', 'plan-checkout', 'G', 'K', 'A', 'S', 'B']);
/** The ownership record the runner writes into each session's scratch directory (`run.js`). */
export const SCRATCH_MARKER = '.mc-scratch.json';
export const SCRATCH_SCHEMA = 'mc-scratch';
/** The one name under a scratch directory that is rebuildable whole. */
const DERIVED_DATA = 'DerivedData';

/** Every root tidy reads, by name. A kind removes only under its own. */
export function tidyRoots(env = process.env) {
  const root = workRoot(env);
  const runner = runnerDir(env);
  return {
    root,
    mc_home: mcHome(env),
    user_library: join(env.HOME || homedir(), 'Library'),
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
    // A runner session's scratch directories (S): `~/mc/runner/scratch/<stem>/`.
    scratch: runnerScratchDir(env),
    wrangler_logs: join(env.HOME || homedir(), 'Library', 'Preferences', '.wrangler', 'logs'),
    shots: join(mcHome(env), 'shots'),
    codex_images: join(env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images'),
  };
}

/** The root each kind of target must lie under, by `tidyRoots` key. */
const KIND_ROOT = {
  ...CACHE_KIND_ROOT,
  transcript: 'claude',
  leftover: 'claude',
  'plan-checkout': 'plan',
  'plan-worktree': 'plan',
  'plan-goal-worktree': 'plan',
  'work-area': 'work',
  'orphan-step-area': 'step',
  'compare-worktree': 'compare',
  'gate-cache-slug': 'gate_cache',
  'gate-slug': 'gate',
  'selection-slug': 'selection',
  'gate-cache-entry': 'gate_cache',
  'scratch-worktree': 'scratch',
  'scratch-derived': 'scratch',
  'wrangler-log': 'wrangler_logs',
  'mc-shot': 'shots',
  'codex-image': 'codex_images',
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
  inspect = inspectWorktree, pullAtTip = null, repos = defaultRepos(env), command = commandOf, readDir = readdirSync,
  servers = serversFor, openIn = openFilesIn, filesOpen = openFilesAmong, alive = pidAlive, commandLine = commandLineOf,
} = {}) {
  const roots = tidyRoots(env);
  const root = roots.root;
  const facts = {
    now, work_root: root, projects_root: roots.claude, roots,
    plan_checkouts: [], plan_worktrees: [], goal_worktrees: [],
    work_areas: [], step_areas: [], foreign: [], compare_worktrees: [], transcripts: [], leftovers: [], cache_slugs: [], gate_cache_entries: [],
    scratch_items: [], generated_files: [], cache_items: [],
  };

  // One lsof for every plan worktree. It always sees this process, so an
  // empty answer is lsof failing — and then nothing can be said to be unused.
  let running = null;
  try { running = cwds(); } catch { running = null; }
  if (running && (running.length === 0 || running.complete === false)) running = null;
  const tip = pullAtTip || ((wt) => mergedPullAtTip(wt.path, wt.branch, gh ? { gh } : {}));
  const plansRunning = runningPlanSessions(roots.root);
  for (const programme of listNames(roots.plan)) {
    const area = join(roots.plan, programme);
    for (const name of listNames(area)) {
      const path = join(area, name);
      if (!present(join(path, '.git'))) continue;
      if (PLAN_CHECKOUTS.has(name)) {
        // (I) asks who stands anywhere in the programme's directory: a planning session stands there, not in the checkout.
        const item = { path, programme, name, active: null, wt: null, verdict: null, activity: null, bytes: 0 };
        facts.plan_checkouts.push(item);
        try {
          if (!running) throw new Error('lsof could not say who stands in it');
          const wt = inspect(path, name);
          if (!wt.is_git) throw new Error('not a git worktree');
          item.wt = wt;
          const pids = [...new Set(processesStandingIn([area], { cwds: running }).map((p) => p.pid))];
          const names = [...new Set(pids.map(command))];
          item.verdict = releaseVerdict(wt, { inUse: names, pullAtTip: tip });
          item.active = names.length ? `in use by ${names.join(', ')}` : plansRunning.get(programme) ?? null;
          // Weighed and last touched only where the rule might release it: the age is judged by the rule.
          if (!item.active && item.verdict.remove) { item.activity = newestMtime(path); item.bytes = treeBytes(path); }
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

  // (P) Registered goal checkouts still in draft. Unlike programme planning
  // worktrees, these retain their branch and the goal directory when released.
  gatherPlanGoalWorktrees(facts, { roots, running, now, git, repos, openIn, command });

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

  // (S) A runner session's scratch directory: its record read once, its worktrees and DerivedData judged.
  for (const stem of listNames(roots.scratch)) {
    const dir = join(roots.scratch, stem);
    let marker = null;
    let markerError = null;
    let markerAbsent = false;
    try {
      if (!lstatSync(join(dir, SCRATCH_MARKER)).isFile()) throw new Error('not a regular file');
      const value = JSON.parse(readFileSync(join(dir, SCRATCH_MARKER), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      marker = value;
    } catch (error) {
      if (error?.code === 'ENOENT') markerAbsent = true;
      else markerError = message(error);
    }
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const worktree = present(join(path, '.git'));
      if (!worktree && entry.name !== DERIVED_DATA) continue;
      const item = {
        path, stem, session_dir: dir, marker, marker_error: markerError, marker_absent: markerAbsent,
        kind: worktree ? 'scratch-worktree' : 'scratch-derived', live: null, open: null,
        dirty: null, refs: null, owner: null, head: null, evidence: null, identity: null, bytes: 0, runner_gone: null,
      };
      facts.scratch_items.push(item);
      try {
        if (markerError || (!marker && !markerAbsent)) continue;
        if (marker && !marker.ended) {
          item.runner_gone = runnerGone(marker, { alive, commandLine });
          if (!item.runner_gone) continue;
        }
        if (!running) throw new Error('lsof could not say who stands in it');
        item.live = [...new Set(processesStandingIn([dir], { cwds: running }).map((p) => p.pid))];
        if (item.live.length) continue;
        if (!marker) {
          if (!worktree) continue; // Marker-less DerivedData is never adopted.
          item.evidence = legacySessionEvidence(stem, env);
          item.open = openIn(dir);
          if (!Array.isArray(item.open)) throw new Error('could not tell whether a file in its scratch session is open');
          if (item.open.length) continue;
        }
        if (worktree) {
          const status = git(path, ['status', '--porcelain', '--untracked-files=all']);
          if (status === null) throw new Error('git status could not be read');
          item.dirty = status.trim() ? status.trim().split('\n').length : 0;
          if (item.dirty) continue;
          const head = git(path, ['rev-parse', '--verify', 'HEAD'])?.trim();
          if (!head) throw new Error('git could not name its HEAD');
          item.head = head;
          const refs = git(path, ['for-each-ref', '--contains', head, '--format=%(refname)']);
          if (refs === null) throw new Error('git could not say which refs hold its HEAD');
          item.refs = refs.split('\n').map((line) => line.trim()).filter(Boolean);
          const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
          if (!common?.trim()) throw new Error('git could not name the repository that owns it');
          item.owner = repositoryDir(common.trim());
          const registration = git(item.owner, ['worktree', 'list', '--porcelain']);
          if (registration === null) throw new Error('git could not verify its worktree registration');
          if (!registeredWorktree(registration, path)) { item.error = 'git does not register this scratch child as a worktree'; continue; }
          item.identity = worktreeIdentity(path);
        }
        if (marker) item.open = openIn(path);
        if (scratchItem(item).target) item.bytes = treeBytes(path);
      } catch (error) { item.error = message(error); }
    }
  }

  // Worktrees git knows of outside the work root: listed, never removed.
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  for (const repo of repos) {
    const text = git(repo.path, ['worktree', 'list', '--porcelain']);
    for (const line of String(text || '').split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const path = line.slice('worktree '.length).trim();
      let real = path;
      try { real = realpathSync(path); } catch { /* retain the listed path when it is gone */ }
      if (path === repo.path || path.startsWith(`${root}/`) || real.startsWith(`${realRoot}/`) || path.startsWith(`${roots.compare}/`)) continue;
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
  facts.cache_items = gatherCacheFacts({ roots, now, repos, git, running, openIn, servers: (wt) => servers(wt, { root: mcHome(env) }) });
  gatherGeneratedFiles(facts, { roots, now, running, openIn, filesOpen, readDir });
  return facts;
}

/**
 * A goal's place in its programme's phases, by the runner's own rule (`phaseOpen`,
 * over `programsGoals` as the runner reads them): `phase`, the programme's
 * `current_phase` (its lowest unfinished one) and `phase_open`. Reads GOAL.json
 * and LOG.md of the programme's goals; no git and no process.
 */
function phaseStanding(programs, programme, parsed, cache) {
  if (!cache.has(programme)) {
    cache.set(programme, programsGoals({
      home: programs, list: (path) => (path === programs ? [programme] : listNames(path)), read: readUtf8OrNull,
    }));
  }
  const goals = cache.get(programme);
  const phase = parsed.phase ?? 1;
  return { phase, current_phase: currentPhase(goals, programme), phase_open: phaseOpen({ programme, phase }, goals) };
}

function readUtf8OrNull(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function gatherPlanGoalWorktrees(facts, { roots, running, now, git, repos, openIn, command, only = null }) {
  const addError = (path, why) => facts.goal_worktrees.push({ path, error: why, bytes: 0 });
  const programs = roots.plan;
  const phases = new Map();
  if (basename(programs) !== 'programs') return; // goal worktrees exist only in layout 2.
  let programmes;
  try { programmes = only ? [only.programme] : readdirSync(programs, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort(); }
  catch (error) { if (error?.code !== 'ENOENT') addError(programs, `could not enumerate programmes: ${message(error)}`); return; }
  for (const programme of programmes) {
    const goalsDir = join(programs, programme, GOALS_DIR);
    let goalDirs;
    try { goalDirs = only ? [only.goal] : readdirSync(goalsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort(); }
    catch (error) { if (error?.code !== 'ENOENT') addError(goalsDir, `could not enumerate goals: ${message(error)}`); continue; }
    for (const goal of goalDirs) {
      const dir = join(goalsDir, goal);
      const metadataPath = join(dir, GOAL_FILE);
      let raw;
      let parsed;
      try { raw = readFileSync(metadataPath, 'utf8'); parsed = parseGoal(raw); }
      catch (error) { addError(dir, `goal metadata unreadable: ${message(error)}`); continue; }
      if (parsed.problems) { addError(dir, `goal metadata invalid: ${parsed.problems.join('; ')}`); continue; }
      const standing = phaseStanding(programs, programme, parsed, phases);
      for (const repoName of parsed.repos.filter((name) => !only || name === only.repo)) {
        const path = join(dir, repoName);
        if (!present(path)) continue;
        const item = { path, programme, goal, repo: repoName, metadata: raw, stage: parsed.stage, status: parsed.status, ...standing, wt: null, bytes: 0 };
        facts.goal_worktrees.push(item);
        try {
          if (!running) throw new Error('could not establish live session cwd evidence');
          const repo = repos.find((entry) => entry.name === repoName);
          if (!repo?.path) throw new Error(`owning repository ${repoName} is unknown`);
          const real = realpathSync(path);
          const realGoal = realpathSync(dir);
          if (!real.startsWith(`${realGoal}/`) || dirname(real) !== realGoal) throw new Error('checkout is not directly under its declared goal directory');
          const registration = git(repo.path, ['worktree', 'list', '--porcelain']);
          if (registration === null || !registeredWorktree(registration, path)) throw new Error('owning repository does not confirm this registered worktree');
          const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
          if (branch !== `goal/${goal}`) throw new Error(`branch is ${branch || 'unknown'}, not goal/${goal}`);
          const head = git(path, ['rev-parse', '--verify', 'HEAD'])?.trim();
          if (!head || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(head)) throw new Error('HEAD could not be verified');
          const status = git(path, ['status', '--porcelain', '--untracked-files=all']);
          if (status === null) throw new Error('Git could not establish checkout cleanliness');
          if (status.trim()) throw new Error('checkout has tracked or untracked changes');
          const ignored = git(path, ['status', '--porcelain', '--ignored=matching', '--untracked-files=all']);
          if (ignored === null) throw new Error('Git could not establish ignored-file state');
          const kept = ignoredBeyondAttachedDeps(path, ignored);
          if (kept.length) throw new Error(`checkout contains ignored files (${kept.slice(0, 3).map((line) => line.slice(3)).join(', ')}${kept.length > 3 ? ', …' : ''})`);
          const own = git(path, ['rev-list', '--count', 'origin/main..HEAD']);
          if (own === null || !/^0\s*$/u.test(own)) throw new Error('checkout has commits beyond origin/main or Git could not verify them');
          const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
          if (!common) throw new Error('owning Git directory could not be verified');
          const identity = goalWorktreeIdentity(path, common);
          const pids = [...new Set(processesStandingIn([dir], { cwds: running }).map((process) => process.pid))];
          if (pids.length) throw new Error(`a live session cwd uses the goal (${pids.map(command).join(', ')})`);
          const openedGoal = openIn(dir);
          const openedTree = openIn(path);
          if (!Array.isArray(openedGoal) || !Array.isArray(openedTree)) throw new Error('open-file evidence is uncertain');
          if (openedGoal.length || openedTree.length) throw new Error(`a process holds a goal/worktree file open (${[...new Set([...openedGoal, ...openedTree])].join(', ')})`);
          const activity = newestMtime(dir);
          if (!Number.isFinite(activity)) throw new Error('could not establish goal/worktree activity');
          item.wt = { path, repo: repoName, branch, head, owner: repo.path, common, identity, activity, metadata_identity: raw };
          if (!only) item.bytes = treeBytes(path);
          item.verdict = { target: true, why: 'eligible plan goal checkout' };
          item.error = null;
        } catch (error) { item.error = message(error); item.verdict = { target: false, why: item.error }; }
      }
    }
  }
}

/**
 * Ignored entries that keep a goal checkout. The one exception is the
 * dependency link the runner attaches at every session (`node_modules/`
 * holding shared-deps.js's ATTACHED_MARK): it is rebuilt from the lockfile
 * at the next session, so it holds nothing a person made. Anything else
 * ignored (local databases, build output, .wrangler state) still keeps it.
 */
function ignoredBeyondAttachedDeps(path, porcelain) {
  return porcelain.split('\n').filter((line) => line.trim())
    .filter((line) => !(line === '!! node_modules/' && existsSync(join(path, 'node_modules', ATTACHED_MARK))));
}

function goalWorktreeIdentity(path, common) {
  const real = realpathSync(path);
  const stat = lstatSync(path);
  const gitPath = join(path, '.git');
  const gitStat = lstatSync(gitPath);
  if (!stat.isDirectory() || !gitStat.isFile() && !gitStat.isDirectory()) throw new Error('worktree identity is not a regular checkout');
  const gitEntry = gitStat.isFile() ? readFileSync(gitPath, 'utf8') : null;
  return { real, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, git_dev: gitStat.dev, git_ino: gitStat.ino, git_entry: gitEntry, common: realpathSync(common) };
}

const UUID_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GENERATED_IMAGE = /\.(?:png|jpe?g|webp)$/iu;

function generatedStat(path) {
  const stat = lstatSync(path);
  return { mtime_ms: stat.mtimeMs, bytes: stat.size, identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtime_ms: stat.mtimeMs } };
}

/** Gather only the three approved file shapes; directory and lsof failures become kept entries. */
function gatherGeneratedFiles(facts, { roots, now, running, openIn, filesOpen, readDir }) {
  const addError = (path, kind, error) => facts.generated_files.push({ path, kind, error: message(error) });
  const walkShots = (dir, active, open) => {
    let entries;
    try { entries = readDir(dir, { withFileTypes: true }); }
    catch (error) { addError(dir, 'mc-shot', error); return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'sessions') continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walkShots(path, active, open); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
      try { facts.generated_files.push({ path, kind: 'mc-shot', ...generatedStat(path), active, open }); }
      catch (error) { addError(path, 'mc-shot', error); }
    }
  };
  const snapshot = (root, inspectOpen = true) => {
    try { const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('approved root is not a regular directory'); }
    catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { missing: true }; addError(root, null, error); return { error: true }; }
    let open;
    try { open = inspectOpen ? openIn(root) : []; } catch { open = null; }
    if (!Array.isArray(open)) open = null;
    const active = running === null ? null : running.some((process) => typeof process.cwd === 'string' && (process.cwd === root || process.cwd.startsWith(`${root}/`)));
    return { open, active };
  };
  const logs = snapshot(roots.wrangler_logs);
  if (!logs.missing && !logs.error) {
    if (logs.open === null || logs.active === null) addError(roots.wrangler_logs, null, new Error('could not establish process/open-file evidence'));
    else {
      let entries;
      try { entries = readDir(roots.wrangler_logs, { withFileTypes: true }); }
      catch (error) { addError(roots.wrangler_logs, null, error); entries = []; }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
        const path = join(roots.wrangler_logs, entry.name);
        try { facts.generated_files.push({ path, kind: 'wrangler-log', ...generatedStat(path), active: logs.active, open: logs.open }); }
        catch (error) { addError(path, 'wrangler-log', error); }
      }
    }
  }
  const shots = snapshot(roots.shots, false);
  if (!shots.missing && !shots.error) {
    if (shots.open === null || shots.active === null) addError(roots.shots, null, new Error('could not establish process/open-file evidence'));
    else {
      walkShots(roots.shots, shots.active, shots.open);
      const old = facts.generated_files.filter((item) => item.kind === 'mc-shot' && !item.error && !item.active && item.mtime_ms < now - GENERATED_KEEP_MS);
      if (old.length) {
        let opened = null;
        try { opened = filesOpen(old.map((item) => item.path)); } catch { /* uncertainty keeps every candidate */ }
        for (const item of old) item.open = opened instanceof Map && Array.isArray(opened.get(item.path)) ? opened.get(item.path) : null;
      }
    }
  }
  let codexRoot = true;
  try { const stat = lstatSync(roots.codex_images); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('approved root is not a regular directory'); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') codexRoot = false; else { addError(roots.codex_images, null, error); codexRoot = false; } }
  if (codexRoot) {
    let sessions;
    try { sessions = readDir(roots.codex_images, { withFileTypes: true }); }
    catch (error) { addError(roots.codex_images, null, error); sessions = []; }
    for (const entry of sessions) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_DIRECTORY.test(entry.name)) continue;
      const dir = join(roots.codex_images, entry.name);
      let open;
      try { open = openIn(dir); } catch { open = null; }
      if (!Array.isArray(open)) open = null;
      const active = running === null ? null : running.some((process) => typeof process.cwd === 'string' && (process.cwd === roots.codex_images || process.cwd === dir || process.cwd.startsWith(`${dir}/`)));
      let children;
      try { children = readDir(dir, { withFileTypes: true }); }
      catch (error) { addError(dir, 'codex-image', error); continue; }
      let groupRecent = false;
      let groupError = null;
      try { groupRecent = lstatSync(dir).mtimeMs >= now - GENERATED_KEEP_MS; } catch (error) { groupError = message(error); }
      const images = [];
      for (const child of children) {
        try { if (lstatSync(join(dir, child.name)).mtimeMs >= now - GENERATED_KEEP_MS) groupRecent = true; }
        catch (error) { groupError = groupError || message(error); }
        if (!child.isFile() || child.isSymbolicLink() || !GENERATED_IMAGE.test(child.name)) continue;
        const path = join(dir, child.name);
        try { const item = { path, kind: 'codex-image', ...generatedStat(path), active, open, group_dir: dir }; images.push(item); if (item.mtime_ms >= now - GENERATED_KEEP_MS) groupRecent = true; }
        catch (error) { addError(path, 'codex-image', error); groupError = groupError || message(error); }
      }
      for (const item of images) facts.generated_files.push({ ...item, group_recent: groupRecent, group_error: groupError });
      if (open === null || active === null) addError(dir, 'codex-image', new Error('could not establish process/open-file evidence'));
    }
  }
}

/**
 * The planning sessions running now, by programme: a foreground `mc plan` whose
 * process lives (`runner/foreground/<pid>.json`). The runner starts no plan
 * session (2026-11-07), so a lane file never holds a planning checkout. A
 * record of a dead process is nothing.
 */
function runningPlanSessions(root) {
  const running = new Map();
  const foreground = join(root, 'runner', 'foreground');
  for (const file of listNames(foreground)) {
    const held = readJsonOrNull(join(foreground, file));
    if (held?.verb === 'plan' && typeof held.programme === 'string' && pidAlive(held.pid)) {
      running.set(held.programme, 'a foreground plan session of it is running');
    }
  }
  return running;
}

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** The names in a directory; none when it cannot be read. */
function listNames(dir) {
  try { return readdirSync(dir).filter((name) => !name.startsWith('.')).sort(); } catch { return []; }
}

/**
 * The pids holding a file open anywhere under `path` (`lsof +D`), or null
 * when lsof cannot say. lsof exits 1 both for "nothing open" and for a
 * failure; only a silent exit 1 is read as nothing.
 */
function openFilesIn(path) {
  const r = spawnSync('lsof', ['-t', '+D', path], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || String(r.stderr || '').trim()) return null;
  const pids = String(r.stdout || '').split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
  if (r.status === 0) return [...new Set(pids)];
  if (r.status === 1 && !pids.length && !String(r.stderr || '').trim()) return [];
  return null;
}

/** File-scoped, bounded lsof evidence; hidden browser profiles are never traversed. */
export function openFilesAmong(paths, { run = spawnSync } = {}) {
  const opened = new Map(paths.map((path) => [path, []]));
  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100);
    let canonical;
    try { canonical = new Map(batch.map((path) => [realpathSync(path), path])); } catch { return null; }
    let r;
    try {
      r = run('lsof', ['-nP', '-F0pn', '--', ...canonical.keys()], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      });
    } catch { return null; }
    const stdout = String(r.stdout || '');
    if (r.error || String(r.stderr || '').trim()) return null;
    if (r.status === 1 && !stdout.trim()) continue;
    // On macOS, a mixed batch returns 1 when some requested files are closed.
    // Actual errors/warnings are on stderr (lsof DIAGNOSTICS); valid matches still identify the open files.
    if (![0, 1].includes(r.status) || !stdout.trim()) return null;
    let pid = null;
    let named = false;
    for (const raw of stdout.split('\0')) {
      const field = raw.replace(/^\n+/u, '');
      if (!field) continue;
      if (field.startsWith('p') && /^[1-9]\d*$/u.test(field.slice(1))) pid = Number(field.slice(1));
      else if (field.startsWith('f') && pid) continue; // lsof emits a file marker even with -F0pn.
      else if (field.startsWith('n') && pid && canonical.has(field.slice(1))) {
        const pids = opened.get(canonical.get(field.slice(1)));
        if (!pids.includes(pid)) pids.push(pid);
        named = true;
      } else return null;
    }
    if (!named) return null;
  }
  return opened;
}

/** A legacy receipt exists only when both finalized runner files are regular files inside runner/log. */
function legacySessionEvidence(stem, env) {
  if (!stem || stem.includes('/') || stem.includes('\\') || stem === '.' || stem === '..') throw new Error('scratch stem cannot name a runner log');
  const logRoot = join(runnerDir(env), 'log');
  const realRoot = realpathSync(logRoot);
  const files = {};
  for (const [name, suffix] of [['err', '.json.err'], ['stream', '.jsonl']]) {
    const path = join(logRoot, stem + suffix);
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error('runner ' + name + ' receipt is not a regular file');
    const real = realpathSync(path);
    if (!real.startsWith(realRoot + '/')) throw new Error('runner ' + name + ' receipt escapes runner/log');
    files[name] = { real, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  }
  return files;
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function registeredWorktree(list, path) {
  const expected = realpathSync(path);
  return String(list).split(/\n(?=worktree )/u).some((entry) => {
    const field = /^worktree (.+)$/mu.exec(entry)?.[1];
    if (!field) return false;
    const value = field.startsWith('"') ? (() => { try { return JSON.parse(field); } catch { return null; } })() : field;
    if (!value) return false;
    try { return realpathSync(value) === expected; } catch { return false; }
  });
}

function worktreeIdentity(path) {
  const real = realpathSync(path);
  const gitPath = join(path, '.git');
  const stat = lstatSync(gitPath);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('worktree identity is not a regular .git entry');
  const sessionPath = dirname(path);
  const session = lstatSync(sessionPath);
  if (!session.isDirectory()) throw new Error('scratch session identity is not a directory');
  // Directory mtimes change as evidence is written; device/inode/birth time identify the session itself.
  return {
    real, git_real: realpathSync(gitPath), git_dev: stat.dev, git_ino: stat.ino, git_mtimeMs: stat.mtimeMs,
    session_real: realpathSync(sessionPath), session_dev: session.dev, session_ino: session.ino, session_birthtimeMs: session.birthtimeMs,
  };
}

/** Keep a detached replay tip before removing its worktree, atomically and without replacing a ref. */
function retainReplayHead(owner, head, refs, git) {
  if (refs.length) return true;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(head)) return false;
  const ref = 'refs/mc/retained-replay/' + head.toLowerCase();
  const existing = git(owner, ['rev-parse', '--verify', ref]);
  if (existing !== null) return existing.trim().toLowerCase() === head.toLowerCase();
  const zero = '0'.repeat(head.length);
  if (git(owner, ['update-ref', ref, head, zero]) !== null) return true;
  // Another tidy may have created this exact ref concurrently; never accept a different commit.
  return git(owner, ['rev-parse', '--verify', ref])?.trim().toLowerCase() === head.toLowerCase();
}

/** What `ps` calls a process, or its pid. */
function commandOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('/').pop() || `pid ${pid}`;
  } catch { return `pid ${pid}`; }
}

/** A process's whole command line. It throws when `ps` cannot say, so the question keeps its item. */
function commandLineOf(pid) {
  return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** An mc runner runs as `mc run` (or `mc-cli.js run`), with only the flags it was started with after that. `mc run lanes` is not one. */
const MC_RUNNER = /(?:^|[\s/])(?:mc|mc-cli\.js) run(?:\s+-\S*(?:\s.*)?)?$/u;

/**
 * Why the runner that owned a session with no recorded end is gone, or null
 * while it still stands for the session. A pid that runs something other
 * than an mc runner was reused, so its runner is gone too. Only a whole pid
 * is judged; anything else stays null, and the session stays unended.
 */
function runnerGone(marker, { alive, commandLine }) {
  const pid = marker.runner_pid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!alive(pid)) return `runner pid ${pid} is not alive`;
  const line = commandLine(pid);
  if (MC_RUNNER.test(line)) return null;
  return `runner pid ${pid} now runs ${line.split(/\s+/u)[0].split('/').pop() || 'another process'}, not an mc runner`;
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

/**
 * (I) A planning area's own checkout: released when no planning session of its
 * programme is running (`item.active` names the one that is) and it has been
 * untouched for 72 hours, the age waived in a pressure pass. The release verdict
 * still decides what may go: nothing uncommitted, nothing main lacks.
 */
export function idlePlanCheckout(item, { now, pressure = false } = {}) {
  if (item.error) throw new Error(item.error);
  if (item.active) return { target: false, why: item.active };
  if (!item.verdict?.remove || item.verdict.what !== 'worktree and branch') {
    return { target: false, why: item.verdict?.why || 'not a git worktree' };
  }
  if (typeof item.activity !== 'number') throw new Error('could not tell when it was last touched');
  if (!pressure && item.activity >= now - GENERATED_KEEP_MS) return { target: false, why: 'touched within the last 72 hours' };
  return { target: true, why: pressure
    ? 'no planning session of its programme is running (pressure pass; age exception); mc plan adds it back'
    : 'no planning session of its programme is running, untouched for 72 hours; mc plan adds it back' };
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

/** Who owns a scratch directory, as its record says: the same at the list and at the apply, or it is not the same owner. */
export function scratchOwner(marker) {
  return marker ? `${marker.session ?? '?'}@${marker.started ?? '?'}` : null;
}

/**
 * (S) A worktree or `DerivedData` in a runner session's scratch directory.
 * It may go only on proof: the record names the runner as owner and says the
 * session ended, no process stands in the directory or holds a file open in
 * the candidate, and a worktree is clean with its HEAD on a ref. Anything
 * not known keeps it; age is never asked.
 */
export function scratchItem(item) {
  if (item.error) throw new Error(item.error);
  if (item.marker_error) return { target: false, why: `its scratch directory's ownership record cannot be read (${item.marker_error})` };
  if (!item.marker) {
    if (!item.marker_absent) return { target: false, why: 'its scratch directory has no ownership record — legacy scratch is kept' };
    if (item.kind !== 'scratch-worktree') return { target: false, why: 'marker-less scratch data is not adopted' };
  }
  const marker = item.marker;
  if (marker && (marker.schema !== SCRATCH_SCHEMA || marker.owner !== 'runner' || !marker.session || !marker.started)) {
    return { target: false, why: 'its scratch directory\'s owner is not clear' };
  }
  if (marker && !marker.ended && !item.runner_gone) return { target: false, why: marker.session + ' has not recorded an end' };
  if (item.live === null || item.live === undefined) throw new Error('could not tell whether a process stands in it');
  if (item.live.length) return { target: false, why: `process ${item.live.join(', ')} stands in its scratch directory` };
  if (!marker && Array.isArray(item.open) && item.open.length) {
    return { target: false, why: `process ${item.open.join(', ')} holds a file open in its scratch session` };
  }
  if (item.kind === 'scratch-worktree') {
    if (item.dirty === null || item.dirty === undefined) throw new Error('could not tell whether it has uncommitted changes');
    if (item.dirty) return { target: false, why: `${item.dirty} uncommitted change(s)` };
    if (!Array.isArray(item.refs)) throw new Error('could not tell whether its HEAD is on a ref');
    if (!item.owner) throw new Error('no repository owns it');
  }
  if (!Array.isArray(item.open)) throw new Error('could not tell whether a file in it is open');
  if (item.open.length) return { target: false, why: `process ${item.open.join(', ')} holds a file open in it` };
  // A session with no recorded end whose runner is gone is named so: the why says the owning runner is gone.
  const session = !marker ? null : marker.ended ? `ended session ${marker.session}`
    : `session ${marker.session}, whose owning runner is gone (${item.runner_gone})`;
  return item.kind === 'scratch-worktree'
    ? { target: true, why: marker
      ? (item.refs.length ? `a clean worktree of ${session}, its HEAD on ${item.refs[0]}` : `a clean detached worktree of ${session}; its HEAD will be retained before removal`)
      : 'a clean registered replay worktree with finalized runner receipts; its HEAD will be retained before removal' }
    : { target: true, why: `rebuildable DerivedData of ${session}` };
}

/* ------------------------------------------------------------- deciding */

/**
 * The list, pure: `{ days, targets: [{ path, kind, rule, why, bytes }],
 * kept: [{ path, rule, why }] }`.
 */
export function tidyPlan(facts, { days = DEFAULT_DAYS, person = false, pressure = false } = {}) {
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
    const verdict = judge(idlePlanCheckout, item, { now: facts.now, pressure });
    if (verdict.target) targets.push({ path: item.path, kind: 'plan-checkout', rule: 'I', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'plan-checkout', verdict.why);
  }
  for (const item of facts.plan_worktrees || []) {
    const verdict = judge(planWorktree, item);
    if (verdict.target) targets.push({ path: item.path, kind: 'plan-worktree', rule: 'X', why: verdict.why, bytes: item.bytes || 0 });
    else keep(item.path, 'X', verdict.why);
  }
  for (const item of facts.goal_worktrees || []) {
    const verdict = planGoalWorktree(item, { now: facts.now, pressure });
    if (verdict.target) targets.push({
      path: item.path, kind: 'plan-goal-worktree', rule: 'P', why: verdict.why, bytes: item.bytes || 0,
      programme: item.programme, goal: item.goal, repo: item.repo, stage: item.stage, status: item.status,
      metadata: item.metadata, branch: item.wt.branch, head: item.wt.head, owner: item.wt.owner,
      common: item.wt.common, identity: item.wt.identity, activity: item.wt.activity,
    });
    else keep(item.path, 'P', verdict.why);
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

  // (S) worktrees and DerivedData in ended runner sessions' scratch directories; the rest of a scratch directory is not listed.
  for (const item of facts.scratch_items || []) {
    const verdict = judge(scratchItem, item);
    if (verdict.target) {
      targets.push({
        path: item.path, kind: item.kind, rule: 'S', why: verdict.why, bytes: item.bytes || 0,
        owner_id: scratchOwner(item.marker), head: item.head, identity: item.identity, evidence: item.evidence,
        ...(item.owner ? { owner: item.owner } : {}),
      });
    } else keep(item.path, 'S', verdict.why);
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

  // (B) Exact rebuildable caches, with ownership/age and inactivity evidence.
  for (const item of facts.cache_items || []) {
    const verdict = rebuildableCache(item, facts.now);
    // A containing worktree/area already includes this cache in its removal and byte estimate.
    if (verdict.target && targets.some((parent) => item.path.startsWith(parent.path + '/'))) continue;
    if (verdict.target) targets.push({ path: item.path, kind: item.kind, rule: 'B', why: verdict.why,
      bytes: item.bytes || 0, identity: item.identity, owner_id: item.owner_id ?? null });
    else keep(item.path, 'B', verdict.why);
  }

  // (F) These approved file inventories use an independent 72-hour window.
  for (const item of facts.generated_files || []) {
    if (item.error) { keep(item.path, item.kind || 'generated-file', `error: ${item.error}`); continue; }
    const keepFor = (why) => keep(item.path, item.kind, why);
    if (item.active === null || item.open === null) { keepFor('error: could not establish process/open-file evidence'); continue; }
    if (item.active) { keepFor('a process has its cwd in the approved subtree'); continue; }
    if (item.open.length) { keepFor(`process ${item.open.join(', ')} holds a file open in the approved subtree`); continue; }
    if (item.group_error) { keepFor(`error: ${item.group_error}`); continue; }
    if (item.kind === 'codex-image' && item.group_recent) { keepFor('its Codex image session group was touched in the last 72 hours'); continue; }
    if (typeof item.mtime_ms !== 'number') { keepFor('error: could not tell when it was last touched'); continue; }
    if (item.mtime_ms >= facts.now - GENERATED_KEEP_MS) { keepFor('touched in the last 72 hours'); continue; }
    targets.push({ path: item.path, kind: item.kind, rule: 'F', why: `older than 72 hours (${Math.floor((facts.now - item.mtime_ms) / HOUR_MS)} hours)`, bytes: item.bytes || 0, identity: item.identity });
  }

  return { days, person, targets, kept };
}

/**
 * (P) A registered goal checkout that may go: its goal cannot start a build or
 * review session now (`goalCannotStart`), or it is in `draft` (as before). A
 * blocked goal keeps its checkout: a mend session is what resolves it.
 */
export function planGoalWorktree(item, { now, pressure = false } = {}) {
  if (item.error) return { target: false, why: `error: ${item.error}` };
  if (!item.wt) return { target: false, why: 'error: goal checkout identity could not be established' };
  const cannot = item.stage === 'draft' ? 'draft' : item.status === 'blocked' ? null : goalCannotStart(item);
  if (!cannot) {
    if (FINISHED.includes(item.stage)) return { target: false, why: `goal stage is ${item.stage}, which no session starts on` };
    if (item.status === 'blocked') return { target: false, why: 'goal is blocked: its checkout stays for the mend session that resolves it' };
    return { target: false, why: `goal stage is ${item.stage || 'unknown'}, not draft, and a session can start it` };
  }
  if (item.wt.activity >= now - GENERATED_KEEP_MS && !pressure) return { target: false, why: 'goal/worktree touched within the last 72 hours' };
  if (cannot === 'draft') {
    return { target: true, why: pressure
      ? 'clean inactive draft goal checkout (pressure pass; age exception)'
      : 'clean inactive draft goal checkout, untouched for 72 hours' };
  }
  return { target: true, why: pressure
    ? `clean inactive goal checkout, ${cannot} (pressure pass; age exception)`
    : `clean inactive goal checkout, ${cannot}, untouched for 72 hours` };
}

/**
 * Why a goal cannot start a build or review session now, or null. Martin's
 * goals wait on him; a goal in a phase above its programme's lowest unfinished
 * one waits for the phases below it (`phaseOpen`, the runner's own rule). A
 * finished goal is not reached here.
 */
function goalCannotStart(item) {
  if (FINISHED.includes(item.stage)) return null;
  if (item.status === 'Martin') return 'status Martin, which waits on a person';
  if (item.phase_open === false) return `phase ${item.phase} is above the programme's lowest unfinished phase ${item.current_phase}`;
  return null;
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
  if (['wrangler-log', 'mc-shot', 'codex-image'].includes(target.kind) || Object.hasOwn(CACHE_KIND_ROOT, target.kind)) {
    const rootStat = lstatSync(roots[key]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 'approved root is not a regular directory';
  }
  const base = realpathSync(roots[key]);
  if (['wrangler-log', 'mc-shot', 'codex-image'].includes(target.kind) || Object.hasOwn(CACHE_KIND_ROOT, target.kind)) {
    const relative = target.path.startsWith(`${roots[key]}/`) ? target.path.slice(roots[key].length + 1) : null;
    if (relative === null) return `not under ${roots[key]}`;
    let cursor = roots[key];
    for (const part of relative.split('/')) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) return 'symbolic link is not a target';
    }
  }
  const real = realpathSync(target.path);
  if (!real.startsWith(`${base}/`)) return `not under ${roots[key]}`;
  if (lstatSync(target.path).isSymbolicLink()) return `symbolic link is not a target`;
  const name = basename(real);
  const parent = dirname(real);
  const shaped = Object.hasOwn(CACHE_KIND_ROOT, target.kind) ? cachePathAllowed(target, roots) : {
    transcript: dirname(parent) === base && SESSION_ID.test(TRANSCRIPT.exec(name)?.[1] || ''),
    leftover: dirname(parent) === base && SESSION_ID.test(name) && lstatSync(real).isDirectory(),
    // `<planAreaRoot>/<programme>/<worktree>`: `roots.plan` is `plan/` or `programs/` by the layout.
    'plan-checkout': dirname(parent) === base && PLAN_CHECKOUTS.has(name),
    'plan-worktree': dirname(parent) === base && !PLAN_CHECKOUTS.has(name),
    'plan-goal-worktree': (() => {
      const relative = real.slice(base.length + 1).split('/');
      return real.startsWith(`${base}/`) && relative.length === 4 && relative[1] === GOALS_DIR
        && relative[0] && relative[2] && relative[3] === name && dirname(real) === join(base, relative[0], GOALS_DIR, relative[2]);
    })(),
    'work-area': parent === base,
    'orphan-step-area': parent === base,
    'compare-worktree': parent === base,
    'gate-cache-slug': parent === base,
    'gate-slug': parent === base,
    'selection-slug': parent === base,
    // `<gate-cache>/<slug>/<key>`: two levels down, as the entry of a repository's cache.
    'gate-cache-entry': dirname(parent) === base,
    // `<scratch>/<stem>/<worktree>` and `<scratch>/<stem>/DerivedData`.
    'scratch-worktree': dirname(parent) === base,
    'scratch-derived': dirname(parent) === base && name === DERIVED_DATA,
    'wrangler-log': parent === base && name.endsWith('.log') && lstatSync(real).isFile() && !lstatSync(real).isSymbolicLink(),
    'mc-shot': (parent === base || parent.startsWith(`${base}/`)) && name.endsWith('.png') && lstatSync(real).isFile() && !lstatSync(real).isSymbolicLink()
      && real.slice(base.length + 1).split('/').every((part) => !part.startsWith('.') && part !== 'sessions'),
    'codex-image': dirname(parent) === base && UUID_DIRECTORY.test(basename(parent)) && GENERATED_IMAGE.test(name) && lstatSync(real).isFile() && !lstatSync(real).isSymbolicLink(),
  }[target.kind];
  return shaped ? null : `not the shape a ${target.kind} has under ${roots[key]}`;
}

/**
 * The whole run: gather, decide, write the list, and with `apply` remove
 * from it. Returns `{ list, listPath, outcome }`; `outcome` is `applyTidy`'s.
 */
export function runTidy({
  apply = false, days = DEFAULT_DAYS, person = false, pressure = false, env = process.env, now = Date.now(), write = writeJsonAtomic, ...doors
} = {}) {
  const roots = tidyRoots(env);
  const plan = tidyPlan(gatherTidyFacts({ env, now, ...doors }), { days, person, pressure });
  const list = { at: new Date(now).toISOString(), rules_version: RULES_VERSION, days, person, pressure, targets: plan.targets, kept: plan.kept };
  let listPath = join(roots.tidy, `${listStamp(now)}.json`);
  for (let n = 2; present(listPath); n += 1) listPath = join(roots.tidy, `${listStamp(now)}-${n}.json`);
  write(listPath, list);
  if (!apply) return { list, listPath, outcome: null };
  const outcome = applyTidy({ listPath, env, now, write, pressure, ...doors });
  return { list: outcome.list, listPath, outcome };
}

/**
 * Remove what the list file at `listPath` names, and nothing else. Each
 * target is asked again first — its root, then its rule on facts read now —
 * and anything that does not answer yes is kept with the reason. What
 * happened is written back into the same file as `applied`.
 */
export function applyTidy({
  listPath, env = process.env, now = Date.now(), write = writeJsonAtomic, pressure = false,
  remove = realRemove, release = releaseWorktree, prune = pruneWorktrees, removeWorktree = realRemoveWorktree, ...doors
} = {}) {
  const roots = tidyRoots(env);
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  const targets = Array.isArray(list.targets) ? list.targets : [];
  const facts = gatherTidyFacts({ env, now, ...doors });
  const pressurePass = pressure === true && list.pressure === true;
  const fresh = tidyPlan(facts, { days: Number.isInteger(list.days) && list.days >= 1 ? list.days : DEFAULT_DAYS, person: list.person === true, pressure: pressurePass });
  const holds = new Map(fresh.targets.map((item) => [item.path, item]));
  const keptNow = new Map(fresh.kept.map((item) => [item.path, item]));
  const worktrees = new Map([...(facts.plan_worktrees || []), ...(facts.plan_checkouts || [])].map((item) => [item.path, item]));
  const workAreas = new Map([...(facts.work_areas || []), ...(facts.step_areas || []).filter((item) => item.worktrees)].map((item) => [item.path, item]));
  const compares = new Map((facts.compare_worktrees || []).map((item) => [item.path, item]));
  const scratch = new Map((facts.scratch_items || []).map((item) => [item.path, item]));
  const caches = new Map((facts.cache_items || []).map((item) => [item.path, item]));

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
      if (again.rule === 'S' && again.owner_id !== target.owner_id) {
        applied.push({ path, ok: false, why: 're-check: its scratch directory\'s owner changed since the list' });
        continue;
      }
      if (target.kind === 'scratch-worktree' && (
        again.head !== target.head || again.owner !== target.owner || !sameEvidence(again.identity, target.identity)
        || (target.evidence !== undefined && !sameEvidence(again.evidence, target.evidence))
      )) {
        applied.push({ path, ok: false, why: 're-check: its worktree identity, HEAD or runner receipts changed since the list' });
        continue;
      }
      if (Object.hasOwn(CACHE_KIND_ROOT, target.kind)) {
        const cache = caches.get(path);
        if (!cache) { applied.push({ path, ok: false, why: 're-check: cache disappeared' }); continue; }
        // Other removals may take time: refresh this cache's process, owner and complete tree metadata at deletion.
        let running = null;
        try { running = (doors.cwds || cwdsOfUser)(); } catch { /* fail closed */ }
        if (!running?.length || running.complete === false) running = null;
        const [current] = gatherCacheFacts({ roots, now, running, only: cache,
          repos: doors.repos || defaultRepos(env), git: doors.git || realGit, openIn: doors.openIn || openFilesIn,
          servers: (wt) => (doors.servers || serversFor)(wt, { root: mcHome(env) }) });
        const verdict = current && rebuildableCache(current, now);
        if (!verdict?.target || current.identity !== target.identity || current.identity !== again.identity
          || (current.owner_id ?? null) !== target.owner_id || (current.owner_id ?? null) !== again.owner_id) {
          applied.push({ path, ok: false, why: `re-check: ${!verdict?.target ? verdict?.why || 'cache disappeared' : 'cache identity or owner changed since the list'}` });
          continue;
        }
        remove(path);
      } else if (['wrangler-log', 'mc-shot', 'codex-image'].includes(target.kind)) {
        const stat = lstatSync(path);
        const identity = { dev: stat.dev, ino: stat.ino, size: stat.size, mtime_ms: stat.mtimeMs };
        if (!stat.isFile() || stat.isSymbolicLink() || JSON.stringify(identity) !== JSON.stringify(target.identity)
          || JSON.stringify(identity) !== JSON.stringify(again.identity)) {
          applied.push({ path, ok: false, why: 're-check: file identity changed since the list' }); continue;
        }
        unlinkSync(path);
      } else if (target.kind === 'plan-goal-worktree') {
        const removeUnderLease = () => {
          // Only this goal's evidence belongs under the allocation/admission
          // lock. Never inventory unrelated worktrees, caches or transcripts here.
          let running = null;
          try { running = (doors.cwds || cwdsOfUser)(); } catch { /* fail closed */ }
          if (!running?.length || running.complete === false) running = null;
          const freshFacts = { goal_worktrees: [] };
          gatherPlanGoalWorktrees(freshFacts, { roots, running, now, only: {
            programme: basename(dirname(dirname(dirname(path)))), goal: basename(dirname(path)), repo: basename(path),
          }, git: doors.git || realGit, repos: doors.repos || defaultRepos(env),
          openIn: doors.openIn || openFilesIn, command: doors.command || commandOf });
          const item = freshFacts.goal_worktrees.find((candidate) => candidate.path === path);
          const verdict = item && planGoalWorktree(item, { now, pressure: pressurePass });
          const wt = item?.wt;
          if (!verdict?.target || !wt || item.metadata !== target.metadata || item.stage !== target.stage || item.status !== target.status
            || wt.branch !== target.branch || wt.head !== target.head || wt.owner !== target.owner || wt.common !== target.common
            || wt.activity !== target.activity || !sameEvidence(wt.identity, target.identity)) {
            applied.push({ path, ok: false, why: `re-check: ${!verdict?.target ? verdict?.why || 'goal checkout disappeared or is no longer declared' : 'goal metadata, stage, worktree identity, HEAD or activity changed since the list'}` });
            return;
          }
          if (!removeWorktree(wt.owner, path)) { applied.push({ path, ok: false, why: 'git worktree remove refused' }); return; }
          return;
        };
        (doors.goalWorktreeLock || ((fn) => realLock(roots.root, fn, { strict: true, name: 'tidy-pressure' })))(removeUnderLease);
        if (applied.some((entry) => entry.path === path)) continue;
      } else if (target.kind === 'plan-worktree' || target.kind === 'plan-checkout') {
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
      } else if (target.kind === 'scratch-worktree') {
        // Retain even an unreferenced replay tip before handing the clean registered tree to git, without --force.
        const item = scratch.get(path);
        const owner = item?.owner;
        const git = doors.git || realGit;
        if (!owner || !retainReplayHead(owner, item.head, item.refs, git)) { applied.push({ path, ok: false, why: 'replay HEAD could not be retained in its owning repository' }); continue; }
        if (!removeWorktree(owner, path)) { applied.push({ path, ok: false, why: 'git worktree remove refused' }); continue; }
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

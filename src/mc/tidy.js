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
 *     `status: blocked` keeps its checkout. Clean means no tracked or untracked
 *     entry, and its ignored entries are only the `node_modules/` dependency
 *     link the runner attaches (it carries `.memoro-deps.json`) and the
 *     rebuildable residue of a memoro dev server; any other ignored entry keeps
 *     the checkout. Commits beyond `origin/main` are released only when every
 *     one is on `origin/goal/<goal>` after a fetch of origin in the owning
 *     repository; a failed fetch keeps. Its branch and goal directory stay, and
 *     the runner re-adds the checkout on that branch when it next needs it.
 *   - (K) A slug directory under `~/mc/gate-cache/`, `~/mc/gate/` or
 *     `~/.memoro/mc/selection/` that no repository mc knows hashes to — a
 *     repository's path moved and left it — goes when untouched for a day and no
 *     process stands in it, through `rmTree`. A known one is never judged.
 *   - (A) A `~/mc/gate-cache/<slug>/<key>/` entry under a slug a repository mc knows has goes when no round has used it for fourteen days
 *     (`meta.at`), and a `<key>.tmp-<pid>` staging directory once it is a day old, through `rmTree`. The dependency cache is bounded by
 *     count (`prepare-cache.js`); this bounds it by age too.
 *   - (S) Also: a registered source export of a session, `<scratch>/<stem>/exports/<id>`, verified
 *     against its receipt and retained commit, once its session has ended and no process stands in it
 *     (`scratch.js`, docs/technical/mc-tidy.md "Registered source exports").
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
 *     legacy: rule S keeps its items unless the proof above holds, and
 *     (S-whole) below may take it whole. A session whose runner is alive and
 *     has recorded no end is kept.
 *   - (S-whole) An ended session's scratch directory goes whole once untouched for 7 days (72 hours under pressure), unless its stem or path is named in an unfinished goal's GOAL.json or LOG.md or in a waiting proposal; then it stays until that goal is finished. (C) A Codex session transcript under `~/.codex/sessions/` goes once older than 7 days and not held open; Codex's databases are never touched.
 *     Untouched means the newest mtime of the directory and its direct entries.
 *     A directory is kept, with its reason, when a process stands in it or
 *     holds a file open, when it still holds a git worktree (a `.git` at depth
 *     0 to 2) after S's worktree step, when S or B keeps something in it for
 *     its own reason, or when any fact cannot be read. A legacy directory (no
 *     record) is judged by the same age and the same process and open-file
 *     evidence. Removal is `rmTree`, after the list and a recheck at apply.
 *   - (C) Codex transcripts: see (S-whole) above; a date directory that its
 *     transcripts leave empty goes with them, and an empty one untouched for 7
 *     days goes too. Nothing else under the Codex home is read.
 *   - (B) Exact rebuildable caches (tidy-caches.js): five native-phone output
 *     paths in ended runner scratch whose owning goal has finished, idle worker bundles, and four
 *     named per-user caches. Shared caches/bundles retain 72 hours. Every
 *     removal rechecks ownership, process/open-file evidence and tree identity.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
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
import {
  EXPORTS_DIR, SCRATCH_MARKER, SCRATCH_SCHEMA, exportDecision, exportShapeOk, gatherExports, listReceipts, removeExport, withSessionLockSync,
} from './scratch.js';
import { realLock } from './runner-lock.js';
import { CACHE_KIND_ROOT, cachePathAllowed, gatherCacheFacts, rebuildableCache } from './tidy-caches.js';
import { cwdsOfUser, processesStandingIn } from './standing.js';
import { pidAlive } from './status-collect.js';
import { serversFor } from './test-environment.js';
import {
  inspectWorktree, listStepAreas, pruneWorktrees, releaseVerdict, releaseWorktree,
} from './work-area.js';

export const DEFAULT_DAYS = 14;
export const RULES_VERSION = 13;
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
/** (S-whole) An ended session's scratch directory, untouched this long, goes whole; 72 hours under pressure (GENERATED_KEEP_MS). */
export const SCRATCH_WHOLE_MS = 7 * 24 * 60 * 60 * 1000;
/** (C) A Codex session transcript older than this, and not held open, goes. */
export const CODEX_TRANSCRIPT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TRANSCRIPT = /^(.+)\.jsonl$/u;
const LIST_FILE = /^\d{8}T\d{6}Z(-\d+)?\.json$/u;
/** A planning area's own checkouts: never a target. */
const PLAN_CHECKOUTS = new Set(['memoro', 'memoro-cli']);
/** mc's own files in a workarea: never what keeps one, and gone with it. */
const WORK_AREA_OWN = new Set(['.mc.json', '.mc-role', '.mc-stopped', '.DS_Store']);
/** Keeps that are the ordinary case, left out of the printout. */
export const ROUTINE = new Set(['T1', 'T2', 'T5', 'recent', 'plan-checkout', 'G', 'K', 'A', 'S', 'B', 'C-other', 'S-named']);
/** The ownership record the runner writes into each session's scratch directory (`run.js`), defined in scratch.js. */
export { SCRATCH_MARKER, SCRATCH_SCHEMA } from './scratch.js';
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
    // The gate's dependency cache, the gate's own directory and the selection state: each holds a directory per repository slug (K).
    gate_cache: workGateCachePath(env),
    gate: workGatePath(env),
    selection: join(mcHome(env), 'selection'),
    // A runner session's scratch directories (S): `~/mc/runner/scratch/<stem>/`.
    scratch: runnerScratchDir(env),
    wrangler_logs: join(env.HOME || homedir(), 'Library', 'Preferences', '.wrangler', 'logs'),
    shots: join(mcHome(env), 'shots'),
    codex_images: join(env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images'),
    // Codex session transcripts (C): `sessions/YYYY/MM/DD/*.jsonl`, and nothing else under the Codex home.
    codex_sessions: join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
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
  'gate-cache-slug': 'gate_cache',
  'gate-slug': 'gate',
  'selection-slug': 'selection',
  'gate-cache-entry': 'gate_cache',
  'scratch-worktree': 'scratch',
  'scratch-derived': 'scratch',
  'scratch-export': 'scratch',
  'wrangler-log': 'wrangler_logs',
  'mc-shot': 'shots',
  'codex-image': 'codex_images',
  'scratch-session': 'scratch',
  'codex-transcript': 'codex_sessions',
  'codex-session-day': 'codex_sessions',
};

/** The roots whose directories are named by a repository's slug, and the kind of target each one holds (K). */
const SLUG_ROOTS = [['gate_cache', 'gate-cache-slug'], ['gate', 'gate-slug'], ['selection', 'selection-slug']];

/** The kinds that are one approved regular file each (F, and C's transcripts): unlinked, identity-checked, shape-checked. */
const APPROVED_FILE_KINDS = ['wrangler-log', 'mc-shot', 'codex-image', 'codex-transcript', 'codex-session-day'];

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
    work_areas: [], step_areas: [], foreign: [], transcripts: [], leftovers: [], cache_slugs: [], gate_cache_entries: [],
    scratch_items: [], scratch_exports: [], generated_files: [], cache_items: [],
    scratch_sessions: [], scratch_refs: null, codex_transcripts: [], codex_days: [], codex_other: [], codex_errors: [],
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
    const { marker, error: markerError, absent: markerAbsent } = scratchRecord(dir);
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

  // (S-whole) every runner session's scratch directory, read whole, and the references that name it (read once here).
  facts.scratch_refs = gatherScratchReferences(roots);
  gatherScratchSessions(facts, { roots, running, now, alive, commandLine, openIn });

  // (S) registered source exports (scratch.js): each session's receipts read and its trees verified here; tidyPlan decides.
  // Only `<scratch>/<stem>/exports/<id>` with its receipt in `.mc-exports/` is a candidate, never an arbitrary exports directory.
  const exportGit = { text: (cwd, args) => git(cwd, args), blobs: null };
  const standingOf = (path, { excludePid = null } = {}) => {
    if (!running) return null;
    try { return processesStandingIn([path], { cwds: running }).map((p) => p.pid).filter((pid) => pid !== excludePid); } catch { return null; }
  };
  const runnerEnded = (marker) => {
    if (marker.ended) return null;
    try { return runnerGone(marker, { alive, commandLine }); } catch { return null; }
  };
  for (const stem of listNames(roots.scratch)) {
    const dir = join(roots.scratch, stem);
    try {
      facts.scratch_exports.push(...gatherExports({ stemDir: dir, env, git: exportGit, repos, standing: standingOf, openIn, runnerGone: runnerEnded }));
    } catch (error) {
      facts.scratch_exports.push({ path: dir, stem, error: message(error), receipt: null, marker: null, live: null, open: null, verify: null, bytes: 0 });
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
      if (path === repo.path || path.startsWith(`${root}/`) || real.startsWith(`${realRoot}/`)) continue;
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
  gatherCodexSessions(facts, { roots, now, filesOpen });
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
  const fetched = new Map(); // owning repository → its `git fetch -q origin` answer, at most once per call
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
          const kept = ignoredBeyondRebuildable(path, ignored);
          if (kept.length) throw new Error(`checkout contains ignored files (${kept.slice(0, 3).map((line) => line.slice(3)).join(', ')}${kept.length > 3 ? ', …' : ''})`);
          const own = git(path, ['rev-list', '--count', 'origin/main..HEAD']);
          if (own === null || !/^\d+\s*$/u.test(own)) throw new Error('checkout has commits beyond origin/main or Git could not verify them');
          const ahead = Number(own);
          let pushed = null;
          if (ahead > 0) {
            if (!fetched.has(repo.path)) fetched.set(repo.path, git(repo.path, ['fetch', '-q', 'origin']));
            if (fetched.get(repo.path) === null) throw new Error(`checkout has commits beyond origin/main (${ahead}) and the fetch of origin failed, so whether they are pushed is unknown`);
            const remote = `origin/goal/${goal}`;
            const remoteRef = `refs/heads/goal/${goal}`;
            const advertised = git(repo.path, ['ls-remote', '--exit-code', '--heads', 'origin', remoteRef]);
            if (advertised === null || !advertised.split(/\r?\n/u).some((line) => line.endsWith(`\t${remoteRef}`))) {
              throw new Error(`checkout has commits beyond origin/main (${ahead}) that are not on ${remote}`);
            }
            const unpushed = git(path, ['rev-list', '--count', `${remote}..HEAD`]);
            if (unpushed === null || !/^0\s*$/u.test(unpushed)) throw new Error(`checkout has commits beyond origin/main (${ahead}) that are not on origin/goal/${goal}`);
            pushed = { commits: ahead, remote };
          }
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
          item.wt = { path, repo: repoName, branch, head, owner: repo.path, common, identity, activity, metadata_identity: raw, pushed };
          if (!only) item.bytes = treeBytes(path);
          item.verdict = { target: true, why: 'eligible plan goal checkout' };
          item.error = null;
        } catch (error) { item.error = message(error); item.verdict = { target: false, why: item.error }; }
      }
    }
  }
}

/**
 * The rebuildable residue of a memoro dev server, as memoro's `.gitignore`
 * names it: a rebuild recreates every one of these, and none holds a person's
 * state. `.venv-<name>/` and `__pycache__/` at any depth are matched by rule.
 */
const REBUILDABLE_RESIDUE = new Set(['.wrangler/', 'public/dist/', 'scripts/dev/local-schema.sql']);
const isRebuildableResidue = (entry) => REBUILDABLE_RESIDUE.has(entry) || /^\.venv-[^/]+\/$/u.test(entry)
  || entry === '__pycache__/' || entry.endsWith('/__pycache__/');

/**
 * Ignored entries that keep a goal checkout. Two kinds do not: the dependency
 * link the runner attaches at every session (`node_modules/` holding
 * shared-deps.js's ATTACHED_MARK, rebuilt from the lockfile at the next
 * session) and the rebuildable residue above. Anything else ignored (local
 * databases, `.mc/local.json`, `scripts/admin/_venv/`) still keeps it.
 */
function ignoredBeyondRebuildable(path, porcelain) {
  return porcelain.split('\n').filter((line) => line.trim())
    .filter((line) => !(line === '!! node_modules/' && existsSync(join(path, 'node_modules', ATTACHED_MARK))))
    .filter((line) => !(line.startsWith('!! ') && isRebuildableResidue(line.slice(3))));
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

/** The entries of a directory: none when it does not exist; any other failure throws. */
function entriesOf(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
}

/** A scratch directory's ownership record: its value, or why it cannot be read, or `absent` when there is none. */
function scratchRecord(dir) {
  const path = join(dir, SCRATCH_MARKER);
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a regular file');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return { marker: value, error: null, absent: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { marker: null, error: null, absent: true };
    return { marker: null, error: message(error), absent: false };
  }
}

/** A file's text, or '' when there is no such file. Any other failure throws. */
function textOrEmpty(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
}

/** Whether a GOAL.json says, validly, that its goal is done or dropped. Anything else — missing, invalid, unfinished — is not finished. */
function positivelyFinished(text) {
  try {
    const parsed = parseGoal(text);
    return !parsed.problems && FINISHED.includes(parsed.stage);
  } catch { return false; }
}

/**
 * What names a scratch session (S-whole): the text of every goal's GOAL.json and LOG.md under
 * `programs/<programme>/goals/<goal>/`, unless the goal's GOAL.json positively says it is done or dropped,
 * and of every waiting proposal (`proposals/*.md` under the work root and under each programme; `archive/`
 * is not read). A goal whose GOAL.json is missing or does not parse is read as unfinished: what it names is
 * kept, and nothing else is held. A file that exists but cannot be read is recorded as `unreadable`, and then
 * nothing is judged unreferenced.
 */
export function gatherScratchReferences(roots) {
  const refs = { texts: [], unreadable: null };
  const unreadable = (why) => { refs.unreadable = refs.unreadable || why; };
  const programs = join(roots.root, PROGRAMS_HOME);
  let programmes = [];
  try {
    programmes = entriesOf(programs).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
  } catch (error) { unreadable(`programmes: ${message(error)}`); }
  for (const programme of programmes) {
    const goalsDir = join(programs, programme, GOALS_DIR);
    let goals = [];
    try { goals = entriesOf(goalsDir).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name); } catch (error) {
      unreadable(`goals of ${programme}: ${message(error)}`);
      continue;
    }
    for (const goal of goals) {
      const label = `${programme}/${goal}`;
      const dir = join(goalsDir, goal);
      try {
        const goalText = textOrEmpty(join(dir, GOAL_FILE));
        const logText = textOrEmpty(join(dir, 'LOG.md'));
        if (positivelyFinished(goalText)) continue;
        if (goalText) refs.texts.push({ source: `goal ${label} GOAL.json`, text: goalText });
        if (logText) refs.texts.push({ source: `goal ${label} LOG.md`, text: logText });
      } catch (error) { unreadable(`goal ${label}: ${message(error)}`); }
    }
  }
  for (const dir of [join(roots.root, 'proposals'), ...programmes.map((programme) => join(programs, programme, 'proposals'))]) {
    let entries = [];
    try { entries = entriesOf(dir); } catch (error) { unreadable(`proposals in ${shortPath(dir)}: ${message(error)}`); continue; }
    for (const entry of entries) {
      if (!entry.name.endsWith('.md') || entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      try { refs.texts.push({ source: `waiting proposal ${shortPath(path)}`, text: readFileSync(path, 'utf8') }); } catch (error) {
        unreadable(`proposal ${shortPath(path)}: ${message(error)}`);
      }
    }
  }
  return refs;
}

/** The sources whose text names a stem: its directory name is its name, and its absolute path contains it. */
function namedBy(refs, stem) {
  if (!refs || refs.unreadable) return [];
  return refs.texts.filter((item) => item.text.includes(stem)).map((item) => item.source);
}

/** The newest mtime of a directory and its direct entries (not walked further). */
function untouchedMs(dir) {
  let newest = lstatSync(dir).mtimeMs;
  for (const name of readdirSync(dir)) newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs);
  return newest;
}

/** The directories a `.git` entry sits in at depth 0 to 2 under a scratch session: the git worktrees it still holds. */
function worktreesWithin(dir) {
  const held = [];
  if (present(join(dir, '.git'))) held.push(dir);
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const path = join(dir, child.name);
    if (present(join(path, '.git'))) held.push(path);
    for (const grand of readdirSync(path, { withFileTypes: true })) {
      if (grand.isDirectory() && present(join(path, grand.name, '.git'))) held.push(join(path, grand.name));
    }
  }
  return held;
}

/** The entries of `exports/` that no receipt in `.mc-exports/` names: an interrupted creation, kept. */
function unregisteredExports(dir) {
  const exportsDir = join(dir, EXPORTS_DIR);
  if (!present(exportsDir)) return [];
  const registered = new Set(listReceipts(dir).map((entry) => entry.id));
  return readdirSync(exportsDir).filter((name) => !registered.has(name));
}

/**
 * (S-whole) Every runner session's scratch directory, read whole: its record, the newest mtime of it and
 * its direct entries, the git worktrees it holds, the exports no receipt names, and the references that
 * name it. Only when those leave it a candidate are the processes standing in it and the files open in it
 * read (one lsof each, and never for a directory a reference, a recent write or a live runner keeps).
 */
function gatherScratchSessions(facts, { roots, running, now, alive, commandLine, openIn }) {
  const refs = facts.scratch_refs;
  for (const stem of listNames(roots.scratch)) {
    const dir = join(roots.scratch, stem);
    const item = {
      path: dir, stem, marker: null, marker_error: null, marker_absent: false, runner_gone: null, newest_ms: null,
      worktrees: [], unregistered: [], named: [], identity: null, live: null, open: null, bytes: 0, error: null,
    };
    facts.scratch_sessions.push(item);
    try {
      const record = scratchRecord(dir);
      item.marker = record.marker;
      item.marker_error = record.error;
      item.marker_absent = record.absent;
      const stat = lstatSync(dir);
      item.identity = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
      item.newest_ms = untouchedMs(dir);
      item.worktrees = worktreesWithin(dir);
      item.unregistered = unregisteredExports(dir);
      item.named = namedBy(refs, stem);
      if (item.marker_error) continue;
      if (item.marker && !item.marker.ended) item.runner_gone = runnerGone(item.marker, { alive, commandLine });
      // The lsof answers are read only for a directory the planner could still take: the shortest window is 72 hours.
      const candidate = !refs.unreadable && item.named.length === 0 && item.unregistered.length === 0
        && (!item.marker || item.marker.ended || item.runner_gone) && item.newest_ms <= now - GENERATED_KEEP_MS;
      if (!candidate) continue;
      if (!running) throw new Error('lsof could not say who stands in it');
      item.live = [...new Set(processesStandingIn([dir], { cwds: running }).map((p) => p.pid))];
      if (item.live.length) continue;
      item.open = openIn(dir);
      if (Array.isArray(item.open) && item.open.length === 0) item.bytes = treeBytes(dir);
    } catch (error) { item.error = message(error); }
  }
}

/** The sessions root's `YYYY/MM/DD` path segments of a real path under it, or null when it is not under it. */
function codexRelative(real, base) {
  return real.startsWith(`${base}/`) ? real.slice(base.length + 1).split('/') : null;
}
const isCodexDay = (rel) => rel.length >= 3 && /^\d{4}$/u.test(rel[0]) && /^\d{2}$/u.test(rel[1]) && /^\d{2}$/u.test(rel[2]);

/**
 * (C) The Codex session transcripts under `<codex>/sessions/YYYY/MM/DD/`: each `*.jsonl` directly in a date
 * directory, judged by its mtime and by whether a process holds it open (`filesOpen`, one batch, and only
 * for those old enough to go). A symbolic link or a non-file is refused by name; every other entry is kept.
 * Nothing else under the Codex home is read.
 */
function gatherCodexSessions(facts, { roots, now, filesOpen }) {
  const base = roots.codex_sessions;
  const fail = (path, error) => facts.codex_errors.push({ path, error: message(error) });
  let top;
  try { top = lstatSync(base); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
    fail(base, error);
    return;
  }
  if (!top.isDirectory() || top.isSymbolicLink()) { fail(base, new Error('sessions root is not a regular directory')); return; }
  const transcripts = [];
  const listing = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch (error) { fail(dir, error); return []; } };
  for (const year of listing(base)) {
    const yearPath = join(base, year.name);
    if (!year.isDirectory() || !/^\d{4}$/u.test(year.name)) { facts.codex_other.push(yearPath); continue; }
    for (const month of listing(yearPath)) {
      const monthPath = join(yearPath, month.name);
      if (!month.isDirectory() || !/^\d{2}$/u.test(month.name)) { facts.codex_other.push(monthPath); continue; }
      for (const day of listing(monthPath)) {
        const dayPath = join(monthPath, day.name);
        if (!day.isDirectory() || !/^\d{2}$/u.test(day.name)) { facts.codex_other.push(dayPath); continue; }
        const entries = [];
        for (const entry of listing(dayPath)) {
          const path = join(dayPath, entry.name);
          entries.push(path);
          if (!entry.name.endsWith('.jsonl')) { facts.codex_other.push(path); continue; }
          const item = { path, mtime_ms: null, bytes: 0, identity: null, open: null, refused: null, error: null };
          transcripts.push(item);
          try {
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) item.refused = 'a symbolic link is not a target';
            else if (!stat.isFile()) item.refused = 'not a regular file';
            else {
              item.mtime_ms = stat.mtimeMs;
              item.bytes = stat.size;
              item.identity = { dev: stat.dev, ino: stat.ino, size: stat.size, mtime_ms: stat.mtimeMs };
            }
          } catch (error) { item.error = message(error); }
        }
        let mtime = null;
        let error = null;
        try { mtime = lstatSync(dayPath).mtimeMs; } catch (caught) { error = message(caught); }
        facts.codex_days.push({ path: dayPath, entries, mtime_ms: mtime, error });
      }
    }
  }
  const old = new Set(transcripts.filter((item) => !item.refused && !item.error && typeof item.mtime_ms === 'number'
    && item.mtime_ms <= now - CODEX_TRANSCRIPT_KEEP_MS).map((item) => item.path));
  if (old.size) {
    let opened = null;
    try { opened = filesOpen([...old]); } catch { /* uncertainty keeps every candidate */ }
    for (const item of transcripts) {
      if (old.has(item.path)) item.open = opened instanceof Map && Array.isArray(opened.get(item.path)) ? opened.get(item.path) : null;
    }
  }
  facts.codex_transcripts.push(...transcripts);
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

/**
 * (S-whole) A runner session's whole scratch directory. It goes only when it has ended (or its runner is
 * positively gone), has been untouched for seven days (72 hours in a pressure pass), and nothing keeps any
 * part of it: no reference, no process, no open file, no git worktree that is not going, and no S or B item
 * kept for its own reason (`own`). A reference always wins over age. Anything unknown keeps it.
 */
export function scratchWhole(item, { now, pressure = false, own = null, worktreesGoing = new Set(), refsUnreadable = null } = {}) {
  if (item.error) throw new Error(item.error);
  if (item.marker_error) return { target: false, why: `its scratch directory's ownership record cannot be read (${item.marker_error})`, rule: 'S' };
  const marker = item.marker;
  if (marker && (marker.schema !== SCRATCH_SCHEMA || marker.owner !== 'runner' || !marker.session || !marker.started)) {
    return { target: false, why: 'its scratch directory\'s owner is not clear', rule: 'S' };
  }
  if (marker && !marker.ended && !item.runner_gone) return { target: false, why: `${marker.session} has not recorded an end`, rule: 'S' };
  // A reference keeps the directory whatever its age, and its why is the reference (routine: most scratch is named by an unfinished goal).
  if (item.named?.length) {
    const more = item.named.length > 1 ? ` and ${item.named.length - 1} more` : '';
    return { target: false, why: `named by ${item.named[0]}${more}: kept until that goal is finished or the proposal leaves`, rule: 'S-named' };
  }
  const label = pressure ? '72 hours' : '7 days';
  if (typeof item.newest_ms !== 'number') throw new Error('could not tell when it was last touched');
  if (item.newest_ms > now - (pressure ? GENERATED_KEEP_MS : SCRATCH_WHOLE_MS)) return { target: false, why: `touched in the last ${label}`, rule: 'recent' };
  if (refsUnreadable) return { target: false, why: `error: a goal or proposal that may name it cannot be read (${refsUnreadable})`, rule: 'S-whole' };
  if (item.unregistered?.length) return { target: false, why: `an export no receipt names is kept (${item.unregistered[0]})`, rule: 'S' };
  if (own) return { target: false, why: `kept for its own reason by rule ${own.rule}: ${own.why}`, rule: own.rule };
  const held = (item.worktrees || []).filter((path) => !worktreesGoing.has(path));
  if (held.length) return { target: false, why: `still holds a git worktree (${held[0].slice(item.path.length + 1) || '.'})`, rule: 'S-whole' };
  if (item.live === null || item.live === undefined) throw new Error('could not tell whether a process stands in it');
  if (item.live.length) return { target: false, why: `process ${item.live.join(', ')} stands in it`, rule: 'S-whole' };
  if (!Array.isArray(item.open)) throw new Error('could not tell whether a file in it is open');
  if (item.open.length) return { target: false, why: `process ${item.open.join(', ')} holds a file open in it`, rule: 'S-whole' };
  const what = !marker ? 'a legacy scratch directory with no ownership record'
    : marker.ended ? `ended session ${marker.session}`
      : `session ${marker.session}, whose owning runner is gone (${item.runner_gone})`;
  return { target: true, why: `${what}, untouched for ${label}` };
}

/**
 * (C) A Codex session transcript: a regular `*.jsonl` older than seven days (its mtime) and not held open.
 * A recent one is kept as `recent`; a symbolic link or a non-file is kept by name.
 */
export function codexTranscript(item, { now }) {
  if (item.error) throw new Error(item.error);
  if (item.refused) return { target: false, why: item.refused, rule: 'C' };
  if (!(item.mtime_ms <= now - CODEX_TRANSCRIPT_KEEP_MS)) return { target: false, why: 'touched in the last 7 days', rule: 'recent' };
  if (item.open === null || item.open === undefined) throw new Error('could not tell whether a process holds it open');
  if (item.open.length) return { target: false, why: `process ${item.open.join(', ')} holds it open`, rule: 'C' };
  return { target: true, why: 'older than 7 days and not held open' };
}

/**
 * (C) A date directory, when every entry in it is a transcript this pass takes (`emptied`): it goes with them.
 * A date directory with no entry is removed only when it is itself untouched for seven days.
 */
export function codexDay(item, { now, emptied }) {
  if (item.error) throw new Error(item.error);
  if (item.entries.length === 0) {
    if (typeof item.mtime_ms !== 'number') throw new Error('could not tell when it was last touched');
    if (item.mtime_ms > now - CODEX_TRANSCRIPT_KEEP_MS) return { target: false, why: 'empty, touched in the last 7 days', rule: 'recent' };
    return { target: true, why: 'empty and untouched for 7 days' };
  }
  const stays = item.entries.filter((path) => !emptied.has(path));
  if (stays.length) return { target: false, why: `holds ${stays.length} kept ${stays.length === 1 ? 'entry' : 'entries'}, such as ${basename(stays[0])}`, rule: 'C' };
  return { target: true, why: 'emptied by its transcripts' };
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
  // What an S or B item keeps for its own reason, by the scratch session directory it lies in: S-whole then keeps that directory too.
  const ownKeeps = new Map();
  const holdOwn = (dir, rule, why) => { if (dir && !ownKeeps.has(dir)) ownKeeps.set(dir, { rule, why }); };
  const scratchDirOf = (path) => {
    const scratch = facts.roots?.scratch;
    if (!scratch || !path.startsWith(`${scratch}/`)) return null;
    return join(scratch, path.slice(scratch.length + 1).split('/')[0]);
  };

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
      common: item.wt.common, identity: item.wt.identity, activity: item.wt.activity, pushed: item.wt.pushed,
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
    } else {
      keep(item.path, 'S', verdict.why);
      holdOwn(item.session_dir, 'S', verdict.why);
    }
  }
  // (S) registered source exports: the same decision as a session's own release makes, on the facts read now.
  for (const item of facts.scratch_exports || []) {
    const verdict = judge(exportDecision, item);
    if (verdict.target) {
      targets.push({
        path: item.path, kind: 'scratch-export', rule: 'S', why: verdict.why, bytes: verdict.bytes || 0,
        owner_id: scratchOwner(item.marker), identity: verdict.identity,
      });
    } else {
      keep(item.path, 'S', verdict.why);
      if (item.receipt?.state !== 'released') holdOwn(item.stem_dir ?? item.path, 'S', verdict.why);
    }
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

  // (B) Exact rebuildable caches, with ownership/age and inactivity evidence. Read first: a cache B keeps keeps its scratch session whole.
  const cacheVerdicts = (facts.cache_items || []).map((item) => [item, rebuildableCache(item, facts.now)]);
  for (const [item, verdict] of cacheVerdicts) if (!verdict.target) holdOwn(scratchDirOf(item.path), 'B', verdict.why);

  // (S-whole) a runner session's whole scratch directory, decided after the S, export and B items it holds, so their own reasons keep it.
  const worktreesGoing = new Set(targets.filter((item) => item.kind === 'scratch-worktree').map((item) => item.path));
  for (const item of facts.scratch_sessions || []) {
    const inside = targets.filter((target) => target.path.startsWith(`${item.path}/`));
    const verdict = judge(scratchWhole, item, {
      now: facts.now, pressure, own: ownKeeps.get(item.path) ?? null, worktreesGoing,
      refsUnreadable: facts.scratch_refs?.unreadable ?? null,
    });
    if (verdict.target) {
      // Its worktrees and exports go first, through git and their own receipts; the bytes they hold are not counted twice.
      targets.push({
        path: item.path, kind: 'scratch-session', rule: 'S-whole', why: verdict.why,
        bytes: Math.max(0, (item.bytes || 0) - inside.reduce((sum, target) => sum + (target.bytes || 0), 0)), identity: item.identity,
      });
    } else keep(item.path, verdict.rule ?? 'S-whole', verdict.why);
  }

  for (const [item, verdict] of cacheVerdicts) {
    // A containing worktree/area, or a scratch session taken whole, already includes this cache in its removal and byte estimate.
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

  // (C) Codex session transcripts older than seven days and not held open, then the date directories they leave empty. A transcript comes first.
  for (const item of facts.codex_transcripts || []) {
    const verdict = judge(codexTranscript, item, { now: facts.now });
    if (verdict.target) targets.push({ path: item.path, kind: 'codex-transcript', rule: 'C', why: verdict.why, bytes: item.bytes || 0, identity: item.identity });
    else keep(item.path, verdict.rule ?? 'C', verdict.why);
  }
  const emptied = new Set(targets.filter((item) => item.kind === 'codex-transcript').map((item) => item.path));
  for (const item of facts.codex_days || []) {
    const verdict = judge(codexDay, item, { now: facts.now, emptied });
    if (verdict.target) targets.push({ path: item.path, kind: 'codex-session-day', rule: 'C', why: verdict.why, bytes: 0 });
    else keep(item.path, verdict.rule ?? 'C', verdict.why);
  }
  for (const item of facts.codex_errors || []) keep(item.path, 'C', `error: ${item.error}`);
  for (const path of facts.codex_other || []) keep(path, 'C-other', 'not a session transcript: rule C touches only sessions/YYYY/MM/DD/*.jsonl');

  return { days, person, targets, kept };
}

/**
 * (P) A registered goal checkout that may go: its goal cannot start a build or
 * review session now (`goalCannotStart`), or it is in `draft` (as before). A
 * blocked goal keeps its checkout while its obstacle awaits an owner.
 */
export function planGoalWorktree(item, { now, pressure = false } = {}) {
  if (item.error) return { target: false, why: `error: ${item.error}` };
  if (!item.wt) return { target: false, why: 'error: goal checkout identity could not be established' };
  const cannot = item.stage === 'draft' ? 'draft' : item.status === 'blocked' ? null : goalCannotStart(item);
  if (!cannot) {
    if (FINISHED.includes(item.stage)) return { target: false, why: `goal stage is ${item.stage}, which no session starts on` };
    if (item.status === 'blocked') return { target: false, why: 'goal is blocked: its checkout stays while its obstacle awaits an owner' };
    return { target: false, why: `goal stage is ${item.stage || 'unknown'}, not draft, and a session can start it` };
  }
  if (item.wt.activity >= now - GENERATED_KEEP_MS && !pressure) return { target: false, why: 'goal/worktree touched within the last 72 hours' };
  const pushed = item.wt.pushed
    ? ` (${item.wt.pushed.commits} ${item.wt.pushed.commits === 1 ? 'commit' : 'commits'}, all on ${item.wt.pushed.remote})`
    : '';
  if (cannot === 'draft') {
    return { target: true, why: pressure
      ? `clean inactive draft goal checkout${pushed} (pressure pass; age exception)`
      : `clean inactive draft goal checkout${pushed}, untouched for 72 hours` };
  }
  return { target: true, why: pressure
    ? `clean inactive goal checkout${pushed}, ${cannot} (pressure pass; age exception)`
    : `clean inactive goal checkout${pushed}, ${cannot}, untouched for 72 hours` };
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
  if (APPROVED_FILE_KINDS.includes(target.kind) || Object.hasOwn(CACHE_KIND_ROOT, target.kind)) {
    const rootStat = lstatSync(roots[key]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 'approved root is not a regular directory';
  }
  const base = realpathSync(roots[key]);
  if (APPROVED_FILE_KINDS.includes(target.kind) || Object.hasOwn(CACHE_KIND_ROOT, target.kind)) {
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
    'gate-cache-slug': parent === base,
    'gate-slug': parent === base,
    'selection-slug': parent === base,
    // `<gate-cache>/<slug>/<key>`: two levels down, as the entry of a repository's cache.
    'gate-cache-entry': dirname(parent) === base,
    // `<scratch>/<stem>/<worktree>` and `<scratch>/<stem>/DerivedData`.
    'scratch-worktree': dirname(parent) === base,
    'scratch-derived': dirname(parent) === base && name === DERIVED_DATA,
    // `<scratch>/<stem>/exports/<id>`: exactly three levels, no link on the way, and a receipt-shaped id.
    'scratch-export': exportShapeOk(target.path, roots.scratch) && real.startsWith(`${base}/`),
    'wrangler-log': parent === base && name.endsWith('.log') && lstatSync(real).isFile() && !lstatSync(real).isSymbolicLink(),
    'mc-shot': (parent === base || parent.startsWith(`${base}/`)) && name.endsWith('.png') && lstatSync(real).isFile() && !lstatSync(real).isSymbolicLink()
      && real.slice(base.length + 1).split('/').every((part) => !part.startsWith('.') && part !== 'sessions'),
    'codex-image': dirname(parent) === base && UUID_DIRECTORY.test(basename(parent)) && GENERATED_IMAGE.test(name) && lstatSync(real).isFile() && !lstatSync(real).isSymbolicLink(),
    // `<scratch>/<stem>`: the whole session directory, a real directory directly under the scratch root.
    'scratch-session': parent === base && lstatSync(real).isDirectory() && !lstatSync(real).isSymbolicLink(),
    // `<codex>/sessions/YYYY/MM/DD/<name>.jsonl`, and `<codex>/sessions/YYYY/MM/DD` (C).
    'codex-transcript': (() => { const rel = codexRelative(real, base); return rel?.length === 4 && isCodexDay(rel) && name.endsWith('.jsonl') && lstatSync(real).isFile() && !lstatSync(real).isSymbolicLink(); })(),
    'codex-session-day': (() => { const rel = codexRelative(real, base); return rel?.length === 3 && isCodexDay(rel) && lstatSync(real).isDirectory() && !lstatSync(real).isSymbolicLink(); })(),
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
  const scratch = new Map((facts.scratch_items || []).map((item) => [item.path, item]));
  const exportsByPath = new Map((facts.scratch_exports || []).map((item) => [item.path, item]));
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
      } else if (target.kind === 'scratch-session') {
        // Its worktrees went first, through git (the S items above); one still held keeps the whole directory.
        if (!again.identity || !sameEvidence(again.identity, target.identity)) { applied.push({ path, ok: false, why: 're-check: its directory was replaced or changed since the list' }); continue; }
        if (worktreesWithin(path).length) { applied.push({ path, ok: false, why: 're-check: it still holds a git worktree' }); continue; }
        remove(path);
      } else if (target.kind === 'codex-session-day') {
        // Only when empty now: the transcripts it held were removed first in this apply.
        if (readdirSync(path).length) { applied.push({ path, ok: false, why: 're-check: it is not empty' }); continue; }
        rmdirSync(path);
      } else if (APPROVED_FILE_KINDS.includes(target.kind)) {
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
            || wt.activity !== target.activity || !sameEvidence(wt.identity, target.identity) || !sameEvidence(wt.pushed ?? null, target.pushed ?? null)) {
            applied.push({ path, ok: false, why: `re-check: ${!verdict?.target ? verdict?.why || 'goal checkout disappeared or is no longer declared' : 'goal metadata, stage, worktree identity, HEAD, activity or pushed-branch evidence changed since the list'}` });
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
      } else if (target.kind === 'scratch-worktree') {
        // Retain even an unreferenced replay tip before handing the clean registered tree to git, without --force.
        const item = scratch.get(path);
        const owner = item?.owner;
        const git = doors.git || realGit;
        if (!owner || !retainReplayHead(owner, item.head, item.refs, git)) { applied.push({ path, ok: false, why: 'replay HEAD could not be retained in its owning repository' }); continue; }
        if (!removeWorktree(owner, path)) { applied.push({ path, ok: false, why: 'git worktree remove refused' }); continue; }
      } else if (target.kind === 'scratch-export') {
        // Its receipt, tree and dependency link are read again inside the removal; a changed identity keeps it.
        const item = exportsByPath.get(path);
        if (!item || !sameEvidence(again.identity, target.identity)) {
          applied.push({ path, ok: false, why: 're-check: its receipt, tree or dependency link changed since the list' });
          continue;
        }
        const outcome = withSessionLockSync(item.stem_dir, () => removeExport({
          stemDir: item.stem_dir, id: item.id, identity: target.identity,
          git: { text: doors.git || realGit }, repos: doors.repos || defaultRepos(env),
          standing: (candidate) => {
            const running = (doors.cwds || cwdsOfUser)();
            if (!running?.length || running.complete === false) return null;
            return processesStandingIn([candidate], { cwds: running }).map((p) => p.pid);
          },
          openIn: doors.openIn || openFilesIn,
          runnerGone: (marker) => runnerGone(marker, { alive: doors.alive || pidAlive, commandLine: doors.commandLine || commandLineOf }),
        }));
        if (!outcome.ok) { applied.push({ path, ok: false, why: outcome.why }); continue; }
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

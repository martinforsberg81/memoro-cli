/**
 * `mc work tidy` — every finished workarea, and every transcript nothing will
 * open again, in one list.
 *
 * Measured 2026-09-26: the data volume had 2.6 GB free of 228, and 17 GB came
 * back by hand. The same day an ad-hoc shell loop meant to remove orphaned
 * transcripts deleted nearly all of `~/.claude/projects` — every transcript
 * and every project's `memory/` — because a `find` that errored read as
 * "nothing here". So this is mostly about what is never removed:
 *
 *   - One list. `gatherTidyFacts` reads everything, the pure `tidyPlan`
 *     decides, `applyTidy` executes the plan it is handed. The dry run and the
 *     apply are the same list.
 *   - A question that fails means keep. Every fact is gathered per item; an
 *     exception keeps that item and says so.
 *   - Only two shapes are ever deleted under `~/.claude/projects`: a
 *     `<uuid>.jsonl` and a `<uuid>/` beside it. `memory/` and everything else
 *     there is never opened.
 *   - Only git worktrees are released: an area holding anything else —
 *     `runner`, `proposals`, `bin`, somebody's notes — is never handed to
 *     `releaseWorkArea`, whose non-git branch would `rmSync` it.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { mergedPullAtTip } from './branch-landed.js';
import {
  SESSION_ID, claudeHome, deleteConversation, listConversations, readHead, treeBytes,
} from './conversations.js';
import { log } from './logger.js';
import { PLAN_HOME, workRoot } from './paths.js';
import { listEntries } from './register.js';
import { areaRoleName, reservedRoleName } from './roles.js';
import { cwdsOfUser, processesStandingIn } from './standing.js';
import {
  OWN_MARKS, inspectWorktree, listWorkAreas, releaseVerdict, releaseWorkArea,
} from './work-area.js';

export const DEFAULT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSCRIPT = /^(.+)\.jsonl$/u;

/**
 * Why an area is not looked into at all, or null. Shared by the gathering —
 * so a skipped area never costs a `gh` call — and by `tidyPlan`, so the rule
 * is tested where it is decided.
 */
export function areaSkip(area, stepsLeft = new Map()) {
  if (area.role_home) return { why: 'a role home', rule: 'role-home' };
  if (area.foreign?.length) {
    const [first, second, third, ...more] = area.foreign;
    const detail = [first, second, third].filter(Boolean).join(', ') + (more.length ? ` and ${more.length} more` : '');
    return { why: 'holds something that is not a git worktree', detail, rule: 'foreign' };
  }
  if (stepsLeft.get(area.name)) {
    return { why: `project ${area.name} has steps left`, reason: 'a register project with steps left', rule: 'project' };
  }
  return null;
}

/**
 * The area a transcript's cwd belongs to: the first segment below the work
 * root, or `plan/<programme>` under `PLAN_HOME`. Null outside the work root,
 * and for the root itself.
 */
export function areaOf(cwd, root) {
  if (typeof cwd !== 'string' || !cwd.startsWith(`${root}/`)) return null;
  const [first, second] = cwd.slice(root.length + 1).split('/');
  if (!first) return null;
  if (first === PLAN_HOME) return second ? `${PLAN_HOME}/${second}` : null;
  return first;
}

/* ------------------------------------------------------------ gathering */

/**
 * Everything the plan is decided from, read now. `gh(args)` is handed to
 * `mergedPullAtTip`; `now` is the clock the ages are measured against.
 */
export function gatherTidyFacts({ env = process.env, now = Date.now(), gh = null } = {}) {
  const root = workRoot(env);
  const projects = join(claudeHome(env), 'projects');
  const facts = { now, work_root: root, projects_root: projects, register: [], areas: [], transcripts: [], leftovers: [] };

  try {
    facts.register = listEntries(root).map((entry) => ({
      project: entry.project,
      steps_left: entry.steps.filter((step) => step.status !== 'done').length,
    }));
  } catch (error) {
    // Without the register no area can be told apart from a project in
    // flight, so none is looked into.
    facts.register_error = message(error);
  }
  const stepsLeft = new Map(facts.register.map((item) => [item.project, item.steps_left]));

  // One lsof for every worktree. It always sees this process, so an empty
  // answer is lsof failing — and then nothing can be said to be unused.
  let cwds = null;
  try { cwds = cwdsOfUser(); } catch { cwds = null; }
  if (cwds && cwds.length === 0) cwds = null;
  const inUse = (path) => {
    if (!cwds) throw new Error('lsof reported no processes');
    const pids = [...new Set(processesStandingIn([path], { cwds }).map((item) => item.pid))];
    return [...new Set(pids.map(commandOf))];
  };
  const pullAtTip = (wt) => mergedPullAtTip(wt.path, wt.branch, gh ? { gh } : {});

  // `git: false`: the areas that are skipped (`node_modules` among them, with
  // hundreds of subdirectories) are never asked of git.
  for (const listed of listWorkAreas(env, { conversations: false, git: false })) {
    const area = { name: listed.name, path: listed.path, role_home: false, foreign: [], worktrees: [], conversations: [] };
    facts.areas.push(area);
    try {
      area.role_home = reservedRoleName(listed.name) && Boolean(areaRoleName(listed.path));
      const checkouts = [];
      for (const entry of readdirSync(listed.path, { withFileTypes: true })) {
        if (OWN_MARKS.has(entry.name)) continue;
        const path = join(listed.path, entry.name);
        if (isCheckout(path, entry)) checkouts.push({ repo: entry.name, path });
        else area.foreign.push(entry.name);
      }
      if (facts.register_error) { area.error = `the register could not be read — ${facts.register_error}`; continue; }
      if (areaSkip(area, stepsLeft)) continue;
      for (const checkout of checkouts) {
        const item = { path: checkout.path, repo: checkout.repo, branch: null, bytes: 0, verdict: null };
        area.worktrees.push(item);
        try {
          const wt = inspectWorktree(checkout.path, checkout.repo);
          if (!wt.is_git) { area.foreign.push(checkout.repo); continue; }
          item.branch = wt.branch;
          item.verdict = releaseVerdict(wt, { inUse: inUse(checkout.path), pullAtTip });
          if (item.verdict.remove) item.bytes = treeBytes(checkout.path);
        } catch (error) { item.error = message(error); }
      }
      // What release takes with an area it empties: its conversations. Asked
      // only then, and listed, so the dry run names them too.
      if (area.worktrees.length && area.worktrees.every((item) => item.verdict?.remove)) {
        area.conversations = listConversations(listed.path, env)
          .map(({ tool, id, path, bytes }) => ({ tool, id, path, bytes }));
      }
    } catch (error) { area.error = message(error); }
  }

  let dirs = [];
  try { dirs = readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { dirs = []; }
  for (const dir of dirs) {
    const directory = join(projects, dir.name);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
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

/** A directory with its own `.git` — a checkout, not a directory inside one. */
function isCheckout(path, entry) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) return false;
  try { lstatSync(join(path, '.git')); return true; } catch { return false; }
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

/* ------------------------------------------------------------- deciding */

/**
 * The list, pure. `{ worktrees, transcripts, leftovers, kept }`, each item
 * with `path`, `bytes` and `why`; a kept item's `rule` says which rule kept
 * it (`T1`, `T2`, `T5` and `recent` are the quiet ones).
 */
export function tidyPlan(facts, { days = DEFAULT_DAYS } = {}) {
  const cutoff = facts.now - days * DAY_MS;
  const worktrees = [];
  const transcripts = [];
  const leftovers = [];
  const kept = [];
  const stepsLeft = new Map((facts.register || []).map((item) => [item.project, item.steps_left]));
  const couldNot = (path, error) => kept.push({ path, bytes: 0, why: `could not tell — ${error}`, rule: 'error' });

  // Transcripts that go with an area release empties.
  const covered = new Set();
  for (const area of facts.areas || []) {
    if (area.error) { couldNot(area.path, area.error); continue; }
    const skip = areaSkip(area, stepsLeft);
    if (skip) { kept.push({ path: area.path, bytes: 0, ...skip }); continue; }
    const going = [];
    for (const wt of area.worktrees) {
      if (wt.error) { couldNot(wt.path, wt.error); continue; }
      // Only a worktree and its branch; a directory is never released here.
      if (!wt.verdict?.remove || wt.verdict.what !== 'worktree and branch') {
        const why = wt.verdict?.why || 'not a git worktree';
        kept.push({ path: wt.path, bytes: 0, why, reason: releaseReason(why), rule: 'release' });
        continue;
      }
      const pr = wt.verdict.landed_by?.pr;
      going.push({
        path: wt.path, bytes: wt.bytes || 0, area: area.name, repo: wt.repo, branch: wt.branch,
        why: pr ? `#${pr} merged at this tip` : 'its content is on main',
      });
    }
    worktrees.push(...going);
    if (going.length && going.length === area.worktrees.length) {
      const conversations = area.conversations || [];
      for (const item of conversations) if (item.path) covered.add(item.path);
      worktrees.push({
        path: area.path,
        bytes: conversations.reduce((sum, item) => sum + (item.bytes || 0), 0),
        area: area.name,
        conversations,
        why: conversations.length
          ? `the area itself, with its ${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`
          : 'the area itself',
      });
    }
  }

  // Each area's newest transcript, whatever its age (T4).
  const newest = new Map();
  for (const item of facts.transcripts || []) {
    if (item.error || !item.cwd) continue;
    const area = areaOf(item.cwd, facts.work_root);
    if (!area) continue;
    const best = newest.get(area);
    if (!best || item.mtime_ms > best.mtime_ms) newest.set(area, item);
  }
  for (const item of facts.transcripts || []) {
    if (covered.has(item.path)) continue;
    const base = { path: item.path, bytes: item.bytes || 0, id: item.id };
    if (item.error) { couldNot(item.path, item.error); continue; }
    // T1: no cwd, or a head that could not be read.
    if (!item.cwd) { kept.push({ ...base, why: 'no cwd in its head', rule: 'T1' }); continue; }
    // T2: touched within the window.
    if (!(item.mtime_ms <= cutoff)) { kept.push({ ...base, why: `touched in the last ${days} days`, rule: 'T2' }); continue; }
    // T3: where it ran is gone. `null` is a stat that failed, not an absence.
    if (item.cwd_exists === null || item.cwd_exists === undefined) { couldNot(item.path, 'whether its directory exists'); continue; }
    if (item.cwd_exists === false) { transcripts.push({ ...base, why: 'its directory is gone' }); continue; }
    // T4: inside the work root, only each area's latest is kept.
    const area = areaOf(item.cwd, facts.work_root);
    if (area) {
      if (newest.get(area) === item) kept.push({ ...base, why: 'its workarea\'s latest', rule: 'T4' });
      else transcripts.push({ ...base, why: `older than ${days} days and not ${area}'s latest` });
      continue;
    }
    // T5: anything else.
    kept.push({ ...base, why: 'outside the work root', rule: 'T5' });
  }

  for (const item of facts.leftovers || []) {
    if (item.error) { couldNot(item.path, item.error); continue; }
    if (!(item.newest_ms <= cutoff)) { kept.push({ path: item.path, bytes: 0, why: `touched in the last ${days} days`, rule: 'recent' }); continue; }
    leftovers.push({ path: item.path, bytes: item.bytes || 0, why: 'left behind by an earlier delete' });
  }

  const bySize = (a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path);
  return {
    days,
    projects_root: facts.projects_root,
    worktrees: worktrees.sort(bySize),
    transcripts: transcripts.sort(bySize),
    leftovers: leftovers.sort(bySize),
    kept,
  };
}

/** Release's reasons without their counts, so the printout can group them. */
function releaseReason(why) {
  if (/uncommitted$/u.test(why)) return 'uncommitted changes';
  if (/main lacks$/u.test(why)) return 'commits main lacks';
  if (/^in use by /u.test(why)) return 'in use';
  return why;
}

/* ------------------------------------------------------------ executing */

/**
 * Remove exactly the plan. Returns `{ removed: { worktrees, transcripts,
 * leftovers }, failed, bytes }`; `bytes` is what the removed items weighed.
 * `release` and `remove` are the doors, injectable for tests.
 */
export function applyTidy(plan, { env = process.env, release = releaseWorkArea, remove = deleteConversation } = {}) {
  const removed = { worktrees: [], transcripts: [], leftovers: [] };
  const failed = [];
  const projects = plan.projects_root || join(claudeHome(env), 'projects');

  const byArea = new Map();
  for (const item of plan.worktrees) {
    if (!byArea.has(item.area)) byArea.set(item.area, []);
    byArea.get(item.area).push(item);
  }
  for (const [name, items] of byArea) {
    // Release decides again when it runs. What it would do now is asked
    // first, and an area where it would take anything the plan did not name
    // is left whole: the apply never does more than the dry run printed.
    let surprise = null;
    try {
      const planned = new Set(items.filter((item) => !item.conversations).map((item) => item.path));
      const conversations = new Set(items.flatMap((item) => (item.conversations || []).map((c) => c.id)));
      const now = release(name, { env, dryRun: true });
      const extra = [
        ...now.removed.filter((item) => item.what !== 'worktree and branch' || !planned.has(item.path)).map((item) => item.path),
        ...now.conversations.filter((item) => !conversations.has(item.id)).map((item) => item.id),
      ];
      if (extra.length) surprise = `release would now also take ${extra.join(', ')}`;
      if (!surprise) release(name, { env, dryRun: false });
    } catch (error) { surprise = message(error); }
    for (const item of items) {
      if (!surprise && !present(item.path)) removed.worktrees.push(item);
      else failed.push({ path: item.path, why: surprise || 'still there after release' });
    }
  }

  for (const item of plan.transcripts) {
    const id = TRANSCRIPT.exec(basename(item.path))?.[1];
    if (!id || !SESSION_ID.test(id) || dirname(dirname(item.path)) !== projects) {
      failed.push({ path: item.path, why: 'not a transcript under projects/' });
      continue;
    }
    const result = remove({ tool: 'claude-code', id, path: item.path }, env);
    if (result.ok && !present(item.path)) removed.transcripts.push(item);
    else failed.push({ path: item.path, why: result.reason || 'still there' });
  }

  for (const item of plan.leftovers) {
    // Asserted again at the moment of removal: a `<uuid>` directory directly
    // inside a project directory, and nothing else.
    let shape = false;
    try {
      shape = SESSION_ID.test(basename(item.path))
        && dirname(dirname(item.path)) === projects
        && lstatSync(item.path).isDirectory();
    } catch { shape = false; }
    if (!shape) { failed.push({ path: item.path, why: 'not a <uuid>/ under projects/' }); continue; }
    try {
      rmSync(item.path, { recursive: true, force: true });
      removed.leftovers.push(item);
    } catch (error) { failed.push({ path: item.path, why: message(error) }); }
  }

  const bytes = [...removed.worktrees, ...removed.transcripts, ...removed.leftovers]
    .reduce((sum, item) => sum + (item.bytes || 0), 0);
  log('work-tidy', {
    worktrees: removed.worktrees.length,
    transcripts: removed.transcripts.length,
    leftovers: removed.leftovers.length,
    bytes,
    failed: failed.length,
  });
  return { removed, failed, bytes };
}

function present(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

/** `~/mc/x` rather than `/Users/…/mc/x`. */
export function shortPath(path, home = homedir()) {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

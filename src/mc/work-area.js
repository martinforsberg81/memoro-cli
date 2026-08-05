/**
 * A piece of work is a directory under `~/mc`.
 *
 * Everything about it is derived, never stored: the worktrees it spans are the
 * directories under it, their branches come from git, and whether a thing can
 * be released is a question git answers at the moment of asking. The only file
 * mc writes is `.mc.json` at the work-area root — the tool conversation, which
 * is the one fact no other system holds. It sits above the worktrees, so it is
 * never inside a repository.
 *
 * There are no gates here. Nothing refuses. `release` removes what git says is
 * safe to remove and reports what it left, because a tool that blocks on its
 * own bookkeeping is what made the previous design unusable.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { workAreaPath, workAreaStatePath, workRoot } from './paths.js';

export function listWorkAreas(env = process.env) {
  const root = workRoot(env);
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
  return names.map((name) => inspectWorkArea(name, env));
}

export function inspectWorkArea(name, env = process.env) {
  const path = workAreaPath(name, env);
  const worktrees = [];
  let entries = [];
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { /* the work area may not exist yet */ }
  for (const entry of entries) {
    worktrees.push(inspectWorktree(join(path, entry), entry));
  }
  return { name, path, exists: existsSync(path), state: readState(name, env), worktrees };
}

/** Everything here is asked of git now, not remembered from before. */
export function inspectWorktree(path, repo) {
  const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = git(path, ['status', '--porcelain']);
  const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const upstreamMerged = branch && branch !== 'HEAD'
    ? git(path, ['log', '--oneline', `origin/main..${branch}`])
    : null;
  return {
    repo,
    path,
    is_git: Boolean(common),
    branch: branch && branch !== 'HEAD' ? branch : null,
    git_common_dir: common,
    uncommitted: dirty ? dirty.split('\n').filter(Boolean).length : 0,
    unmerged_commits: upstreamMerged ? upstreamMerged.split('\n').filter(Boolean).length : 0,
  };
}

export function createWorkArea(name, env = process.env) {
  const path = workAreaPath(name, env);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function addWorktree({ name, repo, branch, from = null, env = process.env } = {}) {
  const area = createWorkArea(name, env);
  const target = join(area, repoName(repo));
  if (existsSync(target)) return { ok: false, reason: 'worktree-already-there', path: target };
  const args = ['-C', repo, 'worktree', 'add'];
  if (branch) args.push('-b', branch, target, ...(from ? [from] : []));
  else args.push(target);
  try {
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { ok: false, reason: firstLine(error), path: target };
  }
  return { ok: true, path: target, branch: branch || null };
}

/**
 * Remove what git says can go, keep what it says cannot, and say which.
 *
 * A worktree with uncommitted work stays. A branch with commits that are not
 * on `origin/main` stays. Neither stops the rest from being released, and
 * neither is an error — it is the work still being work.
 */
export function releaseWorkArea(name, { env = process.env, dryRun = false } = {}) {
  const area = inspectWorkArea(name, env);
  const removed = [];
  const kept = [];
  for (const worktree of area.worktrees) {
    if (!worktree.is_git) {
      if (!dryRun) rmSync(worktree.path, { recursive: true, force: true });
      removed.push({ ...worktree, what: 'directory' });
      continue;
    }
    if (worktree.uncommitted > 0) {
      kept.push({ ...worktree, why: `${worktree.uncommitted} uncommitted` });
      continue;
    }
    if (worktree.unmerged_commits > 0) {
      kept.push({ ...worktree, why: `${worktree.unmerged_commits} unmerged` });
      continue;
    }
    if (!dryRun) {
      const common = worktree.git_common_dir;
      run(['--git-dir', common, 'worktree', 'remove', '--', worktree.path]);
      if (worktree.branch) run(['--git-dir', common, 'branch', '-d', worktree.branch]);
    }
    removed.push({ ...worktree, what: 'worktree and branch' });
  }
  // When everything is released the work area has nothing left to be, so it
  // goes too — but only if it is genuinely empty. Anything the user put there
  // by hand keeps the directory alive.
  if (!dryRun && kept.length === 0 && area.exists) {
    try { rmSync(workAreaStatePath(name, env), { force: true }); } catch { /* absent */ }
    try {
      if (readdirSync(area.path).length === 0) rmSync(area.path, { recursive: true, force: true });
    } catch { /* leave it */ }
  }
  return { name, removed, kept, dry_run: dryRun };
}

export function readState(name, env = process.env) {
  try { return JSON.parse(readFileSync(workAreaStatePath(name, env), 'utf8')); } catch { return {}; }
}

export function writeState(name, patch, env = process.env) {
  const current = readState(name, env);
  const next = { ...current, ...patch };
  createWorkArea(name, env);
  writeFileSync(workAreaStatePath(name, env), `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  return next;
}

/** Let git tidy its own registrations rather than mc policing them. */
export function pruneWorktrees(repos = []) {
  for (const repo of repos) run(['-C', repo, 'worktree', 'prune']);
}

function repoName(repo) {
  return repo.replace(/\/+$/u, '').split('/').pop() || 'repo';
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function run(args) {
  try { execFileSync('git', args, { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
}

function firstLine(error) {
  const text = error?.stderr?.toString?.() || error?.message || String(error);
  return text.split('\n').find(Boolean)?.slice(0, 200) || 'unknown';
}

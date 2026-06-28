/**
 * Lightweight git shell-outs used by mc lifecycle commands.
 *
 * Synchronous on purpose — git operations are fast (<50ms each) and the
 * dispatch / command layer is itself synchronous in shape. Async would
 * just add ceremony without latency wins.
 */
import { spawnSync } from 'node:child_process';

export function git(cwd, args, { allowFailure = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    if (allowFailure) return null;
    const err = new Error(
      `git ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').trim()}`,
    );
    err.code = r.status;
    err.stderr = r.stderr;
    throw err;
  }
  return (r.stdout || '').trim();
}

export function tryGit(cwd, args) {
  return git(cwd, args, { allowFailure: true });
}

export function isInsideRepo(cwd) {
  return tryGit(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function observeWorktree(worktreePath, { now = () => new Date().toISOString() } = {}) {
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    return { ok: false, reason: 'missing-worktree-path' };
  }
  if (!isInsideRepo(worktreePath)) {
    return { ok: false, reason: 'not-a-git-worktree', worktree_path: worktreePath };
  }

  const branch = tryGit(worktreePath, ['branch', '--show-current']) || null;
  const head = tryGit(worktreePath, ['rev-parse', 'HEAD']) || null;
  const gitRoot = tryGit(worktreePath, ['rev-parse', '--show-toplevel']) || worktreePath;
  const porcelain = tryGit(worktreePath, ['status', '--porcelain']);
  const upstream = tryGit(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const aheadBehind = upstream
    ? parseAheadBehind(tryGit(worktreePath, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]))
    : { ahead: null, behind: null };

  return {
    ok: true,
    worktree_path: worktreePath,
    git_root: gitRoot,
    current_branch: branch,
    detached: !branch,
    head,
    dirty_files: countPorcelainFiles(porcelain),
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    observed_at: now(),
  };
}

/**
 * Return the primary worktree's path. From inside a worktree, git's
 * `worktree list --porcelain` lists the primary first.
 */
export function primaryWorktree(cwd) {
  const out = tryGit(cwd, ['worktree', 'list', '--porcelain']);
  if (!out) return null;
  const first = out.split('\n\n')[0];
  const m = first.match(/^worktree\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * True if the branch exists locally.
 */
export function branchExists(cwd, branch) {
  const r = tryGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r !== null;
}

/**
 * True if the worktree at `path` has uncommitted changes (tracked +
 * untracked). Cheap: just `git status --porcelain`.
 */
export function isDirty(worktreePath) {
  const r = tryGit(worktreePath, ['status', '--porcelain']);
  if (r === null) return false; // not a repo / inaccessible → treat as clean
  return r.length > 0;
}

/**
 * Count of commits on `branch` not in `mainRef`. 0 means the branch is
 * fully merged (or has been squash-merged so the changes are equivalent
 * but the commits aren't — see squash-phantom.js for that distinction).
 */
export function commitsAhead(repoDir, branch, mainRef = 'origin/main') {
  const r = tryGit(repoDir, ['rev-list', '--count', `${mainRef}..${branch}`]);
  if (r === null) return 0;
  const n = Number(r);
  return Number.isFinite(n) ? n : 0;
}

function countPorcelainFiles(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  return value.split('\n').filter(Boolean).length;
}

function parseAheadBehind(value) {
  if (typeof value !== 'string') return { ahead: null, behind: null };
  const [behindRaw, aheadRaw] = value.trim().split(/\s+/);
  const behind = Number(behindRaw);
  const ahead = Number(aheadRaw);
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

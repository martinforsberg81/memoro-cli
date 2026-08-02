/**
 * A session worktree that checks out its repository's DEFAULT branch takes
 * that ref hostage: the primary checkout ends up detached and, when the
 * global mc is a symlink into it, silently serves stale code (incident
 * 2026-08-02, the `codex-sqlite-retry` squat). mc never polices what a
 * user's tools do inside a session — it repairs its own layout afterwards,
 * and only loss-free: a clean worktree whose HEAD is already reachable
 * from the default branch's ref is detached in place (identical files,
 * same commit, only the branch pointer association changes); anything
 * else is reported with the exact state that blocks the repair.
 *
 * The scan walks mc's worktree root on DISK, not the registry — the
 * incident's squatter had no registry row at all.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import { primaryWorktree, resolveDefaultBranch, tryGit } from './git.js';

export function scanDefaultBranchSquatters({ mcDir = mcHome() } = {}) {
  const root = join(mcDir, 'worktrees');
  const squatters = [];
  for (const repoGroup of listDirs(root)) {
    for (const worktree of listDirs(repoGroup)) {
      const branch = tryGit(worktree, ['symbolic-ref', '-q', '--short', 'HEAD']);
      if (!branch) continue; // detached or not a git worktree: nothing held hostage
      const primary = primaryWorktree(worktree);
      if (!primary || samePath(primary, worktree)) continue;
      const resolved = resolveDefaultBranch(primary);
      if (!resolved?.ok || resolved.branch !== branch) continue;
      const clean = (tryGit(worktree, ['status', '--porcelain']) || '') === '';
      const head = tryGit(worktree, ['rev-parse', 'HEAD']);
      squatters.push({
        worktree_path: worktree,
        primary,
        branch,
        clean,
        head_reachable: Boolean(head && defaultBranchContains(worktree, branch, head)),
      });
    }
  }
  return squatters;
}

export function repairDefaultBranchSquatters(squatters, { apply = true } = {}) {
  const fixed = [];
  const issues = [];
  for (const item of squatters) {
    if (!item.clean || !item.head_reachable) {
      issues.push({
        severity: 'warning',
        code: 'session-worktree-holds-default-branch',
        worktree_path: item.worktree_path,
        branch: item.branch,
        reason: item.clean ? 'head-not-on-default-branch' : 'worktree-dirty',
        hint: `commit or stash inside ${item.worktree_path}, then rerun mc doctor`,
      });
      continue;
    }
    if (apply) {
      const detached = tryGit(item.worktree_path, ['switch', '--detach']);
      if (detached === null) {
        issues.push({
          severity: 'warning',
          code: 'session-worktree-holds-default-branch',
          worktree_path: item.worktree_path,
          branch: item.branch,
          reason: 'detach-failed',
          hint: `git -C ${item.worktree_path} switch --detach`,
        });
        continue;
      }
    }
    fixed.push({
      code: 'default-branch-freed',
      worktree_path: item.worktree_path,
      branch: item.branch,
    });
  }
  return { fixed, issues };
}

// Reachability from the ref itself (or its upstream) is what makes the
// detach loss-free: the commit stays named by the default branch either
// way, so no work is only reachable from this worktree's HEAD.
function defaultBranchContains(worktree, branch, head) {
  return tryGit(worktree, ['merge-base', '--is-ancestor', head, `refs/heads/${branch}`]) !== null
    || tryGit(worktree, ['merge-base', '--is-ancestor', head, `origin/${branch}`]) !== null;
}

function listDirs(root) {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function samePath(a, b) {
  return join(a, '.') === join(b, '.');
}

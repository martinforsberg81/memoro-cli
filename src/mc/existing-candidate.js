/**
 * Borrow a branch's clean, idle checkout for a merge measurement. A branch no
 * checkout holds gets one restored (once, kept), never a throwaway worktree.
 */
import { basename, join } from 'node:path';
import { cwdsOfUser, processesStandingIn } from './standing.js';
import { workRoot } from './paths.js';
import { ownAncestry } from './work-stop.js';

const text = (run) => String(run?.stdout || '').trim();
const failure = (run) => run?.error?.message || String(run?.stderr || '').trim() || `git exited ${run?.status}`;

/**
 * Where a branch's restored checkout lives: stable per repository and branch,
 * and under the work root. The shared dependency tree is `~/mc/node_modules`,
 * found by walking up from the worktree; a checkout outside the work root
 * (it was `~/.memoro/mc/checkouts` until 2026-11-09) resolves none of it and
 * the round stops at `dependencies`.
 */
export function restoredCheckoutPath(repoPath, branch, root = workRoot()) {
  return join(root, 'checkouts', basename(repoPath).replace(/\.git$/u, ''), branch.replace(/[^A-Za-z0-9._-]+/gu, '-'));
}

async function restoreCheckout({ repoPath, branch, sha, git, root }) {
  const ref = `refs/heads/${branch}`;
  const local = await git(['rev-parse', '--verify', '-q', ref], { cwd: repoPath });
  if (local.status !== 0) {
    const made = await git(['branch', '--no-track', branch, sha], { cwd: repoPath });
    if (made.status !== 0) return { ok: false, reason: `no checkout of ${branch} and could not create the branch at ${sha}: ${failure(made)}` };
  } else if (text(local) !== sha) {
    // Held by nobody, so it may move forward to the pushed head, never anywhere else.
    const ahead = await git(['merge-base', '--is-ancestor', text(local), sha], { cwd: repoPath });
    if (ahead.status !== 0) return { ok: false, reason: `no checkout of ${branch} and the local branch is not behind the pushed head ${sha}` };
    const moved = await git(['update-ref', ref, sha, text(local)], { cwd: repoPath });
    if (moved.status !== 0) return { ok: false, reason: `could not advance ${branch} to ${sha}: ${failure(moved)}` };
  }
  const dir = restoredCheckoutPath(repoPath, branch, root);
  await git(['worktree', 'prune'], { cwd: repoPath });
  const added = await git(['worktree', 'add', dir, branch], { cwd: repoPath });
  if (added.status !== 0) return { ok: false, reason: `could not restore a checkout of ${branch} at ${dir}: ${failure(added)}` };
  return { ok: true, dir };
}

export async function existingCandidate({ repoPath, branch, sha, git, restoreGit = git, cwds = cwdsOfUser, root = workRoot() }) {
  const listed = await git(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath });
  if (listed.status !== 0) return { ok: false, reason: failure(listed) };
  const ref = `refs/heads/${branch}`;
  const records = String(listed.stdout || '').split('\0\0').map((record) => record.split('\0'));
  let record = records.find((fields) => fields.includes(`branch ${ref}`));
  let dir = record?.find((field) => field.startsWith('worktree '))?.slice(9);
  if (!dir) {
    // Nothing holds the branch (cleanup removed its checkout, or it never had
    // one): give it one checkout, kept from now on like any other.
    const made = await restoreCheckout({ repoPath, branch, sha, git, root });
    if (!made.ok) return made;
    dir = made.dir;
    record = [];
  }
  if (record.some((field) => /^(locked|prunable)( |$)/u.test(field))) {
    return { ok: false, reason: `${dir} is locked or prunable` };
  }
  const idle = () => {
    let standing;
    try { standing = cwds(); } catch { /* unknown is not idle */ }
    if (!Array.isArray(standing) || standing.complete === false) return `could not establish whether ${dir} is idle`;
    let busy = processesStandingIn([dir], { cwds: standing });
    // The synchronous caller and its waiting ancestors handed over this tree.
    if (busy.length) {
      const requesting = ownAncestry();
      busy = busy.filter(({ pid }) => !requesting.has(pid));
    }
    return busy.length ? `${dir} is in use by pid ${busy.map((p) => p.pid).join(', ')}` : null;
  };
  const inUse = idle();
  if (inUse) return { ok: false, reason: inUse };
  const at = await git(['rev-parse', 'HEAD'], { cwd: dir });
  if (at.status !== 0 || text(at) !== sha) return { ok: false, reason: `${dir} is not at the requested head ${sha}` };
  const status = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: dir });
  if (status.status !== 0 || text(status)) return { ok: false, reason: `${dir} has uncommitted changes or its status could not be read` };
  for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if ((await git(['rev-parse', '--verify', '-q', operation], { cwd: dir })).status === 0) {
      return { ok: false, reason: `${dir} has an unfinished ${operation}` };
    }
  }
  let started = false;
  return {
    ok: true, dir,
    async start(at = sha) {
      // Remember before the await: an interrupted checkout must also be restored.
      started = true;
      const run = await git(['checkout', '--detach', at], { cwd: dir });
      return run.status === 0 ? { ok: true } : { ok: false, reason: failure(run) };
    },
    async restore({ advanceTo = null } = {}) {
      try {
        if (!started) return { ok: true };
        const inUse = idle();
        if (inUse) return { ok: false, reason: `${inUse}; retained with detached HEAD` };
        if ((await restoreGit(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], { cwd: dir })).status === 0) {
          const aborted = await restoreGit(['merge', '--abort'], { cwd: dir });
          if (aborted.status !== 0) return { ok: false, reason: `could not abort the merge in ${dir}: ${failure(aborted)}` };
        }
        const status = await restoreGit(['status', '--porcelain', '--untracked-files=all'], { cwd: dir });
        if (status.status !== 0 || text(status)) {
          return { ok: false, reason: `${dir} has changes after measurement (${text(status) || failure(status)}); retained with detached HEAD — restore ${branch} after inspecting them` };
        }
        const branchAt = await restoreGit(['rev-parse', ref], { cwd: repoPath });
        if (branchAt.status !== 0 || text(branchAt) !== sha) {
          return { ok: false, reason: `${branch} moved while ${dir} was borrowed; retained with detached HEAD` };
        }
        if (advanceTo) {
          const advanced = await restoreGit(['update-ref', ref, advanceTo, sha], { cwd: repoPath });
          if (advanced.status !== 0) return { ok: false, reason: `could not advance ${branch} to its pushed head: ${failure(advanced)}` };
        }
        const restored = await restoreGit(['checkout', '--no-guess', branch], { cwd: dir });
        if (restored.status !== 0) return { ok: false, reason: `could not restore ${branch} in ${dir}: ${failure(restored)}` };
        started = false;
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: `could not restore ${branch} in ${dir}: ${error.message}` };
      }
    },
  };
}

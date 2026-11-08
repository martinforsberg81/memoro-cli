/** Borrow a branch's clean, idle checkout for a merge measurement. Never add a worktree. */
import { cwdsOfUser, processesStandingIn } from './standing.js';
import { ownAncestry } from './work-stop.js';

const text = (run) => String(run?.stdout || '').trim();
const failure = (run) => run?.error?.message || String(run?.stderr || '').trim() || `git exited ${run?.status}`;

export async function existingCandidate({ repoPath, branch, sha, git, restoreGit = git, cwds = cwdsOfUser }) {
  const listed = await git(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath });
  if (listed.status !== 0) return { ok: false, reason: failure(listed) };
  const ref = `refs/heads/${branch}`;
  const records = String(listed.stdout || '').split('\0\0').map((record) => record.split('\0'));
  const record = records.find((fields) => fields.includes(`branch ${ref}`));
  const dir = record?.find((field) => field.startsWith('worktree '))?.slice(9);
  if (!dir) return { ok: false, reason: `no existing checkout of ${branch} — no worktree was created` };
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

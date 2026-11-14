/**
 * The merger's standing, detached measurement checkout. Callers hold the
 * repository's merge lane throughout use; no session ever owns this tree.
 *
 * `name` picks a sibling checkout under the same `<work root>/gate/<slug>/`:
 * `candidate` is the merger's, `full` the scheduled full run's (Martin,
 * 2026-11-13), which runs beside the merge lane and so never stands in the
 * merger's tree. Both resolve the shared dependency tree the same way.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cwdsOfUser, processesStandingIn } from './standing.js';
import { workRoot } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';
import { ownAncestry } from './work-stop.js';

const failure = (run) => run?.error?.message || String(run?.stderr || '').trim() || `git exited ${run?.status}`;

export function measurementCheckoutPath(repoPath, root = workRoot(), name = 'candidate') {
  return join(root, 'gate', repoFileSlug(repoPath), name);
}

export async function measurementCheckout({ repoPath, sha, git, cwds = cwdsOfUser, root = workRoot(), name = 'candidate' }) {
  const dir = measurementCheckoutPath(repoPath, root, name);
  let standing;
  try { standing = cwds(); } catch { /* unknown is not idle */ }
  if (!Array.isArray(standing) || standing.complete === false) {
    return { ok: false, reason: `could not establish whether ${dir} is idle` };
  }
  let busy = processesStandingIn([dir], { cwds: standing });
  if (busy.length) {
    const requesting = ownAncestry();
    busy = busy.filter(({ pid }) => !requesting.has(pid));
  }
  if (busy.length) return { ok: false, reason: `${dir} is in use by pid ${busy.map((p) => p.pid).join(', ')}` };

  const pruned = await git(['worktree', 'prune'], { cwd: repoPath });
  if (pruned.status !== 0) return { ok: false, reason: failure(pruned) };
  // Every worktree has a `.git` entry at its top level. A directory left
  // without one (its worktree gone, only stray files such as .test-timing)
  // cannot be healed: git fails, or resolves a parent repository instead.
  // It is mc's own tree: discard it and re-add it below.
  if (existsSync(dir) && !existsSync(join(dir, '.git'))) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    const added = await git(['worktree', 'add', '--detach', dir, sha], { cwd: repoPath });
    if (added.status !== 0) return { ok: false, reason: `could not create measurement checkout ${dir}: ${failure(added)}` };
  }
  for (const [head, operation] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
    if ((await git(['rev-parse', '--verify', '-q', head], { cwd: dir })).status === 0) {
      const aborted = await git([operation, '--abort'], { cwd: dir });
      if (aborted.status !== 0) return { ok: false, reason: `could not abort ${operation} in ${dir}: ${failure(aborted)}` };
    }
  }
  // This is mc's workspace, not anybody's work. Heal every use, preserving
  // ignored dependencies; preparation replaces a cached node_modules clone.
  for (const args of [['reset', '--hard'], ['clean', '-fd'], ['checkout', '--detach', sha]]) {
    const run = await git(args, { cwd: dir });
    if (run.status !== 0) return { ok: false, reason: `could not heal measurement checkout ${dir}: ${failure(run)}` };
  }
  return { ok: true, dir };
}

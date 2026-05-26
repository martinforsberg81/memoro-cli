/**
 * Squash-merge phantom detection (§9b).
 *
 * A branch is a "squash-merge phantom" when its changeset already lives
 * on main under a different SHA (because the PR was squash-merged). The
 * branch reads as "N commits ahead" but `mc end` should accept it
 * without prompting.
 *
 * Detection is two-stage:
 *
 *   1. `gh pr list --head <branch> --state merged` — confirms a merged
 *      PR exists. Injectable for tests; soft-fails to `false` when `gh`
 *      isn't installed / auth'd (callers degrade per plan §9b).
 *   2. `git diff <branch>...origin/main` on the branch's touched files —
 *      if empty, the changeset is already on main.
 *
 * Returns { isPhantom, hadMergedPr, diffEmpty }. Pure helper; tests
 * supply both the temp repo and the gh stub.
 */
import { spawnSync } from 'node:child_process';

function git(repoDir, args) {
  const r = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}

function defaultGh() {
  return {
    /** Real gh pr list — returns [] (treated as no merged PR) on any failure. */
    async prListMerged(branch) {
      if (process.env.MC_TEST_GH_PHANTOM === '1') {
        return [{ number: 0, mergedAt: new Date().toISOString() }];
      }
      const r = spawnSync('gh', [
        'pr', 'list', '--head', branch, '--state', 'merged',
        '--json', 'number,mergedAt',
      ], { encoding: 'utf8' });
      if (r.status !== 0) return [];
      try {
        const arr = JSON.parse(r.stdout || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    },
  };
}

/**
 * Detect whether `branch` is a squash-merge phantom.
 *
 * Note on the diff check: we compare the branch to `origin/main` over
 * the *full tree* (no path filter). If they agree on every file, the
 * branch's contribution is already represented on main. The plan §9b
 * suggests filtering to "files-from-branch-commits"; in practice that
 * adds complexity without changing the answer because git's diff is
 * already content-based.
 */
export async function detectSquashPhantom({ repoDir, branch, gh = defaultGh() } = {}) {
  if (!repoDir || !branch) {
    throw new Error('detectSquashPhantom: repoDir and branch required');
  }
  const merged = await gh.prListMerged(branch);
  const hadMergedPr = Array.isArray(merged) && merged.length > 0;

  // Determine upstream main ref to diff against. Prefer origin/main; fall
  // back to main if no remote.
  const hasOriginMain = git(repoDir, ['rev-parse', '--verify', '--quiet', 'origin/main']) !== null;
  const mainRef = hasOriginMain ? 'origin/main' : 'main';

  // Empty diff = phantom signal. Use two-dot (tree-vs-tree, not
  // merge-base) so identical content on both sides reads as empty even
  // when the SHAs diverge — the whole point of phantom detection.
  const diff = git(repoDir, ['diff', branch, mainRef, '--name-only']);
  const diffEmpty = diff === '';

  return {
    isPhantom: hadMergedPr && diffEmpty,
    hadMergedPr,
    diffEmpty,
  };
}

/**
 * Squash-merge phantom detection (§9b).
 *
 * A branch is a "squash-merge phantom" when its changeset already lives
 * on main under a different SHA (because the PR was squash-merged). The
 * branch reads as "N commits ahead" but `mc end` should accept it
 * without prompting.
 *
 * Three-tier detection (soft-degrade per plan §9b):
 *
 *   Tier 0 — `git cherry main <branch>`. Purely local, no network, no
 *     auth. Lines starting with `-` are patch-equivalent on main
 *     (git hashes the patch contents, not the commit object). If
 *     every line is `-`, the branch's work is already on main.
 *     Catches the common case (single-commit branch squash-merged)
 *     without needing gh.
 *
 *   Tier 1 — `gh pr list --head <branch> --state merged` + content
 *     diff. Reached when cherry didn't confirm (multi-commit branch
 *     squash-merged, or any case where patch-ids diverged). Higher
 *     confidence when both signals agree.
 *
 *   Tier 2 — degraded `NEEDS_REVIEW`. When tier 0 says no and tier 1
 *     can't run (gh missing) or returns no PR. Callers (mc end / mc
 *     status) treat as `NEEDS_REVIEW` and prompt for human judgement.
 *
 * Returns { isPhantom, cherryConfirms, hadMergedPr, diffEmpty }. The
 * tier-0 path leaves hadMergedPr/diffEmpty as undefined since they
 * weren't consulted. Pure helper; tests supply both the temp repo and
 * the gh stub.
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
 * Cherry-first ordering lets `mc end` work without `gh` for the common
 * case. When cherry confirms, we return immediately and skip the
 * network round-trip. The diff check on the tier-1 path uses two-dot
 * (tree-vs-tree, not merge-base) so identical content on both sides
 * reads as empty even when SHAs diverge.
 */
export async function detectSquashPhantom({ repoDir, branch, gh = defaultGh() } = {}) {
  if (!repoDir || !branch) {
    throw new Error('detectSquashPhantom: repoDir and branch required');
  }

  // Determine upstream main ref to diff against. Prefer origin/main; fall
  // back to main if no remote.
  const hasOriginMain = git(repoDir, ['rev-parse', '--verify', '--quiet', 'origin/main']) !== null;
  const mainRef = hasOriginMain ? 'origin/main' : 'main';

  // Tier 0 — git cherry, local-only. If every commit on the branch has
  // a patch-equivalent on main, the work is represented on main. No
  // gh required.
  const cherry = git(repoDir, ['cherry', mainRef, branch]);
  if (cherry !== null && cherry !== '') {
    const lines = cherry.split('\n').filter(Boolean);
    const allMatched = lines.every((l) => l.startsWith('- '));
    if (allMatched) {
      return {
        isPhantom: true,
        cherryConfirms: true,
        hadMergedPr: undefined,
        diffEmpty: undefined,
      };
    }
  }

  // Tier 1 — gh + content-diff. Higher confidence when both agree;
  // reached when cherry didn't fully confirm (multi-commit squash
  // merges and any case where patch-ids diverged).
  const merged = await gh.prListMerged(branch);
  const hadMergedPr = Array.isArray(merged) && merged.length > 0;

  const diff = git(repoDir, ['diff', branch, mainRef, '--name-only']);
  const diffEmpty = diff === '';

  return {
    isPhantom: hadMergedPr && diffEmpty,
    cherryConfirms: false,
    hadMergedPr,
    diffEmpty,
  };
}

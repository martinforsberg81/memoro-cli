/**
 * TDD spec for squash-phantom detection (§9b).
 *
 * A squash-merge phantom is a branch where the changeset already lives
 * on main under a different SHA. The detection contract:
 *
 *   1. Look up `gh pr list --head <branch> --state merged`. If there's
 *      a recent merged PR, mark as phantom candidate.
 *   2. Compare branch diff vs main on the branch's touched files. If
 *      diff is empty → confirmed phantom.
 *
 * Tests stub `gh` via the `MC_TEST_GH_PHANTOM=1` env: implementation
 * treats this as "the gh probe says merged PR exists". This isolates
 * the git diff side of the check from the network side.
 *
 * Implementation contract: a pure helper at
 * `src/mc/squash-phantom.js` exporting
 *   `async function detectSquashPhantom({ repoDir, branch, gh? }): Promise<{
 *     isPhantom: boolean, hadMergedPr: boolean, diffEmpty: boolean
 *   }>`
 *
 * `gh` is an injectable stub (defaults to actually shelling out — but
 * tests pass a stub). With `MC_TEST_GH_PHANTOM=1`, the default impl
 * may also short-circuit gh to true.
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeTempRepo, git, makeSquashPhantom, makeBranchWithCommit,
} from '../_helpers/git-fixture.js';

let detectSquashPhantom;
try {
  ({ detectSquashPhantom } = await import('../../../src/mc/squash-phantom.js'));
} catch (err) {
  detectSquashPhantom = async () => {
    throw new Error(
      'src/mc/squash-phantom.js not implemented yet — must export ' +
      'async `detectSquashPhantom({ repoDir, branch, gh? })`. Original ' +
      `import error: ${err.message}`,
    );
  };
}

describe('detectSquashPhantom', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'phantom' }); });
  after(() => { repo?.cleanup(); });

  test('confirms phantom when merged PR exists AND diff is empty', async () => {
    makeSquashPhantom(repo.dir, 'sess/p', 'p.txt');
    const result = await detectSquashPhantom({
      repoDir: repo.dir,
      branch: 'sess/p',
      gh: { prListMerged: async () => [{ number: 42, mergedAt: '2026-05-25' }] },
    });
    assert.equal(result.isPhantom, true);
    assert.equal(result.hadMergedPr, true);
    assert.equal(result.diffEmpty, true);
  });

  test('rejects phantom when no merged PR (even if diff is empty)', async () => {
    makeSquashPhantom(repo.dir, 'sess/p2', 'p2.txt');
    const result = await detectSquashPhantom({
      repoDir: repo.dir,
      branch: 'sess/p2',
      gh: { prListMerged: async () => [] },
    });
    assert.equal(result.isPhantom, false);
    assert.equal(result.hadMergedPr, false);
  });

  test('rejects phantom when diff is non-empty (genuine unmerged work)', async () => {
    makeBranchWithCommit(repo.dir, 'sess/real', 'real.txt', 'genuinely new\n');
    const result = await detectSquashPhantom({
      repoDir: repo.dir,
      branch: 'sess/real',
      gh: { prListMerged: async () => [{ number: 7 }] },
    });
    assert.equal(result.isPhantom, false);
    assert.equal(result.diffEmpty, false);
  });
});

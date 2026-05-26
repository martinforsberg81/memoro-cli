/**
 * TDD spec for squash-phantom detection (§9b).
 *
 * Three-tier detection (soft-degrade per plan §9b):
 *
 *   Tier 0: `git cherry main <branch>` — if every commit is patch-
 *           equivalent on main, mark phantom. Local, no auth.
 *   Tier 1: `gh pr list --head <branch> --state merged` + content
 *           diff. Reached when cherry didn't confirm.
 *   Tier 2: Degraded `NEEDS_REVIEW` (handled by callers, not here).
 *
 * Tests stub `gh` via the `MC_TEST_GH_PHANTOM=1` env or by passing
 * a `gh` object directly.
 *
 * Implementation contract: a pure helper at
 * `src/mc/squash-phantom.js` exporting
 *   `async function detectSquashPhantom({ repoDir, branch, gh? }): Promise<{
 *     isPhantom: boolean,
 *     cherryConfirms: boolean,
 *     hadMergedPr: boolean | undefined,
 *     diffEmpty: boolean | undefined
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

  test('confirms phantom on the squash-merge fixture (tier 0 cherry path)', async () => {
    // The squash-merge fixture is a single-commit branch whose patch-id
    // matches a commit on main — exactly the case git cherry confirms.
    // Tier 0 short-circuits; gh and diff aren't consulted (undefined).
    makeSquashPhantom(repo.dir, 'sess/p', 'p.txt');
    const result = await detectSquashPhantom({
      repoDir: repo.dir,
      branch: 'sess/p',
      gh: { prListMerged: async () => [{ number: 42, mergedAt: '2026-05-25' }] },
    });
    assert.equal(result.isPhantom, true);
    assert.equal(result.cherryConfirms, true);
  });

  test('confirms phantom via git cherry alone, even when gh returns no merged PR (soft-degrade)', async () => {
    // A squash-merge fixture produces a branch whose single commit has
    // the same patch-id as a commit on main. git cherry catches this
    // locally — no gh round-trip needed. This is the soft-degrade
    // path: end-of-cycle cleanup works without GitHub auth.
    makeSquashPhantom(repo.dir, 'sess/p2', 'p2.txt');
    const result = await detectSquashPhantom({
      repoDir: repo.dir,
      branch: 'sess/p2',
      gh: { prListMerged: async () => [] },
    });
    assert.equal(result.isPhantom, true);
    assert.equal(result.cherryConfirms, true);
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

  test('rejects phantom when neither cherry nor gh confirm (tier 2 NEEDS_REVIEW)', async () => {
    // Genuinely new branch + no merged PR via gh. Tier 0 (cherry) sees
    // `+` lines so doesn't confirm; tier 1 sees no PR. Caller should
    // surface this as NEEDS_REVIEW.
    makeBranchWithCommit(repo.dir, 'sess/new', 'new.txt', 'new content\n');
    const result = await detectSquashPhantom({
      repoDir: repo.dir,
      branch: 'sess/new',
      gh: { prListMerged: async () => [] },
    });
    assert.equal(result.isPhantom, false);
    assert.equal(result.cherryConfirms, false);
    assert.equal(result.hadMergedPr, false);
  });
});

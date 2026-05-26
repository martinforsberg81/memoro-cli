/**
 * TDD spec for `mc gc` (§2).
 *
 * Per the plan §2:
 *   mc gc [--dry-run]
 *     list/clean worktrees whose session is dead AND branch is merged;
 *     never deletes a dirty worktree
 *
 * Test scenarios:
 *   - dead + merged + clean  → eligible (deleted unless --dry-run)
 *   - dead + merged + dirty  → skipped (never delete dirty)
 *   - live + merged + clean  → skipped (don't gc a live session)
 *   - dead + unmerged + clean → skipped (work would be lost)
 *   - dry-run reports candidates without acting
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

function setupFixture(repo) {
  // 4 worktrees covering each gc decision.
  for (const n of ['gc1', 'gc2', 'gc3', 'gc4']) {
    git(repo.dir, `branch sess/${n} main`);
    const wt = join(repo.mcHome, 'worktrees', 'repo', n);
    addWorktree(repo.dir, wt, `sess/${n}`);
  }
  writeRegistry(repo.mcHome, [
    makeEntry({
      name: 'gc1', branch: 'sess/gc1',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'gc1'),
      session_state: 'dead', ahead: 0, dirty_files: 0,
      safety_verdict: 'SAFE_TO_END',
    }),
    makeEntry({
      name: 'gc2', branch: 'sess/gc2',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'gc2'),
      session_state: 'dead', ahead: 0, dirty_files: 1,
      safety_verdict: 'NEEDS_REVIEW',
    }),
    makeEntry({
      name: 'gc3', branch: 'sess/gc3',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'gc3'),
      session_state: 'live', ahead: 0, dirty_files: 0,
      safety_verdict: 'IS_ACTIVE_NOW',
    }),
    makeEntry({
      name: 'gc4', branch: 'sess/gc4',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'gc4'),
      session_state: 'dead', ahead: 5, dirty_files: 0,
      safety_verdict: 'HAS_UNMERGED_WORK',
    }),
  ]);
}

describe('mc gc', () => {
  let repo;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'gc' });
    setupFixture(repo);
  });
  after(() => { repo?.cleanup(); });

  test('--dry-run lists candidates and changes nothing', () => {
    const r = runMc(['gc', '--dry-run', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}`);
    assert.equal(j.dry_run, true);
    assert.ok(Array.isArray(j.candidates));
    const candNames = j.candidates.map(c => c.name).sort();
    // Only gc1 (dead + merged + clean) is eligible.
    assert.deepEqual(candNames, ['gc1'],
      `only gc1 should be a candidate; got ${candNames.join(',')}`);

    // Side effect: nothing removed.
    const wts = git(repo.dir, 'worktree list --porcelain');
    for (const n of ['gc1', 'gc2', 'gc3', 'gc4']) {
      assert.ok(wts.includes(`/worktrees/repo/${n}`),
        `worktree ${n} should still be present after --dry-run`);
    }
  });

  test('runs without --dry-run remove only eligible worktrees', () => {
    const r = runMc(['gc', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.ok(Array.isArray(j.removed));
    assert.deepEqual(j.removed.map(c => c.name).sort(), ['gc1']);

    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('/worktrees/repo/gc1'),
      `gc1 should be removed; got:\n${wts}`);
    for (const n of ['gc2', 'gc3', 'gc4']) {
      assert.ok(wts.includes(`/worktrees/repo/${n}`),
        `worktree ${n} should be preserved`);
    }
  });
});

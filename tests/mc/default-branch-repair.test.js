import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

import {
  repairDefaultBranchSquatters,
  scanDefaultBranchSquatters,
} from '../../src/mc/default-branch-repair.js';
import { makeTempRepo, git, addWorktree } from './_helpers/git-fixture.js';

describe('default-branch squat repair', () => {
  let repo;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'branch-squat' });
    git(repo.dir, 'config --local mc.defaultBranch main');
  });

  afterEach(() => {
    repo.cleanup();
  });

  function makeSquatter(name) {
    const branch = `sess/${name}`;
    git(repo.dir, `branch ${branch} main`);
    const worktree = join(repo.mcHome, 'worktrees', 'repo', name);
    addWorktree(repo.dir, worktree, branch);
    // The incident sequence: the primary ends up detached, which frees
    // `main` for a process inside the session worktree to check out.
    git(repo.dir, 'switch --detach');
    git(worktree, 'switch main');
    return worktree;
  }

  test('a clean squatter is detected and freed by detaching in place', () => {
    const worktree = makeSquatter('squat-clean');
    const before = git(worktree, 'rev-parse HEAD');

    const squatters = scanDefaultBranchSquatters({ mcDir: repo.mcHome });
    assert.equal(squatters.length, 1);
    assert.equal(squatters[0].branch, 'main');
    assert.equal(squatters[0].clean, true);
    assert.equal(squatters[0].head_reachable, true);

    const repaired = repairDefaultBranchSquatters(squatters);
    assert.equal(repaired.issues.length, 0);
    assert.equal(repaired.fixed.length, 1);
    assert.equal(repaired.fixed[0].code, 'default-branch-freed');

    // Same commit, no branch held — and the primary can take main back.
    assert.equal(git(worktree, 'rev-parse HEAD'), before);
    assert.throws(() => git(worktree, 'symbolic-ref --short HEAD'), /Command failed|symbolic-ref/);
    git(repo.dir, 'switch main');
  });

  test('a dirty squatter is reported, never touched', () => {
    const worktree = makeSquatter('squat-dirty');
    writeFileSync(join(worktree, 'uncommitted.txt'), 'work\n');

    const squatters = scanDefaultBranchSquatters({ mcDir: repo.mcHome });
    assert.equal(squatters.length, 1);
    assert.equal(squatters[0].clean, false);

    const repaired = repairDefaultBranchSquatters(squatters);
    assert.equal(repaired.fixed.length, 0);
    assert.equal(repaired.issues.length, 1);
    assert.equal(repaired.issues[0].code, 'session-worktree-holds-default-branch');
    assert.equal(repaired.issues[0].reason, 'worktree-dirty');
    assert.equal(git(worktree, 'symbolic-ref --short HEAD'), 'main');
  });

  test('session branches are not squatters', () => {
    const branch = 'sess/innocent';
    git(repo.dir, `branch ${branch} main`);
    addWorktree(repo.dir, join(repo.mcHome, 'worktrees', 'repo', 'innocent'), branch);

    assert.deepEqual(scanDefaultBranchSquatters({ mcDir: repo.mcHome }), []);
  });

  test('dry-run reports the fix without releasing the branch', () => {
    const worktree = makeSquatter('squat-dry');

    const squatters = scanDefaultBranchSquatters({ mcDir: repo.mcHome });
    const repaired = repairDefaultBranchSquatters(squatters, { apply: false });

    assert.equal(repaired.fixed.length, 1);
    assert.equal(git(worktree, 'symbolic-ref --short HEAD'), 'main');
  });
});

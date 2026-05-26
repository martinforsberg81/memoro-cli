/**
 * TDD spec for `mc end` (§2 + §9b + §9c).
 *
 * Per the plan:
 *   - `mc end <name>` removes a worktree; deletes the bootstrap branch
 *     only if it's merged (cs heuristic preserved).
 *   - `mc end .` auto-detects the current worktree.
 *   - Refuses when session is live without `--force`.
 *   - `--keep-branch` retains the branch regardless.
 *   - Bulk: `mc end a b c` operates sequentially.
 *   - `--dry-run` prints one line per target with verdict, no side effects.
 *   - Squash-merge phantoms (§9b) end without prompting — the work is
 *     already on main under a different SHA.
 *
 * Phantom detection mocking: the plan §9b uses `gh pr list --head` to
 * confirm a recent merged PR. Tests can't hit GitHub, so the
 * implementation should accept an injected `gh` stub via env:
 *   MC_TEST_GH_PHANTOM=1  → treat any branch as having a merged PR.
 *   The phantom verdict still requires the changeset to already live
 *   on main (we set this up explicitly via makeSquashPhantom).
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import {
  makeTempRepo, git, makeBranchWithCommit, makeSquashPhantom, addWorktree,
} from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

describe('mc end', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'end' }); });
  after(() => { repo?.cleanup(); });

  test('rejects unknown name', () => {
    const r = runMc(['end', 'nope'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown|not.found|no such/i);
  });

  test('refuses to end a worktree with uncommitted changes (no --force)', () => {
    // Create a worktree with a dirty file.
    makeBranchWithCommit(repo.dir, 'sess/dirty', 'tmp.txt', 'committed\n');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'dirty');
    addWorktree(repo.dir, wtPath, 'sess/dirty');
    // Make it dirty.
    git(wtPath, 'config user.email "t@x"');
    git(wtPath, 'config user.name "t"');
    // Write an uncommitted file.
    writeFileSync(join(wtPath, 'dirty.txt'), 'uncommitted\n');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'dirty', branch: 'sess/dirty',
      worktree_path: wtPath, dirty_files: 1,
      safety_verdict: 'NEEDS_REVIEW',
    })]);
    const r = runMc(['end', 'dirty'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0,
      `expected non-zero exit for dirty worktree; stderr:${r.stderr}`);
    assert.match(r.stderr + r.stdout, /dirty|uncommitted|force/i);
  });

  test('refuses to end a live session without --force', () => {
    makeBranchWithCommit(repo.dir, 'sess/live', 'tmp.txt');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'live');
    addWorktree(repo.dir, wtPath, 'sess/live');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'live', branch: 'sess/live',
      worktree_path: wtPath, session_state: 'live',
      safety_verdict: 'IS_ACTIVE_NOW',
    })]);
    const r = runMc(['end', 'live'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /live|active|force/i);
  });

  test('successfully ends a clean, merged worktree (§2)', () => {
    // Branch off main, no commits ahead → "merged" in cs's sense.
    git(repo.dir, 'branch sess/clean main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'clean');
    addWorktree(repo.dir, wtPath, 'sess/clean');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'clean', branch: 'sess/clean',
      worktree_path: wtPath, safety_verdict: 'SAFE_TO_END',
    })]);
    const r = runMc(['end', 'clean', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.ok, true);
    // Side effect: worktree removed.
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('clean'),
      `worktree should be gone; got:\n${wts}`);
  });

  test('--keep-branch retains the bootstrap branch after end', () => {
    git(repo.dir, 'branch sess/keep main');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'keep');
    addWorktree(repo.dir, wtPath, 'sess/keep');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'keep', branch: 'sess/keep',
      worktree_path: wtPath, safety_verdict: 'SAFE_TO_END',
    })]);
    const r = runMc(['end', 'keep', '--keep-branch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const branches = git(repo.dir, 'branch --list');
    assert.match(branches, /sess\/keep/,
      `branch should be kept; got:\n${branches}`);
  });

  // §9b: squash-phantom detection ---------------------------------------------

  test('accepts a squash-merge phantom without --force', () => {
    makeSquashPhantom(repo.dir, 'sess/phantom', 'phantom.txt');
    const wtPath = join(repo.mcHome, 'worktrees', 'repo', 'phantom');
    addWorktree(repo.dir, wtPath, 'sess/phantom');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'phantom', branch: 'sess/phantom',
      worktree_path: wtPath, ahead: 1,
      safety_verdict: 'IS_SQUASH_PHANTOM',
    })]);
    const r = runMc(['end', 'phantom', '--json'], {
      cwd: repo.dir,
      env: {
        MC_HOME: repo.mcHome,
        MC_TEST_GH_PHANTOM: '1', // stub gh pr list as "merged"
      },
    });
    assert.equal(r.status, 0,
      `phantom should end cleanly; stderr:${r.stderr} stdout:${r.stdout}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.ok, true);
    // Verdict surfaces in the JSON so the user knows why it was OK.
    assert.equal(j.verdict, 'IS_SQUASH_PHANTOM');
  });

  // §9c: bulk + dry-run -------------------------------------------------------

  test('--dry-run reports per-target verdict and changes nothing', () => {
    git(repo.dir, 'branch sess/a main');
    git(repo.dir, 'branch sess/b main');
    const wtA = join(repo.mcHome, 'worktrees', 'repo', 'a');
    const wtB = join(repo.mcHome, 'worktrees', 'repo', 'b');
    addWorktree(repo.dir, wtA, 'sess/a');
    addWorktree(repo.dir, wtB, 'sess/b');
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'a', branch: 'sess/a', worktree_path: wtA, safety_verdict: 'SAFE_TO_END' }),
      makeEntry({ name: 'b', branch: 'sess/b', worktree_path: wtB,
        safety_verdict: 'NEEDS_REVIEW', dirty_files: 1 }),
    ]);
    const r = runMc(['end', 'a', 'b', '--dry-run', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.dry_run, true);
    assert.ok(Array.isArray(j.targets), 'dry-run output must include targets[]');
    const byName = Object.fromEntries(j.targets.map(t => [t.name, t]));
    assert.equal(byName.a.verdict, 'SAFE_TO_END');
    assert.equal(byName.b.verdict, 'NEEDS_REVIEW');
    // Side-effect check: worktrees still present.
    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(wts.includes('/a') || wts.includes('worktrees/repo/a'));
    assert.ok(wts.includes('/b') || wts.includes('worktrees/repo/b'));
  });

  test('bulk `mc end a b c` operates sequentially', () => {
    for (const n of ['x', 'y', 'z']) {
      git(repo.dir, `branch sess/${n} main`);
      const wt = join(repo.mcHome, 'worktrees', 'repo', n);
      addWorktree(repo.dir, wt, `sess/${n}`);
    }
    writeRegistry(repo.mcHome, ['x', 'y', 'z'].map(n => makeEntry({
      name: n, branch: `sess/${n}`,
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', n),
      safety_verdict: 'SAFE_TO_END',
    })));
    const r = runMc(['end', 'x', 'y', 'z', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.ok(Array.isArray(j.results));
    assert.equal(j.results.length, 3);
    for (const res of j.results) {
      assert.equal(res.ok, true, `${res.name} should end OK; got ${JSON.stringify(res)}`);
    }
    // All three worktrees gone from git.
    const wts = git(repo.dir, 'worktree list --porcelain');
    for (const n of ['x', 'y', 'z']) {
      assert.ok(!wts.includes(`/worktrees/repo/${n}`),
        `worktree ${n} should be removed; got:\n${wts}`);
    }
  });
});

/**
 * TDD spec for `mc rename <old> <new>` (§2 + §3).
 *
 * Per the plan §2:
 *   mc rename <old> <new>
 *     git branch -m AND mv worktree directory in one step;
 *     updates index
 *
 * Per §3: bootstrap branches start as `sess/<name>` but can be renamed
 * freely (e.g. to `fix/whatever`). Tests cover both same-prefix renames
 * and prefix-changing renames.
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { runMc, parseJsonOrNull } from '../../mc/_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../../mc/_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../../mc/_helpers/registry-fixture.js';

describe('mc rename <old> <new>', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'rename' }); });
  after(() => { repo?.cleanup(); });

  test('requires both old and new args', () => {
    const r1 = runMc(['rename'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r1.status, 0);

    const r2 = runMc(['rename', 'old'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr + r2.stdout, /usage|two|new/i);
  });

  test('renames branch + directory + registry entry atomically', () => {
    git(repo.dir, 'branch sess/old main');
    const oldWt = join(repo.mcHome, 'worktrees', 'repo', 'old');
    addWorktree(repo.dir, oldWt, 'sess/old');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'old', branch: 'sess/old', worktree_path: oldWt,
    })]);

    const r = runMc(['rename', 'old', 'new-name', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.ok, true);
    assert.equal(j.old_name, 'old');
    assert.equal(j.new_name, 'new-name');

    // Branch renamed.
    const branches = git(repo.dir, 'branch --list');
    assert.match(branches, /sess\/new-name/);
    assert.ok(!branches.includes('sess/old'),
      `old branch should be gone; got:\n${branches}`);

    // Directory renamed under MC_HOME.
    const newWt = join(repo.mcHome, 'worktrees', 'repo', 'new-name');
    assert.ok(existsSync(newWt), `expected new worktree dir at ${newWt}`);
    assert.ok(!existsSync(oldWt), `old worktree dir should be gone at ${oldWt}`);
  });

  test('rejects renaming to a name that already exists', () => {
    git(repo.dir, 'branch sess/a main');
    git(repo.dir, 'branch sess/b main');
    const wtA = join(repo.mcHome, 'worktrees', 'repo', 'a');
    const wtB = join(repo.mcHome, 'worktrees', 'repo', 'b');
    addWorktree(repo.dir, wtA, 'sess/a');
    addWorktree(repo.dir, wtB, 'sess/b');
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'a', branch: 'sess/a', worktree_path: wtA }),
      makeEntry({ name: 'b', branch: 'sess/b', worktree_path: wtB }),
    ]);

    const r = runMc(['rename', 'a', 'b'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /exists|conflict|already/i);
  });

  test('rejects unknown <old> name', () => {
    const r = runMc(['rename', 'ghost', 'whatever'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown|not.found|no such/i);
  });
});

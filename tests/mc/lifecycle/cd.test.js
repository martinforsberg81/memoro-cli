/**
 * TDD spec for `mc cd <name>` (§2 + §2b).
 *
 * §2b describes the shell-wrapper mechanic: the CLI emits shell
 * directives on fd 3, which the user's wrapper function eval's. For
 * `mc cd <name>` this is the only thing that happens — emit
 * `cd <worktree_path>` on fd 3 and exit 0.
 *
 * Tests capture fd 3 via `runMcCaptureFd3` and assert on its contents.
 *
 * Judgment call: per the plan, the wrapper passes
 * `--emit-shell-directives` as the gate. If that flag is missing, the
 * CLI just prints a tip and exits 0 (no directive). We exercise both
 * paths.
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { runMc, runMcCaptureFd3 } from '../_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

describe('mc cd <name>', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'cd' }); });
  after(() => { repo?.cleanup(); });

  test('rejects missing name', () => {
    const r = runMc(['cd'], { cwd: repo.dir, env: { MC_HOME: repo.mcHome } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /usage|name|required/i);
  });

  test('rejects unknown name', () => {
    const r = runMc(['cd', 'ghost', '--emit-shell-directives'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown|not.found|no such/i);
  });

  test('with --emit-shell-directives writes "cd <path>" to fd 3', async () => {
    git(repo.dir, 'branch sess/here main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'here');
    addWorktree(repo.dir, wt, 'sess/here');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'here', branch: 'sess/here', worktree_path: wt,
    })]);

    const r = await runMcCaptureFd3(
      ['cd', 'here', '--emit-shell-directives'],
      { cwd: repo.dir, env: { MC_HOME: repo.mcHome } },
    );
    assert.equal(r.status, 0, `stderr:${r.stderr} stdout:${r.stdout}`);
    assert.match(r.fd3, new RegExp(`^cd ${wt}\\s*$`, 'm'),
      `fd 3 should carry "cd ${wt}"; got: ${JSON.stringify(r.fd3)}`);
    // No directive leakage onto stdout — that would feed user-visible
    // text into eval and break the contract.
    assert.ok(!r.stdout.includes(`cd ${wt}`),
      `stdout must not contain the cd line; got: ${r.stdout}`);
  });

  test('without --emit-shell-directives, prints a tip (no fd 3 directive)', async () => {
    git(repo.dir, 'branch sess/notip main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'notip');
    addWorktree(repo.dir, wt, 'sess/notip');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'notip', branch: 'sess/notip', worktree_path: wt,
    })]);

    const r = await runMcCaptureFd3(['cd', 'notip'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    // CLI should still exit 0 — `mc cd` without the wrapper is a no-op
    // (with a help hint), not an error.
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.match(r.stdout + r.stderr, /install.shell|wrapper|tip/i,
      `expected a wrapper-install tip; got stdout:${r.stdout} stderr:${r.stderr}`);
    // fd 3 must be empty — no point eval'ing if there's no wrapper.
    assert.equal(r.fd3, '',
      `fd 3 must be empty without --emit-shell-directives; got: ${JSON.stringify(r.fd3)}`);
  });
});

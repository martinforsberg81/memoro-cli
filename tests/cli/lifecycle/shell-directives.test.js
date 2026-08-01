/**
 * TDD spec for shell-directive emission across the lifecycle commands (§2b).
 *
 * The plan §2b lists four commands that should emit `cd` directives on
 * fd 3 when `--emit-shell-directives` is passed:
 *
 *   mc cd <name>      → cd <worktree>          (already covered in cd.test.js)
 *   mc new <name>     → cd <worktree>          (on completion / on exit)
 *   mc resume <name>  → cd <worktree>          (before launching tool)
 *   mc end <name>     → cd <primary-worktree>  (before removing worktree)
 *
 * This file covers new/resume/end. The contract is:
 *   - With --emit-shell-directives, exactly one `cd <abs-path>` line on fd 3.
 *   - That path must exist as a directory at the moment the directive is
 *     emitted (so the shell wrapper doesn't land in a deleted dir).
 *   - The path must NOT appear on stdout (would be re-eval'd / cause noise).
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMcCaptureFd3 } from '../../mc/_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../../mc/_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../../mc/_helpers/registry-fixture.js';

function extractCdTarget(fd3) {
  const m = fd3.match(/^cd\s+(.+?)\s*$/m);
  return m ? m[1] : null;
}

describe('shell-directive emission (§2b)', () => {
  let repo;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'directives' });
    // These tests exercise shell-directive routing, not first-run onboarding.
    writeFileSync(join(repo.mcHome, '.setup-done-v1'), 'test\n');
  });
  after(() => { repo?.cleanup(); });

  test('mc new emits a cd directive to the new worktree', async () => {
    const r = await runMcCaptureFd3(
      ['new', 'feat-cd', '--no-launch', '--emit-shell-directives'],
      { cwd: repo.dir, env: { MC_HOME: repo.mcHome } },
    );
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const target = extractCdTarget(r.fd3);
    assert.ok(target, `expected a cd directive on fd 3; got: ${JSON.stringify(r.fd3)}`);
    assert.ok(target.startsWith(repo.mcHome),
      `cd target should be under MC_HOME; got ${target}`);
    assert.ok(existsSync(target),
      `cd target dir must exist at emission; got ${target}`);
  });

  test('mc resume emits a cd directive before launch', async () => {
    git(repo.dir, 'branch sess/r main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'r');
    addWorktree(repo.dir, wt, 'sess/r');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'r', branch: 'sess/r', worktree_path: wt, tool: 'claude',
    })]);

    const r = await runMcCaptureFd3(
      ['resume', 'r', '--no-launch', '--emit-shell-directives'],
      { cwd: repo.dir, env: { MC_HOME: repo.mcHome } },
    );
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const target = extractCdTarget(r.fd3);
    assert.equal(target, wt, `cd should target the worktree; got ${target}`);
  });

  test('mc end emits a cd directive back to the primary worktree', async () => {
    git(repo.dir, 'branch sess/done main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'done');
    addWorktree(repo.dir, wt, 'sess/done');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'done', branch: 'sess/done', worktree_path: wt,
      session_state: 'no-session-yet',
      safety_verdict: 'SAFE_TO_END',
    })]);

    // Run `mc end` from *inside* the about-to-be-deleted worktree —
    // the directive is what saves the shell from sitting in a dead dir.
    const r = await runMcCaptureFd3(
      ['end', 'done', '--force', '--emit-shell-directives'],
      { cwd: wt, env: { MC_HOME: repo.mcHome } },
    );
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const target = extractCdTarget(r.fd3);
    assert.ok(target, `expected cd directive on fd 3; got: ${JSON.stringify(r.fd3)}`);
    // Target must be the primary worktree (repo.dir), not the deleted one.
    assert.equal(target, repo.dir,
      `cd should land at primary worktree ${repo.dir}; got ${target}`);
    assert.ok(existsSync(target), `primary worktree must still exist`);
  });

  test('directives never leak onto stdout', async () => {
    const r = await runMcCaptureFd3(
      ['new', 'no-leak', '--no-launch', '--emit-shell-directives'],
      { cwd: repo.dir, env: { MC_HOME: repo.mcHome } },
    );
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.ok(!/^cd\s/m.test(r.stdout),
      `stdout must not contain a 'cd ...' line; got:\n${r.stdout}`);
  });
});

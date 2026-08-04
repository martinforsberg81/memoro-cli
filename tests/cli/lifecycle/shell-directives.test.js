/**
 * TDD spec for shell-directive emission across the lifecycle commands (§2b).
 *
 * The V1 contract lists three commands that may emit `cd` directives on
 * fd 3 when `--emit-shell-directives` is passed:
 *
 *   mc cd <name>      → cd <workspace>         (already covered in cd.test.js)
 *   mc new <name>     → cd <current workspace> (before optional launch)
 *   mc resume <name>  → cd <workspace>         (before launching tool)
 *
 * `mc end` no longer changes or removes a workspace, so it emits no `cd`.
 *
 * This file covers new/resume/end. For navigation commands the contract is:
 *   - With --emit-shell-directives, exactly one `cd <abs-path>` line on fd 3.
 *   - That path must exist as a directory at the moment the directive is
 *     emitted (so the shell wrapper doesn't land in a deleted dir).
 *   - The path must NOT appear on stdout (would be re-eval'd / cause noise).
 */
import test, { describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMcCaptureFd3 } from '../../mc/_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../../mc/_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../../mc/_helpers/registry-fixture.js';
import { makeV1Fixture } from './v1-fixture.js';

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
  afterEach(() => { repo?.cleanup(); });

  test('mc new keeps the current directory as its workspace', async () => {
    const r = await runMcCaptureFd3(
      ['new', 'feat-cd', '--no-launch', '--emit-shell-directives'],
      { cwd: repo.dir, env: { MC_HOME: repo.mcHome } },
    );
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const target = extractCdTarget(r.fd3);
    assert.ok(target, `expected a cd directive on fd 3; got: ${JSON.stringify(r.fd3)}`);
    assert.equal(target, realpathSync(repo.dir));
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

  test('mc end keeps the workspace and emits no cd directive', async () => {
    const fixture = makeV1Fixture('mc-v1-end-directive-');
    try {
      fixture.create('done');
      const result = await runMcCaptureFd3(
        ['end', 'done', '--emit-shell-directives'],
        { cwd: fixture.workspace, env: { MC_HOME: fixture.mcHomeDir } },
      );
      assert.equal(result.status, 0, `stderr:${result.stderr}`);
      assert.equal(extractCdTarget(result.fd3), null);
      assert.equal(existsSync(fixture.workspace), true);
    } finally {
      fixture.cleanup();
    }
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

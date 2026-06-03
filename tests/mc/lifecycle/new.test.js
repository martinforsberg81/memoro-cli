/**
 * TDD spec for `mc new <name>` (§2).
 *
 * Per the plan §2:
 *   mc new <name> [--from <ref>] [--tool claude|codex|gemini]
 *     create worktree, create bootstrap branch sess/<name>, launch tool
 *
 * Open ambiguity from the design plan + existing code:
 *   The CURRENT `mc new <label>` wraps `claude` (no worktree). The new
 *   §2 contract redefines `mc new` to be a lifecycle command that
 *   creates a worktree + branch and *then* launches the tool. The
 *   wrapping behaviour is subsumed.
 *
 *   Judgment call for this spec: when run inside a git repo with a
 *   `<name>` arg, the new behaviour applies — create a worktree at
 *   `${MC_HOME}/worktrees/<repo-slug>/<name>` with branch `sess/<name>`,
 *   then emit a shell-cd directive on fd 3 (if attached) per §2b.
 *
 *   We pass `--no-launch` (a test-only escape hatch) so the test
 *   doesn't actually try to spawn `claude`. If the implementation
 *   prefers a different opt-out flag, rename here.
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo, git } from '../_helpers/git-fixture.js';

describe('mc new', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'new' }); });
  after(() => { repo?.cleanup(); });

  test('rejects missing name with non-zero exit + usage hint', () => {
    const r = runMc(['new'], { cwd: repo.dir, env: { MC_HOME: repo.mcHome } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /usage|name|required/i,
      `expected a usage hint, got stderr:${r.stderr} stdout:${r.stdout}`);
  });

  test('rejects names with shell-unsafe characters', () => {
    const r = runMc(['new', 'has space', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /invalid|name|character/i);
  });

  test('refuses to run outside a git repo', () => {
    // repo.root is a tmpdir parent, not a git repo.
    const r = runMc(['new', 'foo', '--no-launch'], {
      cwd: repo.root, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /git|repo/i);
  });

  test('--json output describes the created worktree + branch', () => {
    const r = runMc(['new', 'feat-x', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON on stdout, got: ${r.stdout}`);
    assert.equal(j.ok, true);
    assert.equal(j.name, 'feat-x');
    assert.equal(j.branch, 'sess/feat-x');
    assert.ok(typeof j.worktree_path === 'string' && j.worktree_path.length > 0,
      'worktree_path must be a non-empty string');
    // Worktree path must live under MC_HOME, not inside the repo (§1).
    assert.ok(j.worktree_path.startsWith(repo.mcHome),
      `worktree should be under MC_HOME (${repo.mcHome}); got ${j.worktree_path}`);
  });

  test('side effect: git worktree list shows the new worktree', () => {
    runMc(['new', 'feat-y', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    const list = git(repo.dir, 'worktree list --porcelain');
    assert.match(list, /feat-y|sess\/feat-y/,
      `git worktree list should mention the new worktree; got:\n${list}`);
  });

  test('side effect: branch sess/<name> exists after creation', () => {
    runMc(['new', 'feat-z', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    const branches = git(repo.dir, 'branch --list');
    assert.match(branches, /sess\/feat-z/,
      `expected sess/feat-z branch; got:\n${branches}`);
  });

  test('refuses duplicate names', () => {
    runMc(['new', 'dup', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    const r = runMc(['new', 'dup', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /exists|duplicate|already/i);
  });

  test('--from <ref> roots the new branch at that ref', () => {
    // Make a side commit on main, then branch off the parent.
    const parentSha = git(repo.dir, 'rev-parse HEAD');
    git(repo.dir, 'commit --allow-empty -q -m "later"');
    const r = runMc(['new', 'from-test', '--from', parentSha, '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const branchSha = git(repo.dir, 'rev-parse sess/from-test');
    assert.equal(branchSha, parentSha,
      `sess/from-test should point at ${parentSha} but is ${branchSha}`);
  });

  test('--tool flag is recorded in registry / output', () => {
    const r = runMc(['new', 'codex-x', '--tool', 'codex', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.tool, 'codex');
  });

  // Phase 2 — entry parity: the optional `<task>` positional is the soft
  // grounding focus. It's standing context, not a name and not an opening
  // prompt; multi-word tasks join without quotes.
  test('optional <task> positional is surfaced as focus (no quotes needed)', () => {
    const r = runMc(['new', 'focus-x', 'grab', 'the', 'flaky', 'test', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}`);
    assert.equal(j.name, 'focus-x', 'first positional is still the name');
    assert.equal(j.focus, 'grab the flaky test', 'remaining positionals form the focus');
  });

  test('focus is null when no <task> is given', () => {
    const r = runMc(['new', 'no-focus', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.focus, null);
  });
});

/**
 * "Unmerged" counts content, not commits (2026-08-24).
 *
 * Every merge here is a squash: the branch's commits never appear on main,
 * so the SHA count called every landed branch unmerged forever — twelve of
 * fourteen MSR areas read as disorder, and release refused to clean them.
 * Real git throughout: the squash artefact is the subject, not a stub.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { branchLanded } from '../../src/mc/branch-landed.js';
import { inspectWorkArea, releaseWorkArea, removeWorktree } from '../../src/mc/work-area.js';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

/**
 * A repository whose branch was squash-merged: `feat` carries two commits
 * main lacks by SHA, and main carries their content in one. `origin/main`
 * is a plain ref — no network anywhere near this.
 */
function squashed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-landed-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-q', '-m', 'root']);
  git(repo, ['switch', '-qc', 'feat']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'one']);
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, ['add', 'b.txt']);
  git(repo, ['commit', '-q', '-m', 'two']);
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['merge', '--squash', '-q', 'feat']);
  git(repo, ['commit', '-q', '-m', 'feat, squashed']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('what landed means after a squash', () => {
  it('a squash-merged branch is landed: commits main lacks, and nothing main lacks', () => {
    const fx = squashed();
    try {
      assert.equal(git(fx.repo, ['rev-list', '--count', 'origin/main..feat']), '2', 'the SHA count still says two');
      assert.equal(branchLanded(fx.repo, 'feat'), 'landed');
    } finally { fx.cleanup(); }
  });

  it('real work is ahead, a conflict is unknown, and no base is unknown too', () => {
    const fx = squashed();
    try {
      git(fx.repo, ['switch', '-q', 'feat']);
      writeFileSync(join(fx.repo, 'c.txt'), 'c\n');
      git(fx.repo, ['add', 'c.txt']);
      git(fx.repo, ['commit', '-q', '-m', 'three']);
      git(fx.repo, ['switch', '-q', 'main']);
      assert.equal(branchLanded(fx.repo, 'feat'), 'ahead');

      // A branch that rewrote what main also rewrote: not answerable.
      git(fx.repo, ['switch', '-qc', 'conf']);
      writeFileSync(join(fx.repo, 'base.txt'), 'theirs\n');
      git(fx.repo, ['commit', '-aqm', 'their base']);
      git(fx.repo, ['switch', '-q', 'main']);
      writeFileSync(join(fx.repo, 'base.txt'), 'ours\n');
      git(fx.repo, ['commit', '-aqm', 'our base']);
      git(fx.repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
      assert.equal(branchLanded(fx.repo, 'conf'), 'unknown');

      assert.equal(branchLanded(fx.repo, 'feat', { base: 'origin/nowhere' }), 'unknown');
    } finally { fx.cleanup(); }
  });
});

/** A work area holding one worktree of the squashed repository's feat branch. */
function area(fx, { branch = 'feat' } = {}) {
  const workRoot = join(fx.root, 'work');
  mkdirSync(join(workRoot, 'x'), { recursive: true });
  git(fx.repo, ['worktree', 'add', '-q', join(workRoot, 'x', 'repo'), branch]);
  return { workRoot, env: { ...process.env, MC_WORK_ROOT: workRoot } };
}

describe('release and remove act on content', () => {
  it('release cleans a landed branch, and says what it kept and why for the other two', () => {
    const fx = squashed();
    try {
      const { workRoot, env } = area(fx);
      const seen = inspectWorkArea('x', env).worktrees[0];
      assert.equal(seen.unmerged_commits, 2);
      assert.equal(seen.landed, 'landed');
      const result = releaseWorkArea('x', { env, dryRun: false });
      assert.equal(result.kept.length, 0, JSON.stringify(result.kept.map((k) => k.why)));
      assert.equal(result.removed[0].what, 'worktree and branch');
      assert.equal(existsSync(join(workRoot, 'x', 'repo')), false);
      assert.throws(() => git(fx.repo, ['rev-parse', '--verify', 'feat']), 'the squash artefact branch survived');
    } finally { fx.cleanup(); }
  });

  it('release keeps real work, named as commits main lacks', () => {
    const fx = squashed();
    try {
      const { env } = area(fx);
      const wt = join(fx.root, 'work', 'x', 'repo');
      writeFileSync(join(wt, 'c.txt'), 'c\n');
      git(wt, ['add', 'c.txt']);
      git(wt, ['commit', '-q', '-m', 'three']);
      const result = releaseWorkArea('x', { env, dryRun: false });
      assert.equal(result.kept.length, 1);
      assert.match(result.kept[0].why, /3 commits main lacks/u);
    } finally { fx.cleanup(); }
  });

  it('release keeps a conflict as a doubt, not as work', () => {
    const fx = squashed();
    try {
      const { env } = area(fx);
      const wt = join(fx.root, 'work', 'x', 'repo');
      writeFileSync(join(wt, 'base.txt'), 'theirs\n');
      git(wt, ['commit', '-aqm', 'their base']);
      git(fx.repo, ['switch', '-q', 'main']);
      writeFileSync(join(fx.repo, 'base.txt'), 'ours\n');
      git(fx.repo, ['commit', '-aqm', 'our base']);
      git(fx.repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
      const result = releaseWorkArea('x', { env, dryRun: false });
      assert.equal(result.kept.length, 1);
      assert.match(result.kept[0].why, /cannot tell whether main has this content/u);
    } finally { fx.cleanup(); }
  });

  it('remove deletes a landed branch and says why when it keeps one', () => {
    const fx = squashed();
    try {
      const { env } = area(fx);
      const result = removeWorktree({ name: 'x', repo: 'repo', env });
      assert.equal(result.ok, true);
      assert.equal(result.branch_kept, false, result.branch_kept_why);
      assert.throws(() => git(fx.repo, ['rev-parse', '--verify', 'feat']));
    } finally { fx.cleanup(); }
  });

  it('remove keeps a branch that is ahead, and its why names the commits', () => {
    const fx = squashed();
    try {
      const { env } = area(fx);
      const wt = join(fx.root, 'work', 'x', 'repo');
      writeFileSync(join(wt, 'c.txt'), 'c\n');
      git(wt, ['add', 'c.txt']);
      git(wt, ['commit', '-q', '-m', 'three']);
      const result = removeWorktree({ name: 'x', repo: 'repo', env });
      assert.equal(result.branch_kept, true);
      assert.match(result.branch_kept_why, /3 commits main lacks/u);
      assert.equal(git(fx.repo, ['rev-parse', '--verify', '--quiet', 'feat']).length > 0, true, 'the work survived');
    } finally { fx.cleanup(); }
  });
});

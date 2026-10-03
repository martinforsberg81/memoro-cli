import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitsAhead, git as mcGit, GIT_TIMEOUT_MS, resolveDefaultBranch, tryGit } from '../../src/mc/git.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'mc-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'mc-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

test('resolves main from a configured remote HEAD and prefers the local branch ref', (t) => {
  const repo = makeClonedRepo({ defaultBranch: 'main' });
  t.after(repo.cleanup);

  assert.deepEqual(resolveDefaultBranch(repo.dir), {
    ok: true,
    branch: 'main',
    ref: 'refs/heads/main',
    remote: 'origin',
    remote_ref: 'refs/remotes/origin/main',
    source: 'remote-head',
  });
});

test('treats master as an ordinary configured remote HEAD', (t) => {
  const repo = makeClonedRepo({ defaultBranch: 'master' });
  t.after(repo.cleanup);

  const result = resolveDefaultBranch(repo.dir);
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'master');
  assert.equal(result.ref, 'refs/heads/master');
  assert.equal(result.remote, 'origin');
  assert.equal(result.source, 'remote-head');
});

test('supports a custom default branch and a remote not named origin', (t) => {
  const repo = makeClonedRepo({ defaultBranch: 'trunk', remote: 'upstream' });
  t.after(repo.cleanup);

  const result = resolveDefaultBranch(repo.dir);
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'trunk');
  assert.equal(result.ref, 'refs/heads/trunk');
  assert.equal(result.remote, 'upstream');
  assert.equal(result.source, 'remote-head');
});

test('uses one unambiguous remote branch when remote HEAD metadata is missing', (t) => {
  const repo = makeClonedRepo({ defaultBranch: 'develop' });
  t.after(repo.cleanup);
  git(repo.dir, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], { allowFailure: true });

  const result = resolveDefaultBranch(repo.dir);
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'develop');
  assert.equal(result.source, 'single-remote-branch');
});

test('supports an unambiguous local-only repository', (t) => {
  const repo = makeClonedRepo({ defaultBranch: 'stable' });
  t.after(repo.cleanup);
  git(repo.dir, ['remote', 'remove', 'origin']);

  const result = resolveDefaultBranch(repo.dir);
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'stable');
  assert.equal(result.ref, 'refs/heads/stable');
  assert.equal(result.remote, null);
  assert.equal(result.source, 'single-local-branch');
});

test('returns unknown instead of guessing among local-only branches', (t) => {
  const repo = makeClonedRepo({ defaultBranch: 'stable' });
  t.after(repo.cleanup);
  git(repo.dir, ['remote', 'remove', 'origin']);
  git(repo.dir, ['branch', 'feature']);

  const result = resolveDefaultBranch(repo.dir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'default-branch-unknown');
  assert.deepEqual(result.candidates.map((item) => item.branch).sort(), ['feature', 'stable']);
  assert.equal(commitsAhead(repo.dir, 'feature'), null);
});

test('returns ambiguous for conflicting remote HEADs and accepts explicit repository metadata', (t) => {
  const repo = makeClonedRepo({ defaultBranch: 'main' });
  const backup = makeBareRemote({ root: repo.root, name: 'backup.git', defaultBranch: 'trunk' });
  t.after(repo.cleanup);
  git(repo.dir, ['remote', 'add', 'backup', backup]);
  git(repo.dir, ['fetch', 'backup']);
  git(repo.dir, ['symbolic-ref', 'refs/remotes/backup/HEAD', 'refs/remotes/backup/trunk']);

  const ambiguous = resolveDefaultBranch(repo.dir);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'default-branch-ambiguous');
  assert.deepEqual(ambiguous.candidates.map((item) => item.branch).sort(), ['main', 'trunk']);

  git(repo.dir, ['config', '--local', 'mc.defaultBranch', 'trunk']);
  git(repo.dir, ['config', '--local', 'mc.defaultRemote', 'backup']);
  const configured = resolveDefaultBranch(repo.dir);
  assert.equal(configured.ok, true);
  assert.equal(configured.branch, 'trunk');
  assert.equal(configured.remote, 'backup');
  assert.equal(configured.source, 'configured');
});

test('counts against a custom resolved default branch and preserves unknown', (t) => {
  const repo = makeClonedRepo({ defaultBranch: 'trunk', remote: 'upstream' });
  t.after(repo.cleanup);
  git(repo.dir, ['checkout', '-q', '-b', 'sess/work']);
  writeFileSync(join(repo.dir, 'work.txt'), 'work\n');
  git(repo.dir, ['add', 'work.txt']);
  git(repo.dir, ['commit', '-q', '-m', 'Work']);
  git(repo.dir, ['checkout', '-q', 'trunk']);

  assert.equal(commitsAhead(repo.dir, 'sess/work'), 1);
  assert.equal(commitsAhead(repo.dir, 'does-not-exist'), null);
});

function makeClonedRepo({ defaultBranch, remote = 'origin' }) {
  const root = mkdtempSync(join(tmpdir(), 'mc-default-branch-'));
  const bare = makeBareRemote({ root, name: 'remote.git', defaultBranch });
  const dir = join(root, 'clone');
  git(root, ['clone', '-q', bare, dir]);
  if (remote !== 'origin') git(dir, ['remote', 'rename', 'origin', remote]);
  return {
    root,
    dir,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function makeBareRemote({ root, name, defaultBranch }) {
  const source = join(root, `${name}-source`);
  const bare = join(root, name);
  mkdirSync(source, { recursive: true });
  git(source, ['init', '-q', '-b', defaultBranch]);
  writeFileSync(join(source, 'README.md'), '# fixture\n');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-q', '-m', 'Initial']);
  git(root, ['clone', '--bare', '-q', source, bare]);
  return bare;
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

// A git that does not finish — a credential helper waiting on a locked
// keychain's modal — is stopped, and the error names what timed out. The fake
// sleeps 3 s and then succeeds, so without the limit the call returns cleanly
// and the assertion fails rather than hanging the suite.
function slowGit(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-git-slow-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nsleep 3\necho late\n');
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('git() stops a call that does not finish and says what timed out', (t) => {
  const dir = slowGit(t);
  const started = Date.now();
  assert.throws(
    () => mcGit(dir, ['fetch', '-q', 'origin'], { timeoutMs: 300 }),
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.match(err.message, /^git fetch -q origin did not finish in 300 ms and was stopped/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2500, 'stopped before the fake git finished');
});

test('tryGit() answers null for a call that timed out', (t) => {
  const dir = slowGit(t);
  assert.equal(tryGit(dir, ['ls-remote', 'origin', 'HEAD'], { timeoutMs: 300 }), null);
});

test('git() gives a call five minutes by default', () => {
  assert.equal(GIT_TIMEOUT_MS, 300_000);
});

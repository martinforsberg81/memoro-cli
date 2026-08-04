/**
 * Spin up a throwaway git repo + worktrees for lifecycle command tests.
 *
 * Each test gets its own tmpdir; teardown removes it. Repos are
 * configured with a quiet local identity so `git commit` doesn't error
 * on missing user.email.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const QUIET_ENV = {
  GIT_AUTHOR_NAME: 'mc-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'mc-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

/** Run a git command in `cwd`. Throws on non-zero exit. */
export function git(cwd, args, env = {}) {
  return execSync(`git ${args}`, {
    cwd,
    env: { ...process.env, ...QUIET_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

/**
 * Create a fresh git repo in a tmp dir with one initial commit on
 * `main`. Returns { dir, cleanup }.
 *
 * The `mcHome` is co-located so the CLI sees an isolated registry.
 * Tests should pass `MC_HOME: mcHome` in env when running the CLI.
 */
export function makeTempRepo({ name = 'tmprepo' } = {}) {
  const root = mkdtempSync(join(tmpdir(), `mc-test-${name}-`));
  const repoDir = join(root, 'repo');
  const mcHome = join(root, '.mc');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });

  git(repoDir, 'init -q -b main');
  // Pin local identity so future commits never prompt.
  git(repoDir, 'config user.email "test@example.invalid"');
  git(repoDir, 'config user.name "mc-test"');
  // Initial commit so HEAD exists.
  writeFileSync(join(repoDir, 'README.md'), '# test repo\n');
  git(repoDir, 'add README.md');
  git(repoDir, 'commit -q -m "Initial commit"');

  // Fake an `origin/main` ref so commands that compare to upstream work.
  // We do this by cloning to a bare and re-adding as origin.
  const bareDir = join(root, 'origin.git');
  execSync(`git clone --bare -q "${repoDir}" "${bareDir}"`, { stdio: 'ignore' });
  git(repoDir, `remote add origin "${bareDir}"`);
  git(repoDir, 'fetch -q origin');
  git(repoDir, 'branch --set-upstream-to=origin/main main');

  return {
    dir: repoDir,
    mcHome,
    root,
    cleanup() {
      try { rmSync(root, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Create a feature branch + a commit on it. Returns the branch name.
 *
 * Useful for §9b squash-phantom and §9a unmerged-work scenarios.
 */
export function makeBranchWithCommit(repoDir, branchName, fileName, fileBody = 'change\n') {
  git(repoDir, `checkout -q -b ${branchName}`);
  writeFileSync(join(repoDir, fileName), fileBody);
  git(repoDir, `add ${fileName}`);
  git(repoDir, `commit -q -m "Work on ${branchName}"`);
  git(repoDir, 'checkout -q main');
  return branchName;
}

/**
 * Set up a *squash-merged* scenario: branch has N commits ahead, but the
 * change set has already been squash-applied to main under a different
 * SHA.
 *
 * Returns the branch name. Same file content lives on main; `git diff
 * <branch> main` is empty.
 */
export function makeSquashPhantom(repoDir, branchName, fileName) {
  // Branch with content.
  git(repoDir, `checkout -q -b ${branchName}`);
  writeFileSync(join(repoDir, fileName), 'phantom content\n');
  git(repoDir, `add ${fileName}`);
  git(repoDir, `commit -q -m "Phantom work"`);
  git(repoDir, 'checkout -q main');

  // Squash-apply the same content to main as a separate commit.
  writeFileSync(join(repoDir, fileName), 'phantom content\n');
  git(repoDir, `add ${fileName}`);
  git(repoDir, 'commit -q -m "Squash-merge of phantom"');
  // Push to "origin" so origin/main has the squashed commit.
  git(repoDir, 'push -q origin main');

  return branchName;
}

/**
 * Add a worktree at `path` checked out to `branch`. The branch must
 * already exist. Returns nothing.
 */
export function addWorktree(repoDir, path, branch) {
  mkdirSync(join(path, '..'), { recursive: true });
  git(repoDir, `worktree add -q "${path}" "${branch}"`);
}

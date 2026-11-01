/**
 * The test files that still start git, one by one. A file here is measuring
 * something the model does not answer (`tests/mc/_helpers/fake-git.js`). The
 * list only shrinks: a file off it that reaches git is red
 * (`tests/_isolate-home.mjs`), and a new file does not go on it.
 */
export const REAL_GIT_FILES = new Set([
  // Git's own behaviour: errors, rebase, the shapes of its answers.
  'tests/mc/git.test.js',
  'tests/mc/branch-landed.test.js',
  'tests/mc/merger.test.js',
  'tests/mc/repo-merge-live.test.js',
  'tests/mc/push-guard.test.js',
  // `git archive`, `worktree move`, and worktree removal on disk.
  'tests/mc/ios-build-testflight.test.js',
  'tests/mc/layout-migrate.test.js',
  'tests/mc/archive-programme.test.js',
  'tests/mc/work-layout.test.js',
  'tests/mc/work-area-add.test.js',
  'tests/mc/close-live.test.js',
  'tests/mc/repo-status.test.js',
  'tests/mc/repo-watch.test.js',
  'tests/mc/commands/deploy.test.js',
  // Installs a model of its own, and starts no git.
  'tests/mc/fake-git.test.js',
]);

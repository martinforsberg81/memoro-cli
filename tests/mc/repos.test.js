/**
 * The two repository layouts, as `defaultRepos` answers them (repos.js): the
 * primary checkouts, and bare repositories with a `self/<name>` worktree on
 * main. Every caller takes `path`, `checkout` or `git` from this answer, so
 * the answer for each layout is the contract.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultRepos as fromBriefCollect } from '../../src/mc/brief-collect.js';
import { reposHome, selfHome } from '../../src/mc/paths.js';
import { defaultRepos, gitDirOf, repoNameOf, repositoryDir } from '../../src/mc/repos.js';
import { makeRepoLayout } from './_helpers/bare-layout.js';

const byName = (repos) => Object.fromEntries(repos.map((repo) => [repo.name, repo]));

describe('defaultRepos — the first layout', () => {
  it('answers each clone as path and checkout, its .git as git', () => {
    const fx = makeRepoLayout({ clones: ['memoro', 'memoro-cli'] });
    try {
      const repos = defaultRepos(fx.env);
      assert.deepEqual(repos.map((repo) => repo.name), ['memoro', 'memoro-cli']);
      for (const repo of repos) {
        const clone = join(fx.home, repo.name);
        assert.deepEqual(repo, { name: repo.name, git: join(clone, '.git'), path: clone, bare: false, checkout: clone });
      }
    } finally { fx.cleanup(); }
  });

  it('answers the primary checkouts even where none exists — what it answered before the second layout', () => {
    const env = { MC_REPOS_HOME: '/nowhere/home', MC_WORK_ROOT: '/nowhere/mc' };
    assert.deepEqual(defaultRepos(env, { exists: () => false }), [
      { name: 'memoro', git: '/nowhere/home/memoro/.git', path: '/nowhere/home/memoro', bare: false, checkout: '/nowhere/home/memoro' },
      { name: 'memoro-cli', git: '/nowhere/home/memoro-cli/.git', path: '/nowhere/home/memoro-cli', bare: false, checkout: '/nowhere/home/memoro-cli' },
    ]);
  });

  it('is what brief-collect.js exports, for the modules that import it from there', () => {
    assert.equal(fromBriefCollect, defaultRepos);
  });
});

describe('defaultRepos — the second layout', () => {
  it('a bare repository beside self/<name>: path is git, checkout the self worktree', () => {
    const fx = makeRepoLayout({ bare: ['memoro', 'memoro-cli'], self: ['memoro'] });
    try {
      const { memoro } = byName(defaultRepos(fx.env));
      const bare = join(fx.home, 'memoro.git');
      assert.deepEqual(memoro, { name: 'memoro', git: bare, path: bare, bare: true, checkout: join(fx.home, 'self', 'memoro') });
    } finally { fx.cleanup(); }
  });

  it('a bare repository without self/<name> has no checkout', () => {
    const fx = makeRepoLayout({ bare: ['memoro', 'memoro-cli'], self: ['memoro'] });
    try {
      const cli = byName(defaultRepos(fx.env))['memoro-cli'];
      const bare = join(fx.home, 'memoro-cli.git');
      assert.deepEqual(cli, { name: 'memoro-cli', git: bare, path: bare, bare: true, checkout: null });
    } finally { fx.cleanup(); }
  });

  it('a layout half moved answers each repository in its own', () => {
    const fx = makeRepoLayout({ bare: ['memoro-cli'], self: ['memoro-cli'], clones: ['memoro'] });
    try {
      const repos = byName(defaultRepos(fx.env));
      assert.equal(repos.memoro.bare, false);
      assert.equal(repos.memoro.checkout, join(fx.home, 'memoro'));
      assert.equal(repos['memoro-cli'].bare, true);
      assert.equal(repos['memoro-cli'].checkout, join(fx.home, 'self', 'memoro-cli'));
    } finally { fx.cleanup(); }
  });
});

describe('the homes and the names', () => {
  it('~/mc/repos and ~/mc/self under the work root; MC_REPOS_HOME moves both', () => {
    assert.equal(reposHome({ MC_WORK_ROOT: '/u/mc' }), '/u/mc/repos');
    assert.equal(selfHome({ MC_WORK_ROOT: '/u/mc' }), '/u/mc/self');
    assert.equal(reposHome({ MC_WORK_ROOT: '/u/mc', MC_REPOS_HOME: '/t' }), '/t');
    assert.equal(selfHome({ MC_WORK_ROOT: '/u/mc', MC_REPOS_HOME: '/t' }), '/t/self');
  });

  it('a common directory names its repository in both layouts', () => {
    assert.equal(repositoryDir('/u/memoro/.git'), '/u/memoro');
    assert.equal(repositoryDir('/u/mc/repos/memoro.git'), '/u/mc/repos/memoro.git');
    assert.equal(repositoryDir('/u/mc/repos/memoro.git/'), '/u/mc/repos/memoro.git');
  });

  it('a repository is called by its name in both layouts', () => {
    assert.equal(repoNameOf('/u/memoro-cli'), 'memoro-cli');
    assert.equal(repoNameOf('/u/mc/repos/memoro-cli.git'), 'memoro-cli');
    assert.equal(repoNameOf('/u/mc/repos/memoro-cli.git/'), 'memoro-cli');
    assert.equal(repoNameOf(''), '');
  });

  it('a { name, path } a caller built itself still has a git directory', () => {
    assert.equal(gitDirOf({ name: 'memoro', path: '/u/memoro' }), '/u/memoro/.git');
    assert.equal(gitDirOf({ name: 'memoro', path: '/r/memoro.git', git: '/r/memoro.git' }), '/r/memoro.git');
  });
});

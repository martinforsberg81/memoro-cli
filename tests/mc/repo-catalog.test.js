import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  candidateRepoDirs,
  listLocalRepoCatalog,
} from '../../src/mc/repo-catalog.js';

describe('mc local repo catalog', () => {
  test('candidateRepoDirs includes cwd and registry worktrees without duplicates', () => {
    const dirs = candidateRepoDirs({
      cwd: () => '/repos/memoro',
      registryReader: () => ({
        entries: [
          { primary_worktree: '/repos/memoro', worktree_path: '/mc/worktrees/memoro/alpha' },
          { primary_worktree: '/repos/memoro-cli', worktree_path: '/mc/worktrees/memoro-cli/beta' },
        ],
      }),
    });

    assert.deepEqual(dirs, [
      '/repos/memoro',
      '/mc/worktrees/memoro/alpha',
      '/repos/memoro-cli',
      '/mc/worktrees/memoro-cli/beta',
    ]);
  });

  test('listLocalRepoCatalog emits credential-free public repo refs', async () => {
    const contexts = new Map([
      ['/repos/memoro', {
        toplevel: '/repos/memoro',
        branch: 'main',
        remoteUrl: 'git@github.com:martinforsberg81/memoro.git',
      }],
      ['/mc/worktrees/memoro/alpha', {
        toplevel: '/repos/memoro',
        branch: 'sess/alpha',
        remoteUrl: 'git@github.com:martinforsberg81/memoro.git',
      }],
      ['/repos/local-only', {
        toplevel: '/repos/local-only',
        branch: 'main',
        remoteUrl: '/repos/local-only',
      }],
      ['/repos/web', {
        toplevel: '/repos/web',
        branch: 'develop',
        remoteUrl: 'https://github.com/acme/web.git',
      }],
    ]);

    const repos = await listLocalRepoCatalog({
      cwd: () => '/repos/memoro',
      registryReader: () => ({
        entries: [
          { primary_worktree: '/repos/local-only' },
          { primary_worktree: '/mc/worktrees/memoro/alpha' },
          { primary_worktree: '/repos/web' },
        ],
      }),
      repoContextReader: async (dir) => contexts.get(dir) || null,
      defaultBranchResolver: (dir) => ({
        ok: true,
        branch: dir === '/repos/web' ? 'develop' : 'main',
      }),
    });

    assert.deepEqual(repos, [
      {
        repo: 'memoro',
        repo_ref: 'martinforsberg81/memoro',
        branch: 'main',
        workspace_ref: 'main',
      },
      {
        repo: 'web',
        repo_ref: 'acme/web',
        branch: 'develop',
        workspace_ref: 'develop',
      },
    ]);
  });

  test('does not infer a workspace ref from the current branch', async () => {
    const repos = await listLocalRepoCatalog({
      cwd: () => '/repos/acme',
      registryReader: () => ({ entries: [] }),
      repoContextReader: async () => ({
        toplevel: '/repos/acme',
        branch: 'main',
        remoteUrl: 'https://github.com/acme/project.git',
      }),
      defaultBranchResolver: () => ({
        ok: false,
        reason: 'default-branch-unknown',
      }),
    });

    assert.equal(repos[0].branch, 'main');
    assert.equal(repos[0].workspace_ref, null);
  });
});

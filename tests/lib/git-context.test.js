import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { getRepoContext, deriveRepoName, derivePublicRepoRef } from '../../src/lib/git-context.js';

function gitInit(dir) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

describe('getRepoContext', () => {
  test('returns null when cwd is not inside a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memoro-cli-no-git-'));
    try {
      const ctx = await getRepoContext(dir);
      assert.equal(ctx, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns toplevel + branch for a fresh git repo (no remote)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memoro-cli-git-'));
    try {
      gitInit(dir);
      // Need at least one commit for symbolic-ref to resolve cleanly.
      await writeFile(join(dir, 'README.md'), '# test\n');
      spawnSync('git', ['add', '.'], { cwd: dir });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

      const ctx = await getRepoContext(dir);
      assert.ok(ctx);
      // macOS prefixes the realpath with /private; both forms point at the
      // same directory, so just assert the suffix.
      assert.ok(ctx.toplevel.endsWith(dir.replace(/^\/private/, '')) || ctx.toplevel === dir);
      assert.equal(ctx.branch, 'main');
      // Without origin remote, remoteUrl falls back to toplevel for identity.
      assert.equal(ctx.remoteUrl, ctx.toplevel);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reads origin remote URL when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memoro-cli-git-remote-'));
    try {
      gitInit(dir);
      await writeFile(join(dir, 'a.txt'), 'x');
      spawnSync('git', ['add', '.'], { cwd: dir });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
      spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir });

      const ctx = await getRepoContext(dir);
      assert.equal(ctx.remoteUrl, 'git@github.com:acme/widgets.git');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('finds context from a subdirectory of the repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memoro-cli-git-sub-'));
    try {
      gitInit(dir);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'x.js'), '');
      spawnSync('git', ['add', '.'], { cwd: dir });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

      const ctx = await getRepoContext(join(dir, 'src'));
      assert.ok(ctx);
      assert.equal(ctx.branch, 'main');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('deriveRepoName', () => {
  test('extracts repo name from ssh-style remote', () => {
    assert.equal(
      deriveRepoName({ remoteUrl: 'git@github.com:acme/widgets.git', toplevel: '/tmp/wat' }),
      'widgets',
    );
  });

  test('extracts repo name from https remote', () => {
    assert.equal(
      deriveRepoName({ remoteUrl: 'https://github.com/acme/widgets.git', toplevel: '/tmp/wat' }),
      'widgets',
    );
  });

  test('handles remote without .git suffix', () => {
    assert.equal(
      deriveRepoName({ remoteUrl: 'https://gitlab.com/team/proj', toplevel: '/x/y' }),
      'proj',
    );
  });

  test('falls back to toplevel basename when no real remote', () => {
    // remoteUrl == toplevel is the "no remote" fallback shape.
    assert.equal(
      deriveRepoName({ remoteUrl: '/tmp/local-only-repo', toplevel: '/tmp/local-only-repo' }),
      'local-only-repo',
    );
  });

  test('returns "unknown" for empty input', () => {
    assert.equal(deriveRepoName(null), 'unknown');
    assert.equal(deriveRepoName({}), 'unknown');
  });
});

describe('derivePublicRepoRef', () => {
  test('uses GitHub owner/repo shorthand for SSH remotes', () => {
    assert.equal(
      derivePublicRepoRef({ remoteUrl: 'git@github.com:acme/widgets.git', toplevel: '/tmp/wat' }),
      'acme/widgets',
    );
  });

  test('uses GitHub owner/repo shorthand for HTTPS remotes', () => {
    assert.equal(
      derivePublicRepoRef({ remoteUrl: 'https://github.com/acme/widgets.git', toplevel: '/tmp/wat' }),
      'acme/widgets',
    );
  });

  test('strips credentials from generic HTTPS remotes', () => {
    assert.equal(
      derivePublicRepoRef({ remoteUrl: 'https://user:secret@git.example.com/team/widgets.git?access_token=secret#fragment', toplevel: '/tmp/wat' }),
      'https://git.example.com/team/widgets',
    );
  });

  test('returns null for local-only repos and unparseable remotes', () => {
    assert.equal(
      derivePublicRepoRef({ remoteUrl: '/tmp/local-only-repo', toplevel: '/tmp/local-only-repo' }),
      null,
    );
    assert.equal(
      derivePublicRepoRef({ remoteUrl: 'not a clone url', toplevel: '/tmp/wat' }),
      null,
    );
  });
});

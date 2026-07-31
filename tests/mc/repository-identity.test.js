import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicalizeRemoteUrl,
  repositoryIdForCanonicalRemote,
  resolveRepositoryIdentity,
} from '../../src/mc/repository-identity.js';
import { resolveEntry } from '../../src/mc/registry.js';
import { git, makeTempRepo } from './_helpers/git-fixture.js';

test('canonicalizes equivalent GitHub remotes without credentials', () => {
  const canonical = 'github.com/owner/project';
  for (const remote of [
    'git@github.com:Owner/Project.git',
    'ssh://git@github.com/Owner/Project.git',
    'https://token:secret@github.com/Owner/Project.git?credential=secret#fragment',
  ]) {
    assert.equal(canonicalizeRemoteUrl(remote), canonical);
  }
  assert.equal(repositoryIdForCanonicalRemote(canonical), repositoryIdForCanonicalRemote(canonical));
  assert.doesNotMatch(canonical, /token|secret|@/u);
});

test('canonicalizes non-GitHub network remotes and rejects local paths', () => {
  assert.equal(
    canonicalizeRemoteUrl('ssh://deploy@git.example.test:2222/group/repo.git'),
    'git.example.test:2222/group/repo',
  );
  assert.equal(
    canonicalizeRemoteUrl('https://user:pass@git.example.test/group/repo.git'),
    'git.example.test/group/repo',
  );
  assert.equal(canonicalizeRemoteUrl('/tmp/repo.git'), null);
  assert.equal(canonicalizeRemoteUrl('file:///tmp/repo.git'), null);
});

test('remote identity is stable across clones and remote spellings', () => {
  const first = makeTempRepo({ name: 'repo-identity-remote-a' });
  const second = makeTempRepo({ name: 'repo-identity-remote-b' });
  try {
    git(first.dir, 'remote set-url origin git@github.com:Owner/Project.git');
    git(second.dir, 'remote set-url origin https://credential@github.com/owner/project');
    const a = resolveRepositoryIdentity(first.dir);
    const b = resolveRepositoryIdentity(second.dir);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.id, b.id);
    assert.equal(a.canonical, 'github.com/owner/project');
    assert.equal(b.canonical, 'github.com/owner/project');
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('local fallback survives repository relocation through local Git config', () => {
  const repo = makeTempRepo({ name: 'repo-identity-local' });
  try {
    git(repo.dir, 'remote remove origin');
    const created = resolveRepositoryIdentity(repo.dir, { createLocal: true });
    assert.equal(created.ok, true);
    assert.equal(created.kind, 'local');

    const relocated = join(repo.root, 'relocated-repository');
    renameSync(repo.dir, relocated);
    mkdirSync(join(relocated, 'nested'), { recursive: true });
    const reopened = resolveRepositoryIdentity(join(relocated, 'nested'));
    assert.equal(reopened.ok, true);
    assert.equal(reopened.id, created.id);
    assert.equal(reopened.source, 'git-config');
    const entry = {
      name: 'relocatable',
      session_id: 'mcs_dddddddddddddddddddddddd',
      repository_id: created.id,
      primary_worktree: repo.dir,
    };
    assert.equal(resolveEntry('relocatable', {
      cwd: relocated,
      registry: { schema_version: 2, entries: [entry] },
    }).entry, entry);
  } finally {
    repo.cleanup();
  }
});

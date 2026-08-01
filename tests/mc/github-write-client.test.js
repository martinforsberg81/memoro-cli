import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { resolveGitHubCreateContext } from '../../src/capabilities/github/github-write-client.js';

describe('GitHub write client local preconditions', () => {
  test('reads exact preconditions from a real session worktree shape', async (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'mc-github-write-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'mc-test@example.invalid');
    git('config', 'user.name', 'mc test');
    writeFileSync(join(repo, 'file.txt'), 'base\n');
    git('add', 'file.txt');
    git('commit', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', baseSha);
    git('switch', '-c', 'agent/local-write');
    writeFileSync(join(repo, 'file.txt'), 'write\n');
    git('commit', '-am', 'write');
    const headSha = git('rev-parse', 'HEAD');

    assert.deepEqual(await resolveGitHubCreateContext({
      base: 'main',
      cwd: repo,
    }), {
      head: 'agent/local-write',
      base: 'main',
      expected_head_sha: headSha,
      expected_base_sha: baseSha,
    });
  });

  test('derives the exact session branch and remote base SHA without network or authority input', async () => {
    const calls = [];
    const values = new Map([
      ['symbolic-ref --short HEAD', 'agent/local-write'],
      ['rev-parse HEAD', 'A'.repeat(40)],
      ['rev-parse --verify refs/remotes/origin/main', 'B'.repeat(40)],
    ]);
    const result = await resolveGitHubCreateContext({
      base: 'main',
      cwd: '/repo',
      runGit: async (args, cwd) => {
        calls.push({ args, cwd });
        return values.get(args.join(' ')) || null;
      },
    });

    assert.deepEqual(result, {
      head: 'agent/local-write',
      base: 'main',
      expected_head_sha: 'a'.repeat(40),
      expected_base_sha: 'b'.repeat(40),
    });
    assert.deepEqual(calls.map((call) => call.args), [
      ['symbolic-ref', '--short', 'HEAD'],
      ['rev-parse', 'HEAD'],
      ['rev-parse', '--verify', 'refs/remotes/origin/main'],
    ]);
    assert.ok(calls.every((call) => call.cwd === '/repo'));
  });

  test('falls back to the local base ref and fails closed on detached or missing state', async () => {
    const fallback = await resolveGitHubCreateContext({
      base: 'main',
      runGit: async (args) => ({
        'symbolic-ref --short HEAD': 'agent/local-write',
        'rev-parse HEAD': 'a'.repeat(40),
        'rev-parse --verify refs/heads/main': 'b'.repeat(40),
      })[args.join(' ')] || null,
    });
    assert.equal(fallback.expected_base_sha, 'b'.repeat(40));

    assert.equal(await resolveGitHubCreateContext({
      base: 'main',
      runGit: async (args) => (
        args[0] === 'symbolic-ref' ? null : 'a'.repeat(40)
      ),
    }), null);
    assert.equal(await resolveGitHubCreateContext({
      base: '../other',
      runGit: async () => { throw new Error('must not run'); },
    }), null);
  });
});

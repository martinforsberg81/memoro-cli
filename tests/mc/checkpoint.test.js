import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkpoint, checkpointRef } from '../../src/mc/checkpoint.js';

/** The runner's `deps.git`, for real: `-C cwd`, and an env laid over this one. */
function git(cwd, args, { env } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** A repository with one commit of two files, and a scratch directory beside it. */
function repo() {
  const base = mkdtempSync(join(tmpdir(), 'mc-checkpoint-'));
  const worktree = join(base, 'work');
  const scratch = join(base, 'scratch');
  spawnSync('git', ['init', '-q', '-b', 'main', worktree]);
  for (const [key, value] of [['user.name', 'T'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) git(worktree, ['config', key, value]);
  writeFileSync(join(worktree, 'a.txt'), 'one\n');
  writeFileSync(join(worktree, 'b.txt'), 'two\n');
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-q', '-m', 'first']);
  return { base, worktree, scratch, index: join(scratch, 'checkpoint-p-1.index'), done: () => rmSync(base, { recursive: true, force: true }) };
}

const read = (cwd, args) => git(cwd, args).stdout;

test('a modified and an untracked file land in the ref; the worktree, its index and HEAD are untouched', () => {
  const r = repo();
  try {
    writeFileSync(join(r.worktree, 'a.txt'), 'one, changed\n');
    writeFileSync(join(r.worktree, 'new.txt'), 'untracked\n');
    // One file staged by the session itself, so the real index is not empty to begin with.
    writeFileSync(join(r.worktree, 'b.txt'), 'two, staged\n');
    git(r.worktree, ['add', 'b.txt']);
    const head = read(r.worktree, ['rev-parse', 'HEAD']);
    const status = read(r.worktree, ['status', '--porcelain']);
    const cached = read(r.worktree, ['diff', '--cached']);

    const sha = checkpoint({ git, worktree: r.worktree, project: 'p', label: 'running', index: r.index, now: new Date('2026-10-10T12:00:00Z') });

    assert.match(sha, /^[0-9a-f]{40}$/u);
    assert.equal(read(r.worktree, ['rev-parse', checkpointRef('p')]).trim(), sha);
    assert.equal(read(r.worktree, ['show', `${checkpointRef('p')}:a.txt`]), 'one, changed\n');
    assert.equal(read(r.worktree, ['show', `${checkpointRef('p')}:new.txt`]), 'untracked\n');
    assert.equal(read(r.worktree, ['show', `${checkpointRef('p')}:b.txt`]), 'two, staged\n');
    assert.equal(read(r.worktree, ['rev-parse', `${checkpointRef('p')}^`]), head, 'a commit on top of HEAD');
    assert.equal(read(r.worktree, ['log', '-1', '--format=%s', checkpointRef('p')]).trim(), 'mc checkpoint p running 2026-10-10T12:00:00.000Z');

    assert.equal(read(r.worktree, ['status', '--porcelain']), status, 'the worktree reads as it did');
    assert.equal(read(r.worktree, ['diff', '--cached']), cached, 'the real index holds what it held');
    assert.equal(read(r.worktree, ['diff', '--cached', '--name-only']).trim(), 'b.txt');
    assert.equal(read(r.worktree, ['rev-parse', 'HEAD']), head);
    assert.equal(existsSync(r.index), false, 'the temporary index is removed');
    assert.deepEqual(readdirSync(r.scratch), []);
  } finally {
    r.done();
  }
});

test('with nothing staged, the real index stays empty of changes', () => {
  const r = repo();
  try {
    writeFileSync(join(r.worktree, 'a.txt'), 'changed\n');
    writeFileSync(join(r.worktree, 'c.txt'), 'new\n');
    const status = read(r.worktree, ['status', '--porcelain']);
    assert.ok(checkpoint({ git, worktree: r.worktree, project: 'p', label: 'before-merge-abort', index: r.index }));
    assert.equal(read(r.worktree, ['status', '--porcelain']), status);
    assert.equal(read(r.worktree, ['diff', '--cached']), '');
  } finally {
    r.done();
  }
});

test('a clean tree writes no ref', () => {
  const r = repo();
  try {
    assert.equal(checkpoint({ git, worktree: r.worktree, project: 'p', label: 'running', index: r.index }), null);
    assert.equal(git(r.worktree, ['rev-parse', '-q', '--verify', checkpointRef('p')]).ok, false);
  } finally {
    r.done();
  }
});

test('a later snapshot replaces the ref, and a git that refuses is a null, not a throw', () => {
  const r = repo();
  try {
    writeFileSync(join(r.worktree, 'a.txt'), 'first\n');
    const first = checkpoint({ git, worktree: r.worktree, project: 'p', label: 'running', index: r.index });
    writeFileSync(join(r.worktree, 'a.txt'), 'second\n');
    const second = checkpoint({ git, worktree: r.worktree, project: 'p', label: 'running', index: r.index });
    assert.notEqual(first, second);
    assert.equal(read(r.worktree, ['show', `${checkpointRef('p')}:a.txt`]), 'second\n');

    const throwing = () => { throw new Error('boom'); };
    assert.equal(checkpoint({ git: throwing, worktree: r.worktree, project: 'p', label: 'running', index: r.index }), null);
    assert.equal(checkpoint({ git: () => ({ ok: false, stdout: '' }), worktree: r.worktree, project: 'p', label: 'running', index: r.index }), null);
  } finally {
    r.done();
  }
});

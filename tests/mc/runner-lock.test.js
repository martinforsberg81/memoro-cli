import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { lockPath, realLock } from '../../src/mc/runner-lock.js';

function layout2Root() {
  const root = mkdtempSync(join(tmpdir(), 'mc-runner-lock-'));
  mkdirSync(join(root, 'runner'), { recursive: true });
  writeFileSync(join(root, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('realLock holds runner/register.lock in layout 2 and runner/projects/.lock in layout 1, and removes it after', () => {
  const { root, cleanup } = layout2Root();
  try {
    const two = join(root, 'runner', 'register.lock');
    assert.equal(lockPath(root), two);
    assert.equal(realLock(root, () => existsSync(two)), true, 'held while fn runs');
    assert.equal(existsSync(two), false, 'removed after');
    assert.equal(existsSync(join(root, 'runner', 'projects')), false, 'layout 2 makes no directory of its own');
    rmSync(join(root, 'runner'), { recursive: true });
    const one = join(root, 'runner', 'projects', '.lock');
    assert.equal(realLock(root, () => existsSync(one)), true, 'layout 1: the old file, so old and new code exclude each other');
    assert.equal(existsSync(one), false);
  } finally { cleanup(); }
});

test('realLock takes over a lock a dead pid left, and strict refuses one a live pid holds past the wait', () => {
  const { root, cleanup } = layout2Root();
  try {
    const path = lockPath(root);
    writeFileSync(path, '999999');
    assert.equal(realLock(root, () => 'ran', { alive: () => false }), 'ran');
    writeFileSync(path, String(process.pid + 1));
    assert.throws(() => realLock(root, () => 'ran', { alive: () => true, waitMs: 0, strict: true }), /held by pid/u);
    assert.equal(realLock(root, () => 'ran anyway', { alive: () => true, waitMs: 0 }), 'ran anyway', 'not strict: the write goes ahead');
  } finally { cleanup(); }
});

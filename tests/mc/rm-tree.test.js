import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmTree } from '../../src/mc/rm-tree.js';

/**
 * `rm -r` fails on a read-only file inside a read-only directory. memoro's
 * dependency cache copies are read-only, and a session's `depcache/` under
 * scratch made the chore pass's removal fail with EACCES on 2026-10-25.
 */
test('a tree with read-only files in read-only directories is removed', () => {
  const base = mkdtempSync(join(tmpdir(), 'mc-rm-tree-'));
  try {
    const tree = join(base, 'scratch');
    const inner = join(tree, 'depcache', 'pkg');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'index.js'), 'export {};\n');
    chmodSync(join(inner, 'index.js'), 0o444);
    chmodSync(inner, 0o555);
    chmodSync(join(tree, 'depcache'), 0o555);

    assert.equal(rmTree(tree), true);
    assert.equal(existsSync(tree), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * A symbolic link is part of the tree and not its contents: the link goes, and
 * the read-only file it points at, outside the tree, is neither made writable
 * nor removed.
 */
test('a symbolic link out of the tree is removed with the link, and its target stays read-only', () => {
  const base = mkdtempSync(join(tmpdir(), 'mc-rm-tree-'));
  try {
    const tree = join(base, 'scratch');
    mkdirSync(tree);
    const target = join(base, 'outside.txt');
    writeFileSync(target, 'kept\n');
    chmodSync(target, 0o444);
    symlinkSync(target, join(tree, 'link.txt'));

    assert.equal(rmTree(tree), true);
    assert.equal(existsSync(tree), false);
    assert.equal(readFileSync(target, 'utf8'), 'kept\n');
    assert.equal(statSync(target).mode & 0o200, 0, 'the target is still read-only');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a path already gone is gone, and a path that cannot be looked at is not reported as removed', () => {
  const base = mkdtempSync(join(tmpdir(), 'mc-rm-tree-'));
  try {
    assert.equal(rmTree(join(base, 'never-made')), true);
    writeFileSync(join(base, 'a-file'), '');
    assert.equal(rmTree(join(base, 'a-file', 'inside')), false);
    assert.equal(existsSync(join(base, 'a-file')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * The one question D-0152 needs answered before a suite number means anything:
 * do the declared dependencies have a tree to be found in?
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { dependencyTree } from '../../src/mc/dependency-tree.js';

function project(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-dependency-tree-'));
  if (manifest !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

describe('dependencyTree', () => {
  it('declares dependencies and has no tree: missing', () => {
    const dir = project({ dependencies: { a: '1' }, devDependencies: { b: '1', c: '1' } });
    try {
      assert.deepEqual(dependencyTree(dir), { manifest: true, declares: 3, present: false, missing: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a linked tree counts — that is how the four worktrees were repaired', () => {
    const dir = project({ dependencies: { a: '1' } });
    const shared = mkdtempSync(join(tmpdir(), 'mc-shared-modules-'));
    try {
      symlinkSync(shared, join(dir, 'node_modules'));
      assert.equal(dependencyTree(dir).missing, false);
      assert.equal(dependencyTree(dir).present, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it('declares nothing: not missing, whatever the filesystem says', () => {
    const dir = project({ name: 'plain' });
    try {
      assert.deepEqual(dependencyTree(dir), { manifest: true, declares: 0, present: false, missing: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('no manifest: not a Node project, nothing claimed', () => {
    const dir = project(null);
    try {
      mkdirSync(join(dir, 'node_modules'));
      assert.deepEqual(dependencyTree(dir), { manifest: false, declares: 0, present: true, missing: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

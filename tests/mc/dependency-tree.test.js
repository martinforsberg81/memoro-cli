/**
 * The one question D-0152 needs answered before a suite number means anything:
 * can the declared dependencies be resolved from here?
 *
 * "Here" is not one directory. Node walks `node_modules` up every parent of
 * the importing file, and mc keeps one tree above every workarea and above the
 * gate's candidate — so a question asked of the checkout alone would report
 * every one of them missing while their imports resolve perfectly well.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { dependencyTree } from '../../src/mc/dependency-tree.js';

function project(manifest, { at = null } = {}) {
  const dir = at || mkdtempSync(join(tmpdir(), 'mc-dependency-tree-'));
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

/** `<dir>/node_modules/<name>`, as an install would leave it. */
function installed(dir, ...names) {
  for (const name of names) mkdirSync(join(dir, 'node_modules', name), { recursive: true });
}

describe('dependencyTree', () => {
  it('declares dependencies and can resolve none of them: missing, and it says which', () => {
    const dir = project({ dependencies: { a: '1' }, devDependencies: { b: '1', c: '1' } });
    try {
      assert.deepEqual(dependencyTree(dir), {
        manifest: true, declares: 3, present: false, unresolved: ['a', 'b', 'c'], missing: true,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a linked tree counts — that is how the four worktrees were repaired', () => {
    const dir = project({ dependencies: { a: '1' } });
    const shared = mkdtempSync(join(tmpdir(), 'mc-shared-modules-'));
    try {
      mkdirSync(join(shared, 'a'));
      symlinkSync(shared, join(dir, 'node_modules'));
      assert.equal(dependencyTree(dir).missing, false);
      assert.equal(dependencyTree(dir).present, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shared, { recursive: true, force: true });
    }
  });

  /**
   * The whole mechanism this project is built on, asserted where it is
   * decided: `~/mc/node_modules` is above the workareas and above the gate's
   * candidate, and nothing is inside either — which is what keeps it out of
   * git's sight and out of `scripts/affected-tests.js`'s.
   */
  it('a tree above the directory resolves, with nothing inside it', () => {
    const work = mkdtempSync(join(tmpdir(), 'mc-work-root-'));
    try {
      installed(work, '@xterm/headless', 'node-pty');
      const checkout = project(
        { dependencies: { '@xterm/headless': '6', 'node-pty': '1' } },
        { at: join(work, 'gate', 'memoro-cli-1234abcd', 'candidate') },
      );
      const tree = dependencyTree(checkout);
      assert.equal(tree.missing, false, 'the tree two directories up was not looked for');
      assert.equal(tree.present, false, 'and nothing was put inside the checkout to make it resolve');
      assert.deepEqual(tree.unresolved, []);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it('a tree that is there but does not hold the package is still missing', () => {
    // The half-installed case the old question could not see: `node_modules`
    // is a directory, so it answered "present" while the import failed.
    const dir = project({ dependencies: { a: '1', b: '1' } });
    try {
      installed(dir, 'a');
      const tree = dependencyTree(dir);
      assert.equal(tree.present, true);
      assert.equal(tree.missing, true);
      assert.deepEqual(tree.unresolved, ['b']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('declares nothing: not missing, whatever the filesystem says', () => {
    const dir = project({ name: 'plain' });
    try {
      assert.deepEqual(dependencyTree(dir), {
        manifest: true, declares: 0, present: false, unresolved: [], missing: false,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('no manifest: not a Node project, nothing claimed', () => {
    const dir = project(null);
    try {
      mkdirSync(join(dir, 'node_modules'));
      assert.deepEqual(dependencyTree(dir), {
        manifest: false, declares: 0, present: true, unresolved: [], missing: false,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * What `mc gate` reads off the worktree: the change against a merge-base,
 * over a real throwaway repository because what it promises is about git,
 * and the declared `node --test` flags.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { changedAgainst, declaredTestFlags, docsOnly } from '../../src/mc/gate-fast.js';
import { tryGit } from '../../src/mc/git.js';

describe('changedAgainst, on a real repository', () => {
  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'mc-gate-fast-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const write = (path, body) => { mkdirSync(join(root, dirname(path)), { recursive: true }); writeFileSync(join(root, path), body); };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'gate@example.com');
    git('config', 'user.name', 'gate');
    write('src/a.js', 'export const a = 1;\n');
    write('docs/old.md', 'old\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    return { root, git, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('the change against a merge-base is committed, staged, unstaged and untracked, and a rename is both sides', () => {
    const fx = repo();
    try {
      const base = fx.git('rev-parse', 'HEAD');
      fx.git('mv', 'src/a.js', 'docs/a.md');
      fx.git('commit', '-qm', 'move');
      fx.write('docs/old.md', 'edited\n');
      fx.write('docs/new.md', 'new\n');
      const changed = changedAgainst({ git: tryGit }, fx.root, base);
      assert.deepEqual(changed, ['docs/a.md', 'docs/new.md', 'docs/old.md', 'src/a.js']);
      assert.equal(docsOnly(changed), false);
    } finally { fx.cleanup(); }
  });
});

describe('the selector answers --changed-path (scripts/affected-tests.js)', () => {
  it('selects by the named paths, not by the diff to the base', () => {
    const fx = mkdtempSync(join(tmpdir(), 'mc-affected-paths-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: fx, encoding: 'utf8' });
      const write = (path, body) => { mkdirSync(join(fx, dirname(path)), { recursive: true }); writeFileSync(join(fx, path), body); };
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'gate');
      write('scripts/affected-tests.js', readFileSync(new URL('../../scripts/affected-tests.js', import.meta.url)));
      write('src/a.js', 'export const a = 1;\n');
      write('src/b.js', 'export const b = 1;\n');
      write('tests/a.test.js', "import '../src/a.js';\n");
      write('tests/b.test.js', "import '../src/b.js';\n");
      git('add', '-A');
      git('commit', '-qm', 'base');
      git('branch', 'origin-main');
      write('src/a.js', 'export const a = 2;\n');
      write('src/b.js', 'export const b = 2;\n');
      git('commit', '-qam', 'both');
      const run = (...args) => JSON.parse(execFileSync(process.execPath, ['scripts/affected-tests.js', '--base-ref', 'origin-main', ...args], { cwd: fx, encoding: 'utf8' }));
      assert.deepEqual(run().files, ['tests/a.test.js', 'tests/b.test.js']);
      assert.deepEqual(run('--changed-path', 'src/b.js').files, ['tests/b.test.js']);
    } finally { rmSync(fx, { recursive: true, force: true }); }
  });
});

describe('declaredTestFlags', () => {
  it('declaredTestFlags reads the primary checkout\'s declaration', () => {
    const io = (answer) => ({ git: (cwd, args) => (args.includes('--git-common-dir') ? '/repo/x/.git' : null), declaration: answer });
    assert.deepEqual(declaredTestFlags(io(() => ({ ok: true, declaration: { pr_tests_flags: ['--import', './a.mjs'] } })), { root: '/w/x', env: {} }), ['--import', './a.mjs']);
    assert.equal(declaredTestFlags(io(() => ({ ok: true, declaration: {} })), { root: '/w/x', env: {} }), null);
    assert.equal(declaredTestFlags(io(() => ({ ok: true, declaration: { pr_tests_flags: [] } })), { root: '/w/x', env: {} }), null);
    assert.equal(declaredTestFlags(io(() => ({ ok: false, reason: 'x' })), { root: '/w/x', env: {} }), null);
    assert.equal(declaredTestFlags(io(() => { throw new Error('bad file'); }), { root: '/w/x', env: {} }), null);
    const noCommon = { git: () => null, declaration: () => ({ ok: true, declaration: { pr_tests_flags: ['--import', './a.mjs'] } }) };
    assert.equal(declaredTestFlags(noCommon, { root: '/w/x', env: {} }), null);
  });
});

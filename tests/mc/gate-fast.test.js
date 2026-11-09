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

import { changedAgainst, docsOnly, flagsOf, measuredDeclaration } from '../../src/mc/gate-fast.js';
import { declarationFor } from '../../src/mc/repo-gate-table.js';
import { tryGit } from '../../src/mc/git.js';
import { main as selector } from '../../scripts/affected-tests.js';

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
      // The command in this process, on the fixture (two node processes took
      // 2 s, 2026-11-03); affected-tests.test.js runs it as a script.
      const run = (...args) => {
        let out = '';
        assert.equal(selector(['--base-ref', 'origin-main', ...args], { root: fx, stdout: { write: (text) => { out += text; } } }), 0);
        return JSON.parse(out);
      };
      assert.deepEqual(run().files, ['tests/a.test.js', 'tests/b.test.js']);
      assert.deepEqual(run('--changed-path', 'src/b.js').files, ['tests/b.test.js']);
    } finally { rmSync(fx, { recursive: true, force: true }); }
  });
});

describe('measuredDeclaration and the flags it declares', () => {
  const io = (answer, common = '/repo/x/.git') => ({ git: (cwd, args) => (args.includes('--git-common-dir') ? common : null), declaration: answer });
  const measure = (answer, common) => measuredDeclaration(io(answer, common), { root: '/w/x', env: {} });

  it('flagsOf is the nonempty pr_tests_flags of the measured declaration, and null when it declares none', () => {
    const flags = (answer, common) => flagsOf(measure(answer, common)?.declaration);
    assert.deepEqual(flags(() => ({ ok: true, declaration: { pr_tests_flags: ['--import', './a.mjs'] } })), ['--import', './a.mjs']);
    assert.equal(flags(() => ({ ok: true, declaration: {} })), null);
    assert.equal(flags(() => ({ ok: true, declaration: { pr_tests_flags: [] } })), null);
    assert.equal(flags(() => { throw new Error('bad file'); }), null);
    assert.equal(flags(() => ({ ok: true, declaration: { pr_tests_flags: ['--import', './a.mjs'] } }), null), null);
  });

  it('an ok:false declaration with a reason is a stop, whatever its kind; the no-entry fallback is null', () => {
    assert.deepEqual(measure(() => ({ ok: false, reason: 'x' })), { stop: 'x' });
    assert.deepEqual(measure(() => ({ ok: false, kind: 'invalid', reason: 'y' })), { stop: 'y' });
    assert.equal(measure(() => ({ ok: false, kind: 'undeclared', reason: 'no entry' })), null);
  });

  it('timeout policy: the session names the repository by its common directory and reads the declaration of the worktree it measures', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-gate-fast-policy-'));
    try {
      const home = join(root, 'home');
      const worktree = join(root, 'wt');
      const declare = (dir, body) => { mkdirSync(join(dir, '.mc'), { recursive: true }); writeFileSync(join(dir, '.mc', 'test.json'), body); };
      mkdirSync(home, { recursive: true });
      declare(join(root, 'memoro'), JSON.stringify({ pr_tests_flags: ['--import', './primary.mjs', '--test-timeout=5000'] }));
      declare(worktree, JSON.stringify({ pr_tests_flags: ['--import', './tests/_helpers/browser-paths.mjs', '--test-timeout=1000'] }));
      writeFileSync(join(home, 'repo-gates.json'), JSON.stringify({ memoro: { pr_tests_flags: ['--import', './tests/_helpers/browser-paths.mjs'] } }));
      const asked = [];
      const io = (common) => ({
        git: (cwd, args) => (args.includes('--git-common-dir') ? common : null),
        declaration: (path, options) => { asked.push([path, options.contentDir]); return declarationFor(path, { root: home, env: {}, contentDir: options.contentDir }); },
      });
      for (const [common, primary] of [[join(root, 'repos', 'memoro.git'), join(root, 'repos', 'memoro.git')], [join(root, 'memoro', '.git'), join(root, 'memoro')]]) {
        asked.length = 0;
        const measured = measuredDeclaration(io(common), { root: worktree, env: {} });
        assert.deepEqual(asked, [[primary, worktree]]);
        assert.deepEqual([measured.primary, measured.contentDir], [primary, worktree]);
        assert.deepEqual(measured.declaration.pr_tests_flags, ['--import', './tests/_helpers/browser-paths.mjs', '--test-timeout=1000']);
        assert.equal(measured.notice, `timeout policy: --test-timeout=1000 from ${join(worktree, '.mc', 'test.json')} — `
          + `pr_tests_flags from the operator override ${join(home, 'repo-gates.json')} states no --test-timeout`);
      }
      // A malformed declaration in the measured worktree is a stop, never the script fallback.
      declare(worktree, '{"pr_tests_flags": [');
      const stopped = measuredDeclaration(io(join(root, 'repos', 'memoro.git')), { root: worktree, env: {} });
      assert.deepEqual(Object.keys(stopped), ['stop']);
      assert.match(stopped.stop, /^memoro declares itself in .*\/wt\/\.mc\/test\.json, but it could not be read as JSON/u);
      assert.equal(flagsOf(measuredDeclaration(io(join(root, 'repos', 'memoro.git')), { root: worktree, env: {} })?.declaration), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

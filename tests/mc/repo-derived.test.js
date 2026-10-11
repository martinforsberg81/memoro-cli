/**
 * Derived artifacts are regenerated on the merged tree, committed when the
 * dirt is what the declaration said, and named when it is not.
 *
 * Run against a real repository: what is asserted is which files git ends up
 * with, and a fake git would only repeat this module's own idea of that.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DERIVED_COMMIT_MESSAGE, dirtyPaths, regenerateDerived } from '../../src/mc/repo-derived.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'mc', GIT_AUTHOR_EMAIL: 'mc@example.invalid',
  GIT_COMMITTER_NAME: 'mc', GIT_COMMITTER_EMAIL: 'mc@example.invalid',
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-repo-derived-'));
  const git = (args, opts = {}) => spawnSync('git', args, { cwd: opts.cwd || dir, env: ENV, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  mkdirSync(join(dir, 'docs', 'sql'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'sql', 'snapshot.json'), '{"files":1}\n');
  writeFileSync(join(dir, 'src.js'), 'export {};\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (fx, derived) => regenerateDerived({ derived, cwd: fx.dir, env: ENV, git: fx.git });

describe('regenerating derived artifacts after a merge', () => {
  it('a tree that is already current is left alone — no commit', async () => {
    const fx = repo();
    try {
      const out = await run(fx, [{ command: 'printf \'{"files":1}\\n\' > docs/sql/snapshot.json', paths: ['docs/sql/'] }]);
      assert.deepEqual(out, { ok: true, regenerated: [], commit: null });
      assert.equal(fx.git(['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
    } finally { fx.cleanup(); }
  });

  it('dirt inside the declared paths is committed, new files included', async () => {
    const fx = repo();
    try {
      const out = await run(fx, [
        { command: 'printf \'{"files":2}\\n\' > docs/sql/snapshot.json', paths: ['docs/sql/'] },
        { command: 'echo report > docs/sql/report.md', paths: ['docs/sql'] },
      ]);
      assert.equal(out.ok, true, out.reason);
      assert.deepEqual(out.regenerated.sort(), ['docs/sql/report.md', 'docs/sql/snapshot.json']);
      assert.equal(out.commit, fx.git(['rev-parse', 'HEAD']).stdout.trim());
      assert.equal(fx.git(['log', '-1', '--format=%s']).stdout.trim(), DERIVED_COMMIT_MESSAGE);
      assert.equal(fx.git(['status', '--porcelain']).stdout, '', 'nothing left behind');
    } finally { fx.cleanup(); }
  });

  it('dirt outside the declared paths is named, and nothing is committed', async () => {
    const fx = repo();
    try {
      const out = await run(fx, [{ command: 'echo 2 > docs/sql/snapshot.json && echo x >> src.js', paths: ['docs/sql/'] }]);
      assert.equal(out.ok, false);
      assert.equal(out.kind, 'outside');
      assert.deepEqual(out.outside, ['src.js']);
      assert.match(out.reason, /outside the declared paths \(docs\/sql\): src\.js/u);
      assert.equal(fx.git(['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
    } finally { fx.cleanup(); }
  });

  it('a path that merely shares a prefix is not inside the declaration', async () => {
    const fx = repo();
    try {
      const out = await run(fx, [{ command: 'mkdir -p docs/sql-other && echo x > docs/sql-other/a', paths: ['docs/sql'] }]);
      assert.equal(out.kind, 'outside');
      assert.deepEqual(out.outside, ['docs/sql-other/a']);
    } finally { fx.cleanup(); }
  });

  it('a command that fails is a reason, and stops before the next one', async () => {
    const fx = repo();
    try {
      const out = await run(fx, [
        { command: 'echo nope >&2; exit 3', paths: ['docs/sql/'] },
        { command: 'echo never > docs/sql/never', paths: ['docs/sql/'] },
      ]);
      assert.equal(out.ok, false);
      assert.equal(out.kind, 'failed');
      assert.match(out.reason, /exit 3.*failed — nope/u);
      assert.equal(fx.git(['status', '--porcelain']).stdout, '');
    } finally { fx.cleanup(); }
  });

  it('nothing declared is nothing run', async () => {
    assert.deepEqual(await regenerateDerived({ derived: [], cwd: '/nonexistent', git: () => { throw new Error('asked git'); } }), { ok: true, regenerated: [], commit: null });
  });

  it('reads porcelain the way git writes it', async () => {
    assert.deepEqual(dirtyPaths(' M a/b.json\n?? c d.md\nR  old -> new/x\n?? "q r.md"\n'), ['a/b.json', 'c d.md', 'new/x', 'q r.md']);
  });
});

/**
 * The selector the gate trusts.
 *
 * `mc test` runs whatever this returns, on both sides, and reports the
 * comparison as the verdict. So the property that matters is not that it picks
 * a small set — it is that the set it picks contains everything the change
 * could break, and that when it cannot know, it says the whole suite rather
 * than a plausible subset. A selector that is wrong in the small direction
 * turns the gate into a machine for producing confident greens.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = new URL('../../scripts/affected-tests.js', import.meta.url).pathname;

/**
 * A throwaway git repository with the shape this selector reads: sources under
 * `src/`, tests under `tests/`, a base commit, and a change on top of it.
 */
function repo({ base = {}, change = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-affected-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const write = (path, body) => {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'gate@example.com');
  git('config', 'user.name', 'gate');
  // The script lives in the repository it measures, so it is copied in.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/affected-tests.js'), execFileSync('cat', [SCRIPT]));
  for (const [path, body] of Object.entries(base)) write(path, body);
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('branch', '-f', 'origin-main', 'main');
  for (const [path, body] of Object.entries(change)) write(path, body);
  if (Object.keys(change).length) { git('add', '-A'); git('commit', '-qm', 'change'); }

  return {
    root,
    select: () => JSON.parse(execFileSync(process.execPath, [
      join(root, 'scripts/affected-tests.js'), '--base-ref', 'origin-main',
    ], { cwd: root, encoding: 'utf8' })),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('which tests a change reaches', () => {
  it('follows imports through a chain, not just the direct one', () => {
    // The edge a one-level graph misses: the test imports the wrapper, the
    // wrapper imports the thing that changed.
    const fx = repo({
      base: {
        'src/deep.js': 'export const value = 1;\n',
        'src/wrapper.js': "import { value } from './deep.js';\nexport const wrapped = value;\n",
        'tests/wrapper.test.js': "import { wrapped } from '../src/wrapper.js';\nexport default wrapped;\n",
        'tests/unrelated.test.js': "export default 'nothing to do with any of it';\n",
      },
      change: { 'src/deep.js': 'export const value = 2;\n' },
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'affected');
      assert.deepEqual(files, ['tests/wrapper.test.js']);
      assert.match(why.selected_by['tests/wrapper.test.js'].join(' '), /imports:src\/deep\.js/u);
    } finally { fx.cleanup(); }
  });

  it('follows a source a test reads as text, which no import graph can see', () => {
    // This repository really does this: `merge-doc.test.js` asserts against
    // `repo-gate.js`'s own source that no merge call is in it. That test
    // imports nothing from the file it is guarding.
    const fx = repo({
      base: {
        'src/guarded.js': 'export const safe = true;\n',
        'tests/pin.test.js': "import { readFileSync } from 'node:fs';\nreadFileSync('src/guarded.js');\n",
      },
      change: { 'src/guarded.js': 'export const safe = false;\n' },
    });
    try {
      const { files, why } = fx.select();
      assert.deepEqual(files, ['tests/pin.test.js']);
      assert.match(why.selected_by['tests/pin.test.js'].join(' '), /pins:src\/guarded\.js/u);
    } finally { fx.cleanup(); }
  });

  it('a changed test file selects itself', () => {
    const fx = repo({
      base: {
        'src/a.js': 'export const a = 1;\n',
        'tests/a.test.js': "import { a } from '../src/a.js';\nexport default a;\n",
      },
      change: { 'tests/a.test.js': "import { a } from '../src/a.js';\nexport default a + 1;\n" },
    });
    try {
      assert.deepEqual(fx.select().files, ['tests/a.test.js']);
    } finally { fx.cleanup(); }
  });

  it('a path it cannot trace means the whole suite, not a smaller guess', () => {
    // The direction that matters. A manifest, a lockfile, a workflow: real
    // changes whose reach is written down nowhere this script can read. Being
    // slow is a cost; being confidently wrong about reach is the failure the
    // gate exists to prevent.
    const fx = repo({
      base: {
        'src/a.js': 'export const a = 1;\n',
        'tests/a.test.js': "import { a } from '../src/a.js';\nexport default a;\n",
        'tests/b.test.js': "export default 'unrelated';\n",
      },
      change: { 'package.json': '{"name":"changed"}\n' },
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'full-suite');
      assert.deepEqual(files, ['tests/a.test.js', 'tests/b.test.js']);
      assert.deepEqual(why.unexplained, ['package.json']);
    } finally { fx.cleanup(); }
  });

  it('a change that reaches nothing selects nothing, and says so plainly', () => {
    // Not an error, and not a licence either: the gate refuses to treat an
    // empty selection as a measurement, so this is where that refusal starts.
    const fx = repo({
      base: {
        'src/a.js': 'export const a = 1;\n',
        'src/lonely.js': 'export const lonely = true;\n',
        'tests/a.test.js': "import { a } from '../src/a.js';\nexport default a;\n",
      },
      change: { 'src/lonely.js': 'export const lonely = false;\n' },
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'affected');
      assert.deepEqual(files, []);
    } finally { fx.cleanup(); }
  });
});

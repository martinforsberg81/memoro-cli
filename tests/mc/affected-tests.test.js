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
function repo({ base = {}, change = {}, remove = [] } = {}) {
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
  for (const path of remove) git('rm', '-q', path);
  if (Object.keys(change).length || remove.length) { git('add', '-A'); git('commit', '-qm', 'change'); }

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

  /**
   * The third edge: data. Measured 2026-08-30, 17 of the last 20 merges ran the
   * whole suite, and 51 of the 63 paths that forced them were under `docs/` —
   * every one of them named by the very test that checks it. The fallback was
   * asking "is this source?" when the question is "does anything read this?".
   */
  it('a doc a test reads is that test, not the whole suite', () => {
    const fx = repo({
      base: {
        'docs/technical/thing.md': '# thing\n\nninety minutes\n',
        'tests/doc.test.js': "import { readFileSync } from 'node:fs';\nreadFileSync('docs/technical/thing.md');\n",
        'tests/other.test.js': "export default 'unrelated';\n",
      },
      change: { 'docs/technical/thing.md': '# thing\n\nsixty minutes\n' },
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'affected');
      assert.deepEqual(files, ['tests/doc.test.js']);
    } finally { fx.cleanup(); }
  });

  /**
   * A directory is the only written-down link to a file whose name is built at
   * run time: `readCanonRole` opens `canon/roles/<kind>.md`, so no literal ever
   * spells `brief.md`, and the module spells the directory instead.
   */
  it('data read through a directory reaches every test that reaches the reader', () => {
    const fx = repo({
      base: {
        'canon/roles/brief.md': 'the brief role\n',
        'src/roles.js': "import { readFileSync } from 'node:fs';\nexport const read = (k) => readFileSync(`canon/roles/${k}.md`);\n",
        'tests/roles.test.js': "import { read } from '../src/roles.js';\nexport default read;\n",
        'tests/other.test.js': "export default 'unrelated';\n",
      },
      change: { 'canon/roles/brief.md': 'the brief role, revised\n' },
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'affected');
      assert.deepEqual(files, ['tests/roles.test.js']);
      assert.match(why.selected_by['tests/roles.test.js'].join(' '), /reads:canon\/roles\/brief\.md/u);
    } finally { fx.cleanup(); }
  });

  /**
   * The boundary of *that* widening, measured on this repository 2026-08-30:
   * one new plan document selected 57 of 250 test files, every one for the same
   * reason. `run.js` spells the project tree to build a plan's path, so the
   * directory edge made it a reader of every file under it, and the import
   * graph handed that to everything reaching it. Building a path under a tree
   * is not reading a file in it.
   *
   * The fixtures below name trees this repository does not have, and the
   * paragraph above names none of them in backticks — this file is read by the
   * very index it tests, so a literal here is indistinguishable from a real
   * one, in prose as much as in a fixture.
   */
  it('a tree a module builds paths under is not every test that imports it', () => {
    const fx = repo({
      base: {
        'docs/ledger/prog/proj/PLAN.md': '# a plan\n',
        'src/plans.js': 'export const planPath = (p) => `docs/ledger/${p}/PLAN.md`;\n',
        'tests/importer.test.js': "import { planPath } from '../src/plans.js';\nexport default planPath;\n",
        'tests/scanner.test.js': "import { readdirSync } from 'node:fs';\nreaddirSync('docs/ledger');\n",
        'tests/other.test.js': "export default 'unrelated';\n",
      },
      change: { 'docs/ledger/prog/added/PLAN.md': '# another plan\n' },
    });
    try {
      const { files, why } = fx.select();
      // Not the whole suite: the tree is read, so the change is explained.
      assert.equal(why.reason, 'affected');
      assert.deepEqual(files, ['tests/scanner.test.js']);
    } finally { fx.cleanup(); }
  });

  /**
   * And the token that made the tree edge cheap to trip. `'docs'` on its own is
   * a segment handed to `join()` far more often than a tree anybody reads —
   * the same ambiguity `PIN_TOKEN` already refuses for `'index.js'`.
   */
  it('a one-segment directory literal is a path segment, not a tree', () => {
    const fx = repo({
      base: {
        'docs/guide/thing.md': '# thing\n',
        'tests/segment.test.js': "import { join } from 'node:path';\nexport default join('docs', 'guide');\n",
        'tests/tree.test.js': "import { readdirSync } from 'node:fs';\nreaddirSync('docs/guide');\n",
      },
      change: { 'docs/guide/other.md': '# other\n' },
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'affected');
      assert.deepEqual(files, ['tests/tree.test.js']);
    } finally { fx.cleanup(); }
  });

  /**
   * The boundary of that widening, and the reason it is a list rather than a
   * rule. A manifest changes what every test runs *inside*, so whoever happens
   * to name it understates its reach by a mile.
   */
  it('a manifest is not data, however many tests name it', () => {
    const fx = repo({
      base: {
        'src/a.js': 'export const a = 1;\n',
        'tests/a.test.js': "import { readFileSync } from 'node:fs';\nreadFileSync('./package.json');\n",
        'tests/b.test.js': "export default 'unrelated';\n",
      },
      change: { 'package.json': '{"name":"changed"}\n' },
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'full-suite');
      assert.deepEqual(files, ['tests/a.test.js', 'tests/b.test.js']);
    } finally { fx.cleanup(); }
  });

  it('a doc nothing reads is an unanswered question, not an inert one', () => {
    const fx = repo({
      base: {
        'docs/orphan.md': '# nobody reads me\n',
        'tests/a.test.js': "export default 'a';\n",
      },
      change: { 'docs/orphan.md': '# still nobody\n' },
    });
    try {
      const { why } = fx.select();
      assert.equal(why.reason, 'full-suite');
      assert.deepEqual(why.unexplained, ['docs/orphan.md']);
    } finally { fx.cleanup(); }
  });

  it('a doc that is deleted, and that nothing reads, reaches nothing', () => {
    // The companion to the case above, and the reason it is not the same
    // question. An orphan doc that is still there may have a reader this
    // script cannot see; an orphan doc that is gone has nothing left to read.
    const fx = repo({
      base: {
        'docs/orphan.md': '# nobody reads me\n',
        'src/a.js': 'export const a = 1;\n',
        'tests/a.test.js': "import { a } from '../src/a.js';\nexport default a;\n",
      },
      remove: ['docs/orphan.md'],
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'affected');
      assert.deepEqual(files, []);
    } finally { fx.cleanup(); }
  });

  it('deleting a doc a test does read still selects that test', () => {
    // The rule above must not swallow a real reach: the deletion that breaks
    // its reader is exactly the one worth running.
    const fx = repo({
      base: {
        'docs/read.md': '# somebody reads me\n',
        'tests/a.test.js': "import { readFileSync } from 'node:fs';\nreadFileSync('docs/read.md');\n",
        'tests/b.test.js': "export default 'unrelated';\n",
      },
      remove: ['docs/read.md'],
    });
    try {
      const { files, why } = fx.select();
      assert.equal(why.reason, 'affected');
      assert.deepEqual(files, ['tests/a.test.js']);
    } finally { fx.cleanup(); }
  });

  it('a deleted root document nothing reads is not the whole suite', () => {
    // Not under DATA_DIRS, and it does not need to be: the rule is about the
    // file being gone, not about where it lived.
    const fx = repo({
      base: {
        'LEGACY.md': '# a map nobody loads\n',
        'src/a.js': 'export const a = 1;\n',
        'tests/a.test.js': "import { a } from '../src/a.js';\nexport default a;\n",
      },
      remove: ['LEGACY.md'],
    });
    try {
      const { why } = fx.select();
      assert.equal(why.reason, 'affected');
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

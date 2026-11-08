import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { SETTLE_FILES_MAX, settleRed } from '../../src/mc/gate-settle.js';
import { settledLine } from '../../src/mc/commands/gate.js';

/**
 * A finished node TAP run in `cwd`: each red entry is `[file, test name]`, cut
 * at the 1 s limit as node reports it; `pass` passing tests beside them.
 */
function tap(cwd, red = [], pass = 1) {
  const lines = ['TAP version 13'];
  let n = 0;
  for (let i = 0; i < pass; i++) lines.push(`ok ${++n} - passes`);
  for (const [file, name] of red) {
    lines.push(`# Subtest: ${name}`, `not ok ${++n} - ${name}`, '  ---', '  duration_ms: 1001.2', "  type: 'test'",
      `  location: '${cwd}/${file}:3:1'`, "  failureType: 'testTimeoutFailure'", "  error: 'test timed out after 1000ms'",
      "  code: 'ERR_TEST_FAILURE'", '  ...');
  }
  lines.push(`1..${n}`, `# tests ${n}`, `# pass ${pass}`, `# fail ${red.length}`, '# cancelled 0');
  return `${lines.join('\n')}\n`;
}

/**
 * The candidate is `cwd`; `alone` is what the red files do run by themselves,
 * `atBase` what they do at the base. git answers the worktree add by making the
 * directory with the base's files, and `touched` is what the change touches.
 */
function fixture(t, { alone = [], atBase = [], touched = [], baseFiles = null, aloneTap = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-settle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'candidate');
  mkdirSync(cwd);
  const calls = { tests: [], git: [], attach: [] };
  const tests = async ({ cwd: dir, files, lanes }) => {
    calls.tests.push({ dir, files, lanes });
    if (dir === cwd) return { code: alone.length ? 1 : 0, tap: aloneTap ?? tap(dir, alone.filter(([file]) => files.includes(file))) };
    return { code: atBase.length ? 1 : 0, tap: tap(dir, atBase.filter(([file]) => files.includes(file))) };
  };
  const git = async (dir, args) => {
    calls.git.push(args);
    if (args[0] === 'diff') return { status: 0, stdout: touched.join('\n') };
    if (args[0] === 'ls-files') return { status: 0, stdout: '' };
    if (args[0] === 'worktree' && args[1] === 'add') {
      const into = args[3];
      for (const file of baseFiles ?? ['a.test.js', 'b.test.js', 'c.test.js']) {
        mkdirSync(join(into, file, '..'), { recursive: true });
        writeFileSync(join(into, file), '');
      }
      return { status: 0 };
    }
    return { status: 0 };
  };
  const attach = async (dir) => { calls.attach.push(dir); return { ok: true }; };
  const settle = (red, failing) => settleRed({ cwd, base: 'f'.repeat(40), red, failing, tests, git, attach, root, id: 'run' });
  return { cwd, root, calls, settle };
}
const failing = (cwd, pairs) => pairs.map(([file, name]) => ({ file, name, error: ['test timed out after 1000ms'] }));

it('a file red under load and green run alone is settled; nothing runs at the base', async (t) => {
  const f = fixture(t);
  const result = await f.settle(['a.test.js'], failing(f.cwd, [['a.test.js', 'scans the tree']]));
  assert.deepEqual(result.alone, ['a.test.js']);
  assert.deepEqual(result.red, []);
  assert.deepEqual(f.calls.tests, [{ dir: f.cwd, files: ['a.test.js'], lanes: 1 }], 'one run alone, one file at a time');
  assert.equal(f.calls.git.length, 0, 'no base worktree when everything passed alone');
});

it('a file still red alone, untouched, with the same tests red at the base is main\'s red', async (t) => {
  const red = [['a.test.js', 'scans the tree'], ['b.test.js', 'imports only core']];
  const f = fixture(t, { alone: red, atBase: red });
  const result = await f.settle(['a.test.js', 'b.test.js'], failing(f.cwd, red));
  assert.deepEqual(result.main, ['a.test.js', 'b.test.js']);
  assert.deepEqual(result.red, []);
  assert.equal(result.base, 'f'.repeat(40));
  assert.equal(f.calls.tests[1].dir, join(f.root, 'runner', 'gate-base', 'run'), 'the base runs in its own worktree');
  assert.deepEqual(f.calls.attach, [join(f.root, 'runner', 'gate-base', 'run')], 'with its dependencies attached');
  assert.ok(f.calls.git.some((args) => args[0] === 'worktree' && args[1] === 'remove'), 'and the worktree is removed');
  assert.equal(existsSync(join(f.root, 'runner', 'gate-base', 'run')), false);
});

it('the change\'s red stays red: a touched file, another test red at the base, or a base that passes', async (t) => {
  const red = [['a.test.js', 'scans the tree']];
  const touched = fixture(t, { alone: red, atBase: red, touched: ['a.test.js'] });
  assert.deepEqual((await touched.settle(['a.test.js'], failing(touched.cwd, red))).red, ['a.test.js'], 'a file the change touches');
  const other = fixture(t, { alone: red, atBase: [['a.test.js', 'another test']] });
  assert.deepEqual((await other.settle(['a.test.js'], failing(other.cwd, red))).red, ['a.test.js'], 'a different test red at the base');
  const passes = fixture(t, { alone: red, atBase: [] });
  const result = await passes.settle(['a.test.js'], failing(passes.cwd, red));
  assert.deepEqual(result.red, ['a.test.js'], 'green at the base: the change broke it');
  assert.deepEqual(result.main, []);
  const gone = fixture(t, { alone: red, atBase: red, baseFiles: [] });
  assert.deepEqual((await gone.settle(['a.test.js'], failing(gone.cwd, red))).red, ['a.test.js'], 'a file the base does not have');
});

it('nothing is settled from a red no file accounts for, an unfinished run alone, or too many files', async (t) => {
  const f = fixture(t);
  const stray = await f.settle(['a.test.js'], [{ file: null, name: 'somewhere', error: [] }]);
  assert.deepEqual(stray.red, ['a.test.js']);
  assert.equal(f.calls.tests.length, 0, 'not run again');
  const cut = fixture(t, { aloneTap: 'TAP version 13\nok 1 - started\n' });
  assert.deepEqual((await cut.settle(['a.test.js'], failing(cut.cwd, [['a.test.js', 'x']]))).red, ['a.test.js'], 'a run alone without its summary');
  const unattributed = fixture(t, { aloneTap: 'TAP version 13\nnot ok 1 - x\n1..1\n# tests 1\n# pass 0\n# fail 1\n' });
  assert.deepEqual((await unattributed.settle(['a.test.js'], failing(unattributed.cwd, [['a.test.js', 'x']]))).red, ['a.test.js'],
    'a failure alone that names no file');
  const many = Array.from({ length: SETTLE_FILES_MAX + 1 }, (_, i) => `f${i}.test.js`);
  const big = fixture(t);
  assert.deepEqual((await big.settle(many, failing(big.cwd, many.map((file) => [file, 'x'])))).red, many);
  assert.equal(big.calls.tests.length, 0);
});

it('the verdict names what was settled, and nothing when nothing was', () => {
  assert.equal(settledLine({ settled: { alone: ['a.test.js'], main: ['b.test.js', 'c.test.js'], base: 'f'.repeat(40), red: [] } }),
    'SETTLED — green alone (red in the round under load): a.test.js; red on main fffffff too, untouched by this change: b.test.js c.test.js');
  assert.equal(settledLine({}), null);
  assert.equal(settledLine({ settled: { alone: [], main: [], red: ['a.test.js'] } }), null);
  assert.equal(settledLine({ settled: { alone: [], main: [], commands_alone: ['lint', 'test:db'], red: [] } }),
    'SETTLED — command gates green alone (red in the round under load): lint test:db');
  assert.equal(settledLine({ settled: { alone: ['a.test.js'], main: [], commands_alone: ['lint'], red: [] } }),
    'SETTLED — green alone (red in the round under load): a.test.js; command gates green alone (red in the round under load): lint');
});

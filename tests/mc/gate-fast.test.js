/**
 * `mc gate`'s fast paths: nothing changed, docs only, unchanged since a green,
 * and the incremental run after a red — each refused on any doubt.
 *
 * `planGate` and `recordLast` run over an injected machine; `snapshotTree`
 * and `changedAgainst` over a real throwaway repository, because what they
 * promise is about git.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { LAST_FILE, changedAgainst, declaredTestFlags, docsOnly, incrementalPlan, planGate, recordLast, snapshotTree } from '../../src/mc/gate-fast.js';
import { tryGit } from '../../src/mc/git.js';

const ROOT = '/w/x';
const GIT_DIR = '/w/x/.git';
const LAST = `${GIT_DIR}/${LAST_FILE}`;
const MB = 'mb00000000000000000000000000000000000000';
const MANIFEST = { scripts: { test: "node --test --import ./tests/_isolate-home.mjs 'tests/**/*.test.js'" } };

/**
 * A machine: `diff` is what the worktree changes against the merge-base,
 * `untracked` the new files, `since` what changed between the last tree and
 * this one, `last` the file beside the lock, `selection` what select prints.
 */
function machine({ mergeBase = MB, diff = [], untracked = [], tree = 'tree-now', last = null, since = [], select = 'node select.js', selection = { files: [], commands: [] }, selectStatus = 0, flags = null, present = null } = {}) {
  const files = new Map();
  if (last) files.set(LAST, JSON.stringify(last));
  const asked = { selects: [], snapshots: 0 };
  const io = {
    git: (cwd, args) => {
      if (args[0] === 'merge-base') return mergeBase;
      if (args[0] === 'ls-files') return untracked.join('\0');
      if (args[0] === 'diff' && args.length === 5) return diff.join('\0');
      if (args[0] === 'diff' && args.length === 6) return since == null ? null : since.join('\0');
      if (args.includes('--git-common-dir')) return '/repo/x/.git';
      return null;
    },
    snapshotTree: () => { asked.snapshots += 1; return tree; },
    exists: (path) => files.has(path) || (present ? present.some((file) => path === join(ROOT, file)) : path.startsWith(`${ROOT}/tests/`)),
    read: (path) => { if (files.has(path)) return files.get(path); throw new Error('ENOENT'); },
    write: (path, text) => { files.set(path, text); },
    mkdir: () => {},
    declaration: () => (select ? { ok: true, declaration: { select, pr_tests_flags: flags } } : { ok: true, declaration: {} }),
    select: (command, opts) => { asked.selects.push({ command, ...opts }); return { status: selectStatus, stdout: JSON.stringify(selection) }; },
  };
  return { io, files, asked };
}

const plan = (m, extra = {}) => planGate(m.io, { root: ROOT, gitDir: GIT_DIR, base: 'origin/main', env: { MC_HOME: '/home' }, manifest: MANIFEST, ...extra });
const red = (extra = {}) => ({ tree: 'tree-red', base: MB, ref: 'origin/main', exit: 1, red: ['tests/mc/a.test.js'], red_commands: [], at: '2026-10-18T09:00:00.000Z', log: '/scratch/gate.log', ...extra });

describe('docs only and nothing changed', () => {
  it('a diff of documents only is GREEN at once, and nothing is snapshotted or selected', () => {
    const m = machine({ diff: ['docs/technical/mc-merge.md'], untracked: ['docs/project/mc/new.md'] });
    const result = plan(m);
    assert.match(result.answer.text, /^GREEN — docs only, nothing to run — 0s\n2 paths changed against origin\/main, every one under docs\/ and none a script/u);
    assert.deepEqual(result.answer.json.paths, ['docs/project/mc/new.md', 'docs/technical/mc-merge.md']);
    assert.equal(m.asked.snapshots, 0);
  });

  it('a script under docs/, or anything outside it, is not docs only', () => {
    assert.equal(docsOnly(['docs/a.md', 'docs/tool.mjs']), false);
    assert.equal(docsOnly(['docs/a.md', 'src/a.js']), false);
    assert.equal(docsOnly(['docs/a.md', 'README.md']), false);
    assert.equal(docsOnly([]), false);
    assert.equal(plan(machine({ diff: ['docs/a.md'], untracked: ['src/new.js'] })).answer, undefined);
  });

  it('an empty diff says plainly nothing changed', () => {
    const result = plan(machine());
    assert.match(result.answer.text, /^GREEN — nothing changed against origin\/main \(merge-base mb00000\)/u);
    assert.equal(result.answer.json.fast, 'unchanged-base');
  });

  it('--full skips both and measures, keeping the snapshot', () => {
    assert.deepEqual(plan(machine({ diff: ['docs/a.md'] }), { full: true }), { snapshot: { tree: 'tree-now', base: MB, ref: 'origin/main' } });
  });

  it('no merge-base, or git that cannot list the change: the whole gate, as before', () => {
    assert.deepEqual(plan(machine({ mergeBase: null })), {});
    const m = machine({ diff: ['docs/a.md'] });
    const git = m.io.git;
    m.io.git = (cwd, args) => (args[0] === 'ls-files' ? null : git(cwd, args));
    assert.equal(plan(m).answer, undefined);
  });
});

describe('unchanged since a green', () => {
  it('the last whole gate measured this tree green against this merge-base: GREEN (unchanged since …)', () => {
    const result = plan(machine({ diff: ['src/a.js'], last: red({ tree: 'tree-now', exit: 0, red: [] }) }));
    assert.match(result.answer.text, /^GREEN \(unchanged since 2026-10-18T09:00:00\.000Z\) — the whole gate measured this tree green against origin\/main; nothing to run — log: \/scratch\/gate\.log$/u);
  });

  it('another tree, another merge-base or another ref: the whole gate', () => {
    const snap = { snapshot: { tree: 'tree-now', base: MB, ref: 'origin/main' } };
    assert.deepEqual(plan(machine({ diff: ['src/a.js'], last: red({ tree: 'tree-old', exit: 0 }) })), snap);
    assert.deepEqual(plan(machine({ diff: ['src/a.js'], last: red({ tree: 'tree-now', exit: 0, base: 'other' }) })), snap);
    assert.deepEqual(plan(machine({ diff: ['src/a.js'], last: red({ tree: 'tree-now', exit: 0, ref: 'origin/dev' }) })), snap);
  });
});

describe('incremental after a red', () => {
  it('runs the red files, the selection for what changed since, and its command gates', () => {
    const m = machine({
      diff: ['src/a.js', 'src/b.js'], last: red(), since: ['src/b.js', 'tests/mc/new one.test.js'], flags: ['--import', './tests/_isolate-home.mjs'],
      selection: { files: ['tests/mc/a.test.js', 'tests/mc/b.test.js'], commands: [{ packageScript: 'lint', passBaseRef: true }, { packageScript: 'check:x', passBaseRef: false }] },
    });
    const { incremental } = plan(m);
    assert.equal(m.asked.selects[0].command, "node select.js --changed-path src/b.js --changed-path 'tests/mc/new one.test.js'");
    assert.equal(m.asked.selects[0].cwd, ROOT);
    assert.match(m.asked.selects[0].env.MC_SELECTION_STATE, /^\/home\/selection\/x-/u);
    assert.deepEqual(incremental.command.files, ['tests/mc/a.test.js', 'tests/mc/b.test.js']);
    assert.equal(incremental.command.run, '(rc=0; node --test --import ./tests/_isolate-home.mjs tests/mc/a.test.js tests/mc/b.test.js || rc=1; npm run lint -- --base-ref origin/main || rc=1; npm run check:x || rc=1; exit $rc)');
    assert.equal(incremental.command.shown, 'node --test 2 files + npm run lint + npm run check:x');
    assert.equal(incremental.command.label, 'INCREMENTAL — 1 red file from the gate at 2026-10-18T09:00:00.000Z + 1 selected for 2 paths changed since + commands lint, check:x; not the whole gate (mc gate --full)');
  });

  it('an unchanged red tree runs the red files alone, without asking the selector', () => {
    const m = machine({ diff: ['src/a.js'], tree: 'tree-red', last: red() });
    const { incremental } = plan(m);
    assert.equal(incremental.command.run, 'node --test --import ./tests/_isolate-home.mjs tests/mc/a.test.js');
    assert.deepEqual(m.asked.selects, []);
  });

  it('a red file that no longer exists is not run', () => {
    const m = machine({ diff: ['src/a.js'], tree: 'tree-red', last: red({ red: ['tests/mc/a.test.js', 'tests/mc/gone.test.js'] }), present: ['tests/mc/a.test.js'] });
    assert.deepEqual(plan(m).incremental.command.files, ['tests/mc/a.test.js']);
  });

  it('any doubt is the whole gate: no red files, no select, a selector error, an unreadable diff, a red command it does not name', () => {
    const whole = (m) => assert.deepEqual(Object.keys(plan(m)), ['snapshot']);
    whole(machine({ diff: ['src/a.js'], last: red({ red: [] }) }));
    whole(machine({ diff: ['src/a.js'], last: red(), since: ['src/a.js'], select: null }));
    whole(machine({ diff: ['src/a.js'], last: red(), since: ['src/a.js'], selectStatus: 1 }));
    whole(machine({ diff: ['src/a.js'], last: red(), since: null }));
    whole(machine({ diff: ['src/a.js'], last: red({ red_commands: ['sql:pr-ci'] }), since: ['src/a.js'], selection: { files: [], commands: [{ packageScript: 'lint' }] } }));
    whole(machine({ diff: ['src/a.js'], last: red({ base: 'other' }) }));
    whole(machine({ diff: ['src/a.js'], tree: 'tree-red', last: red({ red: ['tests/mc/gone.test.js'] }), present: [] }));
  });

  it('a red command gate the selection names is run again', () => {
    const m = machine({ diff: ['src/a.js'], last: red({ red_commands: ['lint'] }), since: ['src/a.js'], selection: { files: [], commands: [{ packageScript: 'lint' }] } });
    assert.deepEqual(incrementalPlan(m.io, { root: ROOT, env: {}, base: 'origin/main', last: red({ red_commands: ['lint'] }), tree: 'tree-now', manifest: MANIFEST }).commands, ['lint']);
  });

  it('the incremental plan says when a command it runs needs docker', () => {
    const incrementalWith = (commands) => plan(machine({ diff: ['src/a.js'], last: red(), since: ['src/a.js'], selection: { files: [], commands } })).incremental;
    assert.equal(incrementalWith([{ packageScript: 'sql:reference:postgres', needs: ['docker'] }]).docker, true);
    assert.equal(incrementalWith([{ packageScript: 'lint' }]).docker, false);
  });
});

describe('recordLast', () => {
  const lock = { snapshot: { tree: 'tree-now', base: MB, ref: 'origin/main' }, started: '2026-10-18T10:00:00.000Z', log: '/scratch/g.log' };

  it('writes the tree, the base, the exit, the red files and the red command gates', () => {
    const m = machine();
    assert.equal(recordLast(m.io, { lock, lockPath: `${GIT_DIR}/mc-gate.json`, root: ROOT, output: 'test at tests/mc/a.test.js:3:1\n✖ x\n', code: 1, gates: ['lint'] }), true);
    assert.deepEqual(JSON.parse(m.files.get(LAST)), {
      tree: 'tree-now', base: MB, ref: 'origin/main', exit: 1, red: ['tests/mc/a.test.js'], red_commands: ['lint'], at: '2026-10-18T10:00:00.000Z', log: '/scratch/g.log',
    });
  });

  it('a tree that moved while the gate ran writes nothing', () => {
    const m = machine({ tree: 'tree-moved' });
    assert.equal(recordLast(m.io, { lock, lockPath: `${GIT_DIR}/mc-gate.json`, root: ROOT, output: '', code: 0 }), false);
    assert.equal(m.files.has(LAST), false);
  });
});

describe('snapshotTree and changedAgainst, on a real repository', () => {
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

  it('the tree includes untracked files, changes with them, and leaves the index alone', () => {
    const fx = repo();
    try {
      const gitDir = fx.git('rev-parse', '--absolute-git-dir');
      const clean = snapshotTree(fx.root, gitDir);
      assert.equal(clean, fx.git('rev-parse', 'HEAD^{tree}'));
      fx.write('src/new.js', 'x\n');
      const dirty = snapshotTree(fx.root, gitDir);
      assert.notEqual(dirty, clean);
      assert.equal(snapshotTree(fx.root, gitDir), dirty);
      assert.equal(fx.git('status', '--porcelain'), '?? src/new.js');
      assert.equal(snapshotTree('/nonexistent-mc-gate', gitDir), null);
    } finally { fx.cleanup(); }
  });

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

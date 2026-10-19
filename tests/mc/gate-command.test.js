/**
 * `mc gate` — the verb: a detached gate, a budget, one gate per worktree.
 *
 * Everything the verb touches is injected: the spawn, the clock, the sleep,
 * the files and the pid liveness. Nothing here starts a process or reads disk.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/gate.js';
import { GATE_MEASUREMENT_VERSION, selectionHash } from '../../src/mc/gate-greens.js';

const CHILD = 4242;
const LOG = '/scratch/gate-20260925T100000Z.log';
const EXIT = `${LOG}.exit`;
const LOCK = '/w/x/.git/mc-gate.json';
const OLD_LOG = '/scratch/gate-20260925T095000Z.log';

/**
 * A fake machine. The gate finishes after `finishAfter` sleeps: it writes its
 * log and exit code then, and is no longer alive.
 */
function harness({ lock = null, manifest = { scripts: { test: 'node --test' } }, live = [], finishAfter = Infinity, code = 0, output = '', tests = [], deploy = null } = {}) {
  const files = new Map();
  const alive = new Set(live);
  const out = { stdout: '', stderr: '', spawned: [], dirs: [], removed: [], ticks: 0, unref: false };
  let clock = Date.parse('2026-09-25T10:00:00Z');
  if (lock) files.set(LOCK, JSON.stringify(lock));
  for (const test of tests) files.set(`/w/x/${test}`, '');
  const deps = {
    stdout: { write: (s) => { out.stdout += s; } },
    stderr: { write: (s) => { out.stderr += s; } },
    cwd: '/w/x',
    env: { MC_SCRATCH: '/scratch' },
    now: () => new Date(clock),
    git: (cwd, args) => ({ '--show-toplevel': '/w/x', '--absolute-git-dir': '/w/x/.git' })[args[1]] ?? null,
    read: (path) => {
      if (path === '/w/x/package.json' && manifest) return JSON.stringify(manifest);
      if (files.has(path)) return files.get(path);
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    },
    exists: (path) => files.has(path),
    write: (path, text) => { files.set(path, text); },
    remove: (path) => { out.removed.push(path); files.delete(path); },
    mkdir: (dir) => { out.dirs.push(dir); },
    open: () => 9,
    close: () => {},
    spawn: (file, args, opts) => {
      out.spawned.push({ file, args, opts });
      alive.add(CHILD);
      return { pid: CHILD, unref: () => { out.unref = true; } };
    },
    alive: (pid) => alive.has(pid),
    deployHolding: () => deploy,
    sleep: async (ms) => {
      clock += ms;
      out.ticks += 1;
      if (out.ticks >= finishAfter) {
        files.set(LOG, output);
        files.set(EXIT, `${code}\n`);
        alive.clear();
      }
    },
  };
  return { out, deps, files };
}

const oldGate = (pid, extra = {}) => ({ pid, log: OLD_LOG, started: '2026-09-25T09:50:00.000Z', command: { run: 'npm test', script: 'node --test', base: 'origin/main' }, ...extra });

describe('mc gate, started', () => {
  it('a gate that finishes inside the budget prints its verdict and clears the lock', async () => {
    const { out, deps, files } = harness({ finishAfter: 3, output: '✔ a (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\n' });
    assert.equal(await run([], deps), 0);
    assert.equal(out.spawned[0].file, 'sh');
    assert.deepEqual(out.spawned[0].args, ['-c', `npm test; echo $? > '${EXIT}'`]);
    assert.deepEqual([out.spawned[0].opts.cwd, out.spawned[0].opts.detached, out.spawned[0].opts.stdio], ['/w/x', true, ['ignore', 9, 9]]);
    assert.deepEqual([out.spawned[0].opts.env.CI, out.spawned[0].opts.env.FORCE_COLOR, out.spawned[0].opts.env.NO_COLOR], ['1', '0', '1']);
    assert.equal(out.unref, true);
    assert.deepEqual(out.dirs, ['/scratch']);
    assert.equal(files.get(`${LOG}.pid`), `${CHILD}\n`);
    assert.equal(out.stdout, `GREEN — npm test — 1 tests, 0 failed — 6s\nwhole output: ${LOG}\n`);
    assert.equal(files.has(LOCK), false);
    assert.deepEqual(out.removed, [LOCK]);
  });

  it('past the budget it prints RUNNING with the log and exits 3, and the lock stays', async () => {
    const { out, deps, files } = harness();
    assert.equal(await run(['--budget', '10'], deps), 3);
    assert.equal(out.stdout, `RUNNING — npm test — 10s so far, still running (pid ${CHILD})\nlog: ${LOG} — mc gate --wait waits for it and prints the verdict\n`);
    assert.equal(files.has(LOCK), true);
    assert.deepEqual(out.removed, []);
  });

  it('the gate\'s child is told the lanes to use, unless its environment already names them', async () => {
    const { out, deps } = harness({ finishAfter: 1, output: 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n' });
    assert.equal(await run([], deps), 0);
    assert.match(out.spawned[0].opts.env.MC_TEST_LANES, /^[1-9]\d*$/u);
  });

  it('a merge round holding the heavy lane is waited for like a deploy, and named', async () => {
    const { out, deps } = harness({ deploy: { pid: 778, mode: 'merge' }, finishAfter: 1, output: 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n' });
    assert.equal(await run([], deps), 0);
    assert.match(out.spawned[0].args[1], /await-deploy\.js/u);
    assert.equal(out.stderr, 'mc: a merge round holds the heavy lane (pid 778) — this gate starts its tests when it is done\n');
  });

  it('a deploy holding the heavy lane is waited for inside the child, and said once', async () => {
    const { out, deps } = harness({ deploy: { pid: 777, mode: 'deploy' }, finishAfter: 1, output: 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n' });
    assert.equal(await run([], deps), 0);
    assert.match(out.spawned[0].args[1], /^'[^']+' '[^']+await-deploy\.js'; npm test; echo \$\? > '/u);
    assert.equal(out.stderr, 'mc: a deploy holds the heavy lane (pid 777) — this gate starts its tests when it is done\n');

    const free = harness({ finishAfter: 1, output: 'ℹ tests 1\nℹ fail 0\n' });
    assert.equal(await run([], free.deps), 0);
    assert.doesNotMatch(free.out.spawned[0].args[1], /await-deploy/u);
  });

  it('a second gate while one is alive refuses with exit 2', async () => {
    const { out, deps } = harness({ lock: oldGate(111), live: [111] });
    assert.equal(await run([], deps), 2);
    assert.equal(out.stderr, 'mc: a gate is already running here (pid 111, since 2026-09-25T09:50:00.000Z) — mc gate --wait\n');
    assert.deepEqual(out.spawned, []);
  });

  it('a stale lock is taken over: a dead pid, or a gate whose exit file exists', async () => {
    const dead = harness({ lock: oldGate(111), live: [], finishAfter: 1, output: 'ℹ tests 2\nℹ pass 2\nℹ fail 0\n' });
    assert.equal(await run([], dead.deps), 0);
    assert.equal(dead.out.spawned.length, 1);
    assert.match(dead.out.stdout, /^GREEN — npm test — 2 tests, 0 failed — 2s\n/u);

    const exited = harness({ lock: oldGate(111), live: [111], finishAfter: 1, output: 'ℹ tests 1\nℹ fail 0\n' });
    exited.files.set(`${OLD_LOG}.exit`, '0\n');
    assert.equal(await run([], exited.deps), 0);
    assert.equal(exited.out.spawned.length, 1);
  });

  it('red is exit 1 with the failing lines; --base reaches the ci script; --json is the object', async () => {
    const ci = harness({ manifest: { scripts: { ci: 'node ci.mjs' } }, finishAfter: 1, code: 1, output: '✖ a (1ms)\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run(['--base', 'origin/dev'], ci.deps), 1);
    assert.equal(ci.out.spawned[0].args[1], `npm run ci -- --base-ref origin/dev; echo $? > '${EXIT}'`);
    assert.match(ci.out.stdout, /^RED — npm run ci -- --base-ref origin\/dev — 1 tests, 1 failed — 2s\n✖ a\nwhole output: /u);

    const json = harness({ finishAfter: 1, code: 1, output: '✖ a\n' });
    assert.equal(await run(['--json'], json.deps), 1);
    const parsed = JSON.parse(json.out.stdout);
    assert.deepEqual([parsed.ok, parsed.failures, parsed.command, parsed.script, parsed.exit, parsed.seconds], [false, ['✖ a'], 'npm test', 'node --test', 1, 2]);
  });

  it('is 2 outside a worktree, with nothing to run, on a positional, and on a budget that is not seconds', async () => {
    const none = harness({ manifest: { scripts: {} } });
    assert.equal(await run([], none.deps), 2);
    assert.match(none.out.stderr, /no ci or test script/u);
    const outside = harness();
    outside.deps.git = () => null;
    assert.equal(await run([], outside.deps), 2);
    const pos = harness();
    assert.equal(await run(['memoro'], pos.deps), 2);
    const budget = harness();
    assert.equal(await run(['--budget', '0'], budget.deps), 2);
    assert.match(budget.out.stderr, /--budget takes seconds/u);
    assert.deepEqual(budget.out.spawned, []);
  });
});

describe('mc gate <test files…>', () => {
  const TEST_SCRIPT = 'node --test --import ./tests/_isolate-home.mjs \'tests/**/*.test.js\'';

  it('named files run with the repository\'s node --test flags', async () => {
    const { out, deps } = harness({ manifest: { scripts: { test: TEST_SCRIPT } }, tests: ['a.test.js'], finishAfter: 1, output: 'ℹ tests 1\nℹ fail 0\n' });
    assert.equal(await run(['a.test.js'], deps), 0);
    assert.equal(out.spawned[0].args[1], `node --test --import ./tests/_isolate-home.mjs a.test.js; echo $? > '${EXIT}'`);
    assert.match(out.stdout, /^GREEN — node --test --import \.\/tests\/_isolate-home\.mjs a\.test\.js — 1 tests, 0 failed — 2s\n/u);
  });

  it('named files run with the declared pr_tests_flags, which replace the test script\'s', async () => {
    const { out, deps } = harness({ manifest: { scripts: { test: 'node scripts/testing/ci.mjs' } }, tests: ['tests/x.test.js'], finishAfter: 1, output: 'ℹ tests 1\nℹ fail 0\n' });
    const plain = deps.git;
    deps.git = (cwd, args) => (args.includes('--git-common-dir') ? '/repo/x/.git' : plain(cwd, args));
    const asked = [];
    deps.declaration = (path) => { asked.push(path); return { ok: true, declaration: { pr_tests_flags: ['--import', './tests/_helpers/browser-paths.mjs'] } }; };
    assert.equal(await run(['tests/x.test.js'], deps), 0);
    assert.equal(out.spawned[0].args[1], `node --test --import ./tests/_helpers/browser-paths.mjs tests/x.test.js; echo $? > '${EXIT}'`);
    assert.deepEqual(asked, ['/repo/x']);
  });

  it('a declaration without pr_tests_flags leaves the test script\'s flags', async () => {
    const { out, deps } = harness({ manifest: { scripts: { test: TEST_SCRIPT } }, tests: ['a.test.js'], finishAfter: 1, output: 'ℹ tests 1\nℹ fail 0\n' });
    const plain = deps.git;
    deps.git = (cwd, args) => (args.includes('--git-common-dir') ? '/repo/x/.git' : plain(cwd, args));
    deps.declaration = () => ({ ok: true, declaration: { select: 'node select.js' } });
    assert.equal(await run(['a.test.js'], deps), 0);
    assert.equal(out.spawned[0].args[1], `node --test --import ./tests/_isolate-home.mjs a.test.js; echo $? > '${EXIT}'`);
  });

  it('a missing file refuses before running', async () => {
    const { out, deps } = harness({ tests: ['a.test.js'] });
    assert.equal(await run(['a.test.js', 'missing.test.js'], deps), 2);
    assert.equal(out.stderr, 'mc: no such test file: missing.test.js\n');
    assert.deepEqual(out.spawned, []);
  });

  it('a red names a re-run line with the failing names, before the whole output', async () => {
    const { out, deps } = harness({ manifest: { scripts: { test: TEST_SCRIPT } }, tests: ['a.test.js'], finishAfter: 1, code: 1, output: '✖ adds up (2.1ms)\n  AssertionError [ERR_ASSERTION]: 1 == 2\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run(['a.test.js'], deps), 1);
    assert.match(out.stdout, /^re-run: mc gate a\.test\.js --test-name-pattern 'adds up'\nwhole output: /mu);
  });

  it('--test-name-pattern goes with files only, and reaches node', async () => {
    const { out, deps } = harness({ tests: ['a.test.js'], finishAfter: 1, output: 'ℹ tests 1\nℹ fail 0\n' });
    assert.equal(await run(['--test-name-pattern', 'adds up'], deps), 2);
    assert.match(out.stderr, /goes with test files/u);
    assert.deepEqual(out.spawned, []);

    const named = harness({ tests: ['a.test.js'], finishAfter: 1, output: 'ℹ tests 1\nℹ fail 0\n' });
    assert.equal(await run(['a.test.js', '--test-name-pattern', 'adds up'], named.deps), 0);
    assert.equal(named.out.spawned[0].args[1], `node --test a.test.js --test-name-pattern 'adds up'; echo $? > '${EXIT}'`);
  });
});

describe('mc gate, a green remembered for the merger (ruling 44)', () => {
  const SELECTION = { files: ['tests/b.test.js', 'tests/a.test.js'], commands: [{ id: 'lint', packageScript: 'lint', passBaseRef: true }] };
  const GREEN = 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n';
  const NEEDS_DOCKER = { files: ['tests/a.test.js'], commands: [{ id: 'pg', packageScript: 'sql:reference:postgres', needs: ['docker'] }] };

  /**
   * The harness of a worktree of `/repo/x` whose primary checkout declares a
   * selector. `porcelain` answers `git status --porcelain` before and after
   * the gate, `tree` answers `HEAD^{tree}` the same way.
   */
  function remembering({ select = 'node select.js', selection = SELECTION, porcelain = ['', ''], tree = ['tree1234abcd', 'tree1234abcd'], code = 0, output = GREEN } = {}) {
    const machine = harness({ finishAfter: 1, code, output });
    const asked = { selects: [], greens: [], ensures: [] };
    let status = 0;
    let trees = 0;
    const plain = machine.deps.git;
    machine.deps.env = { ...machine.deps.env, MC_HOME: '/home' };
    machine.deps.git = (cwd, args) => {
      if (args.includes('--git-common-dir')) return '/repo/x/.git';
      if (args[0] === 'status') return porcelain[Math.min(status++, porcelain.length - 1)];
      if (args[1] === 'HEAD^{tree}') return tree[Math.min(trees++, tree.length - 1)];
      if (args[0] === 'merge-base') return 'base5678';
      return plain(cwd, args);
    };
    machine.deps.declaration = (path) => ({ ok: true, name: 'x', declaration: { select, path } });
    machine.deps.select = (command, opts) => {
      asked.selects.push({ command, ...opts });
      return { status: 0, stdout: JSON.stringify(selection) };
    };
    machine.deps.recordGreen = (entry) => { asked.greens.push(entry); };
    machine.deps.holder = () => 'gate-memory';
    return { ...machine, asked };
  }

  it('a clean tree, a declared select, green: the tree, the selection hash and the version are recorded', async () => {
    const { out, deps, asked } = remembering();
    assert.equal(await run([], deps), 0);
    assert.deepEqual(asked.greens, [{
      repo: 'x', tree: 'tree1234abcd', selection: selectionHash(SELECTION), gate_version: GATE_MEASUREMENT_VERSION,
      at: '2026-09-25T10:00:02.000Z', session: 'gate-memory',
      head_tree: 'tree1234abcd', base: 'base5678', files: ['tests/a.test.js', 'tests/b.test.js'], commands: ['lint'],
    }]);
    assert.equal(GATE_MEASUREMENT_VERSION, 1);
    // Selected as the merger selects: the declared command, in the worktree,
    // with the primary checkout's selection state and no write.
    assert.equal(asked.selects[0].command, 'node select.js');
    assert.equal(asked.selects[0].cwd, '/w/x');
    assert.match(asked.selects[0].env.MC_SELECTION_STATE, /^\/home\/selection\/x-/u);
    assert.equal(asked.selects[0].env.MC_SELECTION_STATE_WRITE, undefined);
    assert.equal(out.spawned[0].opts.env.MC_SELECTION_STATE, asked.selects[0].env.MC_SELECTION_STATE);
    assert.match(out.stdout, /\nrecorded: tree tree123 green — mc merge does not measure it again while the tree and selection match\n$/u);
  });

  it('the hash is the selection, not the order it was printed in', () => {
    assert.equal(selectionHash(SELECTION), selectionHash({ ...SELECTION, files: [...SELECTION.files].reverse(), why: { other: true } }));
    assert.notEqual(selectionHash(SELECTION), selectionHash({ ...SELECTION, files: ['tests/a.test.js'] }));
    assert.notEqual(selectionHash(SELECTION), selectionHash({ files: SELECTION.files }));
  });

  it('a dirty tree, before or after, records nothing', async () => {
    const before = remembering({ porcelain: [' M src/a.js', ' M src/a.js'] });
    assert.equal(await run([], before.deps), 0);
    assert.deepEqual([before.asked.greens, before.asked.selects], [[], []]);
    assert.doesNotMatch(before.out.stdout, /recorded/u);

    const after = remembering({ porcelain: ['', '?? new.txt'] });
    assert.equal(await run([], after.deps), 0);
    assert.deepEqual(after.asked.greens, []);

    const moved = remembering({ tree: ['tree1234abcd', 'tree9999ffff'] });
    assert.equal(await run([], moved.deps), 0);
    assert.deepEqual(moved.asked.greens, []);
  });

  it('no select declared records nothing, and the gate runs as it did', async () => {
    const { out, deps, asked } = remembering({ select: null });
    assert.equal(await run([], deps), 0);
    assert.deepEqual([asked.greens, asked.selects], [[], []]);
    assert.equal(out.spawned[0].opts.env.MC_SELECTION_STATE, undefined);
  });

  it('a red records nothing; nor does another base, or named files', async () => {
    const red = remembering({ code: 1, output: '✖ a\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run([], red.deps), 1);
    assert.deepEqual(red.asked.greens, []);

    const base = remembering();
    assert.equal(await run(['--base', 'origin/dev'], base.deps), 0);
    assert.deepEqual(base.asked.greens, []);

    const named = remembering();
    named.files.set('/w/x/a.test.js', '');
    assert.equal(await run(['a.test.js'], named.deps), 0);
    assert.deepEqual(named.asked.greens, []);
  });

  it('a select that fails records nothing', async () => {
    const { deps, asked } = remembering();
    deps.select = () => ({ status: 1, stdout: '' });
    assert.equal(await run([], deps), 0);
    assert.deepEqual(asked.greens, []);
  });

  it('a selection with a command that needs docker ensures the runtime for the detached child', async () => {
    const { out, deps, asked } = remembering({ selection: NEEDS_DOCKER });
    deps.dockerEnsure = async (options) => { asked.ensures.push(options); return { ok: true, started: true, lease: '/l' }; };
    assert.equal(await run([], deps), 0);
    assert.equal(asked.ensures.length, 1);
    assert.equal(asked.ensures[0].pid, CHILD);
    assert.equal(asked.ensures[0].run, 'gate x');
    assert.equal(asked.ensures[0].repo, 'x');
    assert.equal(asked.ensures[0].root, '/home');
    assert.ok(out.spawned[0].args[1].startsWith('export MC_DOCKER_HOLDER=$$; npm test; echo $?'));
    assert.equal(out.spawned[0].opts.env.MC_DOCKER_RUN, 'gate x');
    assert.match(out.stderr, /docker: started for this gate \(lease for pid 4242\)/u);
  });

  it('a selection without docker ensures nothing and spawns as before', async () => {
    const { out, deps, asked } = remembering();
    deps.dockerEnsure = async () => { throw new Error('a gate without needs must not ensure'); };
    assert.equal(await run([], deps), 0);
    assert.deepEqual(asked.ensures, []);
    assert.deepEqual(out.spawned[0].args, ['-c', `npm test; echo $? > '${EXIT}'`]);
  });

  it('a runtime that cannot start is said and the gate still runs', async () => {
    const { out, deps } = remembering({ selection: NEEDS_DOCKER });
    deps.dockerEnsure = async () => ({ ok: false, reason: 'orbctl start failed: boom' });
    assert.equal(await run([], deps), 0);
    assert.equal(out.spawned.length, 1);
    assert.match(out.stderr, /mc: docker could not be started — orbctl start failed: boom; the gate runs on/u);
  });
});

describe('mc gate --wait', () => {
  it('prints the verdict of the running gate once it ends, and clears its lock', async () => {
    const { out, deps, files } = harness({ lock: { ...oldGate(111), log: LOG, started: '2026-09-25T09:58:00.000Z' }, live: [111], finishAfter: 2, code: 1, output: '✖ a (1ms)\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run(['--wait'], deps), 1);
    assert.equal(out.stdout, `RED — npm test — 1 tests, 1 failed — 124s\n✖ a\nwhole output: ${LOG}\n`);
    assert.equal(out.spawned.length, 0);
    assert.equal(files.has(LOCK), false);
  });

  it('with no gate running here it says so and exits 2', async () => {
    const { out, deps } = harness();
    assert.equal(await run(['--wait'], deps), 2);
    assert.equal(out.stderr, 'mc: no gate running here — mc gate starts one\n');
  });

  it('a gate whose process is gone without an exit code is red, and its lock goes', async () => {
    const { out, deps, files } = harness({ lock: { ...oldGate(111), log: LOG }, live: [] });
    assert.equal(await run(['--wait'], deps), 1);
    assert.equal(out.stdout, `RED — the gate's process ended without an exit code — log: ${LOG}\n`);
    assert.equal(files.has(LOCK), false);
  });

  it('past the budget it prints RUNNING again and exits 3, the lock stays', async () => {
    const { out, deps, files } = harness({ lock: { ...oldGate(111), log: LOG }, live: [111] });
    assert.equal(await run(['--wait', '--budget', '4'], deps), 3);
    assert.equal(out.stdout, `RUNNING — npm test — 604s so far, still running (pid 111)\nlog: ${LOG} — mc gate --wait waits for it and prints the verdict\n`);
    assert.equal(files.has(LOCK), true);
  });
});

describe('mc gate, the fast paths (gate-fast.js)', () => {
  const MB = 'mb00000000000000000000000000000000000000';
  const LAST = '/w/x/.git/mc-gate-last.json';

  /** A worktree whose change against origin/main is `diff`, standing at `tree`. */
  function fastHarness({ diff = ['src/a.js'], tree = 'tree-now', last = null, finishAfter = 1, code = 0, output = 'ℹ tests 1\nℹ fail 0\n', selection = { files: [], commands: [] } } = {}) {
    const machine = harness({ finishAfter, code, output, tests: ['tests/mc/a.test.js', 'tests/mc/b.test.js'] });
    const plain = machine.deps.git;
    const asked = { greens: [], selects: [] };
    if (last) machine.files.set(LAST, JSON.stringify(last));
    machine.deps.git = (cwd, args) => {
      if (args[0] === 'merge-base') return MB;
      if (args[0] === 'ls-files') return '';
      if (args[0] === 'diff') return args.length === 5 ? diff.join('\0') : 'src/b.js';
      if (args.includes('--git-common-dir')) return '/repo/x/.git';
      if (args[0] === 'status') return ' M src/a.js';
      return plain(cwd, args);
    };
    machine.deps.snapshotTree = () => tree;
    machine.deps.declaration = () => ({ ok: true, declaration: { select: 'node select.js' } });
    machine.deps.select = (command) => { asked.selects.push(command); return { status: 0, stdout: JSON.stringify(selection) }; };
    machine.deps.recordGreen = (entry) => { asked.greens.push(entry); };
    return { ...machine, asked };
  }

  it('docs only answers at once: no child, no lock, exit 0', async () => {
    const { out, deps, files } = fastHarness({ diff: ['docs/technical/mc-merge.md'] });
    assert.equal(await run([], deps), 0);
    assert.match(out.stdout, /^GREEN — docs only, nothing to run — 0s\n/u);
    assert.deepEqual(out.spawned, []);
    assert.equal(files.has(LOCK), false);
  });

  it('the whole gate runs fail-fast and writes what it measured beside the lock', async () => {
    const { out, deps, files } = fastHarness({ code: 1, output: '✖ x\ntest at tests/mc/a.test.js:3:1\n✖ x (1ms)\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run([], deps), 1);
    assert.equal(out.spawned[0].opts.env.MC_GATE_FAIL_FAST, '1');
    assert.deepEqual(JSON.parse(files.get(LAST)), {
      tree: 'tree-now', base: MB, ref: 'origin/main', exit: 1, red: ['tests/mc/a.test.js'], red_commands: [], at: '2026-09-25T10:00:00.000Z', log: LOG,
    });
  });

  it('after a red, INCREMENTAL runs the red files and the selection, records no green and is not fail-fast', async () => {
    const last = { tree: 'tree-red', base: MB, ref: 'origin/main', exit: 1, red: ['tests/mc/a.test.js'], red_commands: [], at: '2026-09-25T09:00:00.000Z', log: OLD_LOG };
    const { out, deps, files, asked } = fastHarness({ last, selection: { files: ['tests/mc/b.test.js'], commands: [] } });
    assert.equal(await run([], deps), 0);
    assert.deepEqual(asked.selects, ['node select.js --changed-path src/b.js']);
    assert.equal(out.spawned[0].args[1], `node --test tests/mc/a.test.js tests/mc/b.test.js; echo $? > '${EXIT}'`);
    assert.equal(out.spawned[0].opts.env.MC_GATE_FAIL_FAST, undefined);
    assert.match(out.stdout, /^GREEN INCREMENTAL — 1 red file from the gate at 2026-09-25T09:00:00\.000Z \+ 1 selected for 1 path changed since; not the whole gate \(mc gate --full\) — node --test 2 files — 1 tests, 0 failed — 2s\n/u);
    assert.deepEqual(asked.greens, []);
    // The last whole gate is still the one an incremental run is measured from.
    assert.deepEqual(JSON.parse(files.get(LAST)), last);
  });

  it('--full runs the whole gate after a red, and with files it is refused', async () => {
    const last = { tree: 'tree-red', base: MB, ref: 'origin/main', exit: 1, red: ['tests/mc/a.test.js'], at: 'x', log: OLD_LOG };
    const { out, deps } = fastHarness({ last, diff: ['docs/a.md'] });
    assert.equal(await run(['--full'], deps), 0);
    assert.equal(out.spawned[0].args[1], `npm test; echo $? > '${EXIT}'`);

    const named = fastHarness();
    assert.equal(await run(['tests/mc/a.test.js', '--full'], named.deps), 2);
    assert.match(named.out.stderr, /--full is the whole gate/u);
  });

  it('a tree the last whole gate measured green answers GREEN (unchanged since …) with no child', async () => {
    const { out, deps } = fastHarness({ last: { tree: 'tree-now', base: MB, ref: 'origin/main', exit: 0, red: [], at: '2026-09-25T09:00:00.000Z', log: OLD_LOG } });
    assert.equal(await run([], deps), 0);
    assert.equal(out.stdout, `GREEN (unchanged since 2026-09-25T09:00:00.000Z) — the whole gate measured this tree green against origin/main; nothing to run — log: ${OLD_LOG}\n`);
    assert.deepEqual(out.spawned, []);
  });
});

/**
 * `mc gate` — the verb: named test files, or the ones the branch changed, in
 * the gate lane, a detached run, a budget, one gate per worktree. No whole gate.
 *
 * Everything the verb touches is injected: the spawn, the clock, the sleep,
 * the files and the pid liveness. Nothing here starts a process or reads disk.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/gate.js';

const CHILD = 4242;
const LOG = '/scratch/gate-20260925T100000Z-test.log';
const EXIT = `${LOG}.exit`;
const LOCK = '/w/x/.git/mc-gate.json';
const OLD_LOG = '/scratch/gate-20260925T095000Z.log';
const TEST_SCRIPT = 'node --test --import ./tests/_isolate-home.mjs \'tests/**/*.test.js\'';

/**
 * A fake machine. The gate finishes after `finishAfter` sleeps: it writes its
 * log and exit code then, and is no longer alive. `changed` is what the branch
 * changes against origin/main, `tests` the files that exist.
 */
function harness({ lock = null, manifest = { scripts: { test: 'node --test' } }, live = [], finishAfter = Infinity, code = 0, output = '', tests = [], changed = [], lane = 'heavy', log = null } = {}) {
  const files = new Map();
  const alive = new Set(live);
  const out = { stdout: '', stderr: '', spawned: [], dirs: [], removed: [], ticks: 0, unref: false };
  let clock = Date.parse('2026-09-25T10:00:00Z');
  if (lock) files.set(LOCK, JSON.stringify(lock));
  if (log != null) files.set(lock?.log || LOG, log);
  for (const test of tests) files.set(`/w/x/${test}`, '');
  const deps = {
    stdout: { write: (s) => { out.stdout += s; } },
    stderr: { write: (s) => { out.stderr += s; } },
    cwd: '/w/x',
    env: { MC_SCRATCH: '/scratch' },
    now: () => new Date(clock),
    id: () => 'test',
    claim: () => ({ ok: true, marker: 'fixture' }),
    release: () => true,
    snapshot: () => ({ repository: '/repo/memoro/.git', tree: 'tree', fingerprint: 'bytes' }),
    git: (cwd, args) => {
      if (args[0] === 'merge-base') return 'mb0000';
      if (args[0] === 'diff') return changed.join('\0');
      if (args[0] === 'ls-files') return '';
      if (args.includes('--git-common-dir')) return '/repo/memoro/.git';
      return ({ '--show-toplevel': '/w/x', '--absolute-git-dir': '/w/x/.git' })[args[1]] ?? null;
    },
    read: (path) => {
      if (path === '/w/x/package.json' && manifest) return JSON.stringify(manifest);
      if (files.has(path)) return files.get(path);
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    },
    exists: (path) => files.has(path),
    isFile: (path) => files.has(path),
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
    declaration: () => ({ ok: true, declaration: { select: 'node select.js --base-ref origin/main' } }),
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

const oldGate = (pid, extra = {}) => ({ pid, log: OLD_LOG, started: '2026-09-25T09:50:00.000Z', command: { run: 'node --test a.test.js', script: 'node --test', files: ['a.test.js'] }, ...extra });
const GREEN = 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n';

describe('mc gate <test files…>', () => {
  it('runs the named files at once, prints the verdict and clears the lock', async () => {
    const { out, deps, files } = harness({ manifest: { scripts: { test: TEST_SCRIPT } }, tests: ['a.test.js'], finishAfter: 3, output: `✔ a (1ms)\n${GREEN}` });
    assert.equal(await run(['a.test.js'], deps), 0);
    assert.equal(out.spawned[0].file, process.execPath);
    assert.match(out.spawned[0].args[0], /session-gate-run\.js$/u);
    assert.equal(out.spawned[0].args[1], `${LOG}.request.json`);
    const asked = JSON.parse(files.get(`${LOG}.request.json`));
    assert.equal(asked.gate.repo, 'memoro', 'a worktree of memoro is memoro');
    assert.equal(asked.defer, false, 'named files are what was asked for');
    assert.deepEqual([out.spawned[0].opts.cwd, out.spawned[0].opts.detached, out.spawned[0].opts.stdio], ['/w/x', true, ['ignore', 9, 9]]);
    assert.deepEqual([out.spawned[0].opts.env.CI, out.spawned[0].opts.env.FORCE_COLOR, out.spawned[0].opts.env.NO_COLOR], ['1', '0', '1']);
    assert.equal(out.spawned[0].opts.env.MC_GATE_FAIL_FAST, undefined);
    assert.equal(out.unref, true);
    assert.deepEqual(out.dirs, ['/scratch']);
    assert.equal(files.get(`${LOG}.pid`), `${CHILD}\n`);
    assert.equal(out.stdout, `GREEN — node --test --import ./tests/_isolate-home.mjs a.test.js — 1 tests, 0 failed — 6s\nwhole output: ${LOG}\n`);
    assert.equal(files.has(LOCK), false);
    assert.deepEqual(out.removed, [LOCK]);
  });

  it('an unnamed gate may leave costly files to the merge round; a goal\'s measurement may not', async () => {
    const plain = harness({ changed: ['implementation.js'], finishAfter: 1, output: GREEN });
    assert.equal(await run([], plain.deps), 0);
    assert.equal(JSON.parse(plain.files.get(`${LOG}.request.json`)).defer, true);
    const whole = harness({ changed: ['implementation.js'], finishAfter: 1, output: GREEN });
    whole.deps.wholeSelection = true;
    assert.equal(await run([], whole.deps), 0);
    assert.equal(JSON.parse(whole.files.get(`${LOG}.request.json`)).defer, false);
  });

  it('a repository that declares session_whole leaves nothing to the merge round', async () => {
    const out = harness({ changed: ['implementation.js'], finishAfter: 1, output: GREEN });
    const declaration = out.deps.declaration;
    out.deps.declaration = (...args) => { const declared = declaration(...args); return { ...declared, declaration: { ...declared.declaration, session_whole: true } }; };
    assert.equal(await run([], out.deps), 0);
    assert.equal(JSON.parse(out.files.get(`${LOG}.request.json`)).defer, false);
  });

  it('a green that left files to the merge round says so', async () => {
    const { out, deps, files } = harness({ tests: ['a.test.js'], finishAfter: 1, output: GREEN });
    files.set(`${LOG}.request.json.result`, JSON.stringify({ deferred: ['b.test.js', 'c.test.js'] }));
    deps.write = ((write) => (path, text) => { if (path !== `${LOG}.request.json`) write(path, text); else files.set(path, text); })(deps.write);
    assert.equal(await run(['a.test.js'], deps), 0);
    assert.match(out.stdout, /2 costly test files left to the merge round/u);
  });

  it('named files run with the declared pr_tests_flags, which replace the test script\'s', async () => {
    const { out, deps, files } = harness({ manifest: { scripts: { test: 'node scripts/testing/ci.mjs' } }, tests: ['tests/x.test.js'], finishAfter: 1, output: GREEN });
    const asked = [];
    deps.declaration = (path) => { asked.push(path); return { ok: true, declaration: { pr_tests_flags: ['--import', './tests/_helpers/browser-paths.mjs'] } }; };
    assert.equal(await run(['tests/x.test.js'], deps), 0);
    assert.equal(out.spawned[0].args[1], `${LOG}.request.json`);
    assert.deepEqual(JSON.parse(files.get(`${LOG}.request.json`)).flags, ['--import', './tests/_helpers/browser-paths.mjs']);
    assert.deepEqual(asked, ['/repo/memoro', '/repo/memoro']);
  });

  it('the child is told the lanes to use, unless its environment already names them', async () => {
    const { out, deps } = harness({ tests: ['a.test.js'], finishAfter: 1, output: GREEN });
    assert.equal(await run(['a.test.js'], deps), 0);
    assert.match(out.spawned[0].opts.env.MC_TEST_LANES, /^[1-9]\d*$/u);
  });

  it('past the budget it prints RUNNING with the log and exits 3, and the lock stays', async () => {
    const { out, deps, files } = harness({ tests: ['a.test.js'] });
    assert.equal(await run(['a.test.js', '--budget', '10'], deps), 3);
    assert.equal(out.stdout, `RUNNING — node --test a.test.js — 10s so far, still running (pid ${CHILD})\nlog: ${LOG} — mc gate --wait waits for it and prints the verdict\n`);
    assert.equal(files.has(LOCK), true);
    assert.deepEqual(out.removed, []);
  });

  it('a red names a re-run line with the failing names, before the whole output', async () => {
    const { out, deps } = harness({ manifest: { scripts: { test: TEST_SCRIPT } }, tests: ['a.test.js'], finishAfter: 1, code: 1, output: '✖ adds up (2.1ms)\n  AssertionError [ERR_ASSERTION]: 1 == 2\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run(['a.test.js'], deps), 1);
    assert.match(out.stdout, /^re-run: mc gate a\.test\.js --test-name-pattern 'adds up'\nwhole output: /mu);
  });

  it('--test-name-pattern reaches node, and goes with named files only', async () => {
    const named = harness({ manifest: { scripts: { test: TEST_SCRIPT } }, tests: ['a.test.js'], finishAfter: 1, output: GREEN });
    assert.equal(await run(['a.test.js', '--test-name-pattern', 'adds up'], named.deps), 0);
    assert.equal(JSON.parse(named.files.get(`${LOG}.request.json`)).pattern, 'adds up');
    assert.deepEqual(JSON.parse(named.files.get(`${LOG}.request.json`)).flags, ['--import', './tests/_isolate-home.mjs']);

    const bare = harness({ changed: ['tests/a.test.js'], tests: ['tests/a.test.js'] });
    assert.equal(await run(['--test-name-pattern', 'adds up'], bare.deps), 2);
    assert.match(bare.out.stderr, /goes with named test files/u);
    assert.deepEqual(bare.out.spawned, []);
  });

  it('--json is the object', async () => {
    const json = harness({ tests: ['a.test.js'], finishAfter: 1, code: 1, output: '✖ a\n' });
    assert.equal(await run(['a.test.js', '--json'], json.deps), 1);
    const parsed = JSON.parse(json.out.stdout);
    assert.deepEqual([parsed.ok, parsed.failures, parsed.command, parsed.files, parsed.exit, parsed.seconds], [false, ['✖ a'], 'node --test a.test.js', ['a.test.js'], 1, 2]);
  });
});

describe('mc gate, with no files named', () => {
  it('selects from production changes, even when no test was edited', async () => {
    const { out, deps, files } = harness({ changed: ['src/a.js', 'src/old.js', 'src/new.js'], finishAfter: 1, output: GREEN });
    assert.equal(await run([], deps), 0);
    const request = JSON.parse(files.get(`${LOG}.request.json`));
    assert.equal(request.files, null);
    assert.equal(request.select, "node select.js --base-ref 'origin/main' --changed-path 'src/a.js' --changed-path 'src/new.js' --changed-path 'src/old.js'");
    assert.match(out.stdout, /GREEN/u);
  });

  it('an unchanged worktree says nothing changed, without claiming tests passed', async () => {
    const { out, deps } = harness();
    assert.equal(await run([], deps), 0);
    assert.equal(out.stdout, 'NOTHING CHANGED — no changes against origin/main\n');
    assert.deepEqual(out.spawned, []);
  });

  it('a missing selector refuses instead of claiming an untested source change passed', async () => {
    const { out, deps } = harness({ changed: ['src/a.js'] });
    deps.declaration = () => ({ ok: true, declaration: {} });
    assert.equal(await run([], deps), 2);
    assert.match(out.stderr, /no repository test selector/u);
    assert.deepEqual(out.spawned, []);
  });

  it('--base reaches the selector and takes no named files', async () => {
    const { deps, files } = harness({ changed: ['src/a.js'], finishAfter: 1, output: GREEN });
    assert.equal(await run(['--base', 'origin/dev'], deps), 0);
    assert.match(JSON.parse(files.get(`${LOG}.request.json`)).select, /--base-ref 'origin\/dev'/u);
    const named = harness({ tests: ['a.test.js'] });
    assert.equal(await run(['a.test.js', '--base', 'origin/dev'], named.deps), 2);
  });
});

describe('mc gate runs no suite', () => {
  it('--full is refused: the whole measurement is the merger\'s', async () => {
    for (const argv of [['--full'], ['a.test.js', '--full']]) {
      const { out, deps } = harness({ tests: ['a.test.js'] });
      assert.equal(await run(argv, deps), 2);
      assert.match(out.stderr, /there is no whole gate in a worktree — the merger measures the pull request once/u);
      assert.deepEqual(out.spawned, []);
    }
  });

  it('a project with more than thirty tests runs in the bounded worker', async () => {
    const many = Array.from({ length: 45 }, (_, i) => `tests/t${i}.test.js`);
    const { out, deps, files } = harness({ tests: many, finishAfter: 1, output: GREEN });
    assert.equal(await run(many, deps), 0);
    assert.deepEqual(JSON.parse(files.get(`${LOG}.request.json`)).files, many);
    assert.match(out.spawned[0].args[0], /session-gate-run/u);
  });

  it('a directory or a file that is not a test is refused', async () => {
    const dir = harness({ tests: ['tests/a.test.js'] });
    dir.files.set('/w/x/tests', '');
    dir.deps.isFile = (path) => path !== '/w/x/tests';
    assert.equal(await run(['tests'], dir.deps), 2);
    assert.match(dir.out.stderr, /tests is not a test file/u);
    const helper = harness({ tests: ['tests/_helpers/x.mjs'] });
    assert.equal(await run(['tests/_helpers/x.mjs'], helper.deps), 2);
    assert.deepEqual(helper.out.spawned, []);
  });

  it('a missing file refuses before running', async () => {
    const { out, deps } = harness({ tests: ['a.test.js'] });
    assert.equal(await run(['a.test.js', 'missing.test.js'], deps), 2);
    assert.equal(out.stderr, 'mc: no such test file: missing.test.js\n');
    assert.deepEqual(out.spawned, []);
  });
});

describe('mc gate, one per worktree', () => {
  it('a second gate while one is alive refuses with exit 2', async () => {
    const { out, deps } = harness({ lock: oldGate(111), live: [111], tests: ['a.test.js'] });
    assert.equal(await run(['a.test.js'], deps), 2);
    assert.equal(out.stderr, 'mc: a gate is already running here (pid 111, since 2026-09-25T09:50:00.000Z) — mc gate --wait\n');
    assert.deepEqual(out.spawned, []);
  });

  it('a stale lock is taken over: a dead pid, or a gate whose exit file exists', async () => {
    const dead = harness({ lock: oldGate(111), live: [], tests: ['a.test.js'], finishAfter: 1, output: 'ℹ tests 2\nℹ pass 2\nℹ fail 0\n' });
    assert.equal(await run(['a.test.js'], dead.deps), 0);
    assert.equal(dead.out.spawned.length, 1);

    const exited = harness({ lock: oldGate(111), live: [111], tests: ['a.test.js'], finishAfter: 1, output: GREEN });
    exited.files.set(`${OLD_LOG}.exit`, '0\n');
    assert.equal(await run(['a.test.js'], exited.deps), 0);
    assert.equal(exited.out.spawned.length, 1);
  });

  it('is 2 outside a worktree, and on a budget that is not seconds', async () => {
    const outside = harness({ tests: ['a.test.js'] });
    outside.deps.git = () => null;
    assert.equal(await run(['a.test.js'], outside.deps), 2);
    const budget = harness({ tests: ['a.test.js'] });
    assert.equal(await run(['a.test.js', '--budget', '0'], budget.deps), 2);
    assert.match(budget.out.stderr, /--budget takes seconds/u);
    assert.deepEqual(budget.out.spawned, []);
  });
});

describe('mc gate --wait', () => {
  it('prints the verdict of the running gate once it ends, and clears its lock', async () => {
    const { out, deps, files } = harness({ lock: { ...oldGate(111), log: LOG, started: '2026-09-25T09:58:00.000Z' }, live: [111], finishAfter: 2, code: 1, output: '✖ a (1ms)\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run(['--wait'], deps), 1);
    assert.equal(out.stdout, `RED — node --test a.test.js — 1 tests, 1 failed — 124s\n✖ a\nre-run: mc gate a.test.js --test-name-pattern 'a'\nwhole output: ${LOG}\n`);
    assert.equal(out.spawned.length, 0);
    assert.equal(files.has(LOCK), false);
  });

  it('with no gate running here it says so and exits 2', async () => {
    const { out, deps } = harness();
    assert.equal(await run(['--wait'], deps), 2);
    assert.equal(out.stderr, 'mc: no gate running here — mc gate <files…> starts one\n');
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
    assert.equal(out.stdout, `RUNNING — node --test a.test.js — 604s so far, still running (pid 111)\nlog: ${LOG} — mc gate --wait waits for it and prints the verdict\n`);
    assert.equal(files.has(LOCK), true);
  });
});

it('freezes the base and launch content for the worker; filtered requests remain explicitly named', async () => {
  const h = harness({ tests: ['a.test.js'], finishAfter: 1, output: GREEN });
  const original = h.deps.git;
  const base = 'a'.repeat(40);
  h.deps.git = (cwd, args) => args[0] === 'rev-parse' && args[1] === 'origin/main^{commit}' ? base : original(cwd, args);
  assert.equal(await run(['a.test.js', '--test-name-pattern', 'one'], h.deps), 0);
  const request = JSON.parse(h.files.get(`${LOG}.request.json`));
  assert.equal(request.base, base);
  assert.equal(request.measurement.base, base);
  assert.equal(request.measurement.run, 'test');
  assert.equal(request.measurement.repo, 'memoro');
  assert.equal(request.measurement.session_run, null);
  assert.equal(request.measurement.goal_revision, null);
  assert.match(request.measurement.configuration, /^[0-9a-f]{64}$/u);
  assert.equal(request.measurement.candidate.tree, 'tree');
  assert.deepEqual(request.files, ['a.test.js']);
  assert.equal(request.pattern, 'one');
  assert.match(request.select, new RegExp(base, 'u'));
});

it('autonomous finish binds the existing affected gate worker to its reserved session and goal revision', async () => {
  const h = harness({ changed: ['implementation.js'], finishAfter: 1, output: GREEN });
  const original = h.deps.git;
  const base = 'a'.repeat(40);
  h.deps.git = (cwd, args) => args[0] === 'rev-parse' && args[1] === 'origin/main^{commit}' ? base : original(cwd, args);
  h.deps.measurementBinding = { session_run: 'build-1', goal_revision: 3 };
  assert.equal(await run(['--json'], h.deps), 0);
  const request = JSON.parse(h.files.get(`${LOG}.request.json`));
  assert.equal(request.files, null);
  assert.equal(request.pattern, null);
  assert.match(request.select, /--changed-path 'implementation.js'/u);
  assert.equal(request.measurement.session_run, 'build-1');
  assert.equal(request.measurement.goal_revision, 3);
  assert.equal(request.defer, false, 'a goal is measured whole');
});

it('concurrent callers launch only one worker, and repeated waits never launch another', async () => {
  const h = harness({ tests: ['a.test.js'] });
  const codes = await Promise.all([
    run(['a.test.js', '--budget', '1'], h.deps),
    run(['a.test.js', '--budget', '1'], h.deps),
  ]);
  assert.deepEqual(codes, [3, 2]);
  assert.equal(h.out.spawned.length, 1);
  assert.equal(await run(['--wait', '--budget', '1'], h.deps), 3);
  assert.equal(h.files.has(LOCK), true);
  h.files.set(LOG, GREEN);
  h.files.set(`${LOG}.request.json.result`, JSON.stringify({ files: ['a.test.js'], evidence: { path: '/state/gate-evidence/test.json', outcome: 'green' } }));
  h.files.set(EXIT, '0\n');
  h.out.stdout = '';
  assert.equal(await run(['--wait', '--json'], h.deps), 0);
  assert.deepEqual(JSON.parse(h.out.stdout).evidence, { path: '/state/gate-evidence/test.json', outcome: 'green' });
  assert.equal(h.files.has(LOCK), false);
  assert.equal(await run(['--wait'], h.deps), 2);
  assert.equal(h.out.spawned.length, 1);
});

it('a waiter cannot remove a successor lock when the old worker finishes', async () => {
  const h = harness({ lock: { ...oldGate(111), log: LOG }, live: [111] });
  h.deps.sleep = async () => {
    h.files.set(LOG, GREEN);
    h.files.set(EXIT, '0\n');
    h.files.set(LOCK, JSON.stringify(oldGate(222)));
  };
  assert.equal(await run(['--wait'], h.deps), 0);
  assert.equal(JSON.parse(h.files.get(LOCK)).pid, 222);
  assert.deepEqual(h.out.removed, []);
});

it('a crash after a receipt result but before the exit marker is still a red command', async () => {
  const h = harness({ lock: { ...oldGate(111), log: LOG, request: `${LOG}.request.json` }, log: GREEN });
  h.files.set(`${LOG}.request.json.result`, JSON.stringify({ ok: true, code: 0, evidence: { outcome: 'green' } }));
  assert.equal(await run(['--wait'], h.deps), 1);
  assert.match(h.out.stdout, /ended without an exit code/u);
  assert.doesNotMatch(h.out.stdout, /GREEN/u);
});

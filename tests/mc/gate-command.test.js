/**
 * `mc gate` — the verb: named test files, or the ones the branch changed, in
 * the gate lane, a detached run, a budget, one gate per worktree. No whole gate.
 *
 * Everything the verb touches is injected: the spawn, the clock, the sleep,
 * the files and the pid liveness. Nothing here starts a process; only the
 * timeout-policy cases read disk — real declaration files in a throwaway directory.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/gate.js';
import { gateConfiguration } from '../../src/mc/gate-greens.js';
import { executionIdentity, resolveTestPlan, TEST_TIMEOUT_MS } from '../../src/mc/repo-gate.js';
import { declarationFor } from '../../src/mc/repo-gate-table.js';

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
function harness({ lock = null, manifest = { scripts: { test: 'node --test' } }, live = [], finishAfter = Infinity, code = 0, output = '', tests = [], changed = [], lane = 'heavy', log = null, result = null } = {}) {
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
        if (result) files.set(`${LOG}.request.json.result`, JSON.stringify(result));
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

  it('--whole-selection is a public bare-gate option and retains the selector request', async () => {
    const whole = harness({ changed: ['implementation.js'], finishAfter: 1, output: GREEN });
    assert.equal(await run(['--whole-selection'], whole.deps), 0);
    const request = JSON.parse(whole.files.get(`${LOG}.request.json`));
    assert.equal(request.files, null);
    assert.equal(request.defer, false);
    assert.match(request.select, /--changed-path 'implementation\.js'/u);
  });

  it('--whole-selection refuses named files, patterns and wait observers before starting', async () => {
    for (const [args, explanation] of [
      [['--whole-selection', 'a.test.js'], /takes no named files/u],
      [['--whole-selection', '--test-name-pattern', 'one'], /cannot be combined with --test-name-pattern/u],
      [['--whole-selection', '--wait'], /--wait only observes the already-started request/u],
    ]) {
      const h = harness({ tests: ['a.test.js'] });
      assert.equal(await run(args, h.deps), 2);
      assert.match(h.out.stderr, explanation);
      assert.deepEqual(h.out.spawned, []);
    }
  });

  it('a repository that declares session_whole leaves nothing to the merge round', async () => {
    const out = harness({ changed: ['implementation.js'], finishAfter: 1, output: GREEN });
    const declaration = out.deps.declaration;
    out.deps.declaration = (...args) => { const declared = declaration(...args); return { ...declared, declaration: { ...declared.declaration, session_whole: true } }; };
    assert.equal(await run([], out.deps), 0);
    assert.equal(JSON.parse(out.files.get(`${LOG}.request.json`)).defer, false);
  });

  it('text names the exact deferred files as unmeasured and not run by direct goal landing', async () => {
    const { out, deps, files } = harness({ tests: ['a.test.js'], finishAfter: 1, output: GREEN });
    files.set(`${LOG}.request.json.result`, JSON.stringify({ deferred: ['tests/b.test.js', 'tests/c.test.js'] }));
    deps.write = ((write) => (path, text) => { if (path !== `${LOG}.request.json`) write(path, text); else files.set(path, text); })(deps.write);
    assert.equal(await run(['a.test.js'], deps), 0);
    assert.match(out.stdout, /PARTIAL COVERAGE — deferred files were not measured; direct goal landing does not run them: tests\/b\.test\.js tests\/c\.test\.js/u);
  });

  it('--json keeps partial coverage and deferred members when there is no reusable receipt', async () => {
    const h = harness({ changed: ['implementation.js'], finishAfter: 1, output: GREEN,
      result: { deferred: ['tests/costly.test.js'], coverage: { kind: 'partial', files: ['tests/changed.test.js'], commands: [{ packageScript: 'lint:selected' }], pattern: null } } });
    assert.equal(await run(['--json'], h.deps), 0);
    const result = JSON.parse(h.out.stdout);
    assert.deepEqual(result.deferred, ['tests/costly.test.js']);
    assert.deepEqual(result.coverage, { kind: 'partial', files: ['tests/changed.test.js'], commands: [{ packageScript: 'lint:selected' }], pattern: null });
    assert.equal(result.evidence, undefined);
  });

  it('a green gate with a test over 1 s stays GREEN, exit 0, and names that test as slow; the 0.2 s test is not named', async () => {
    const slow_tests = [{ file: 'tests/a.test.js', name: 'slow one', seconds: 1.4 }, { file: 'tests/a.test.js', name: 'quick one', seconds: 0.2 }];
    const h = harness({ tests: ['tests/a.test.js'], finishAfter: 1, output: GREEN, code: 0, result: { ok: true, code: 0, slow_tests } });
    assert.equal(await run(['tests/a.test.js'], h.deps), 0);
    assert.match(h.out.stdout, /^GREEN — .* — 1 tests, 0 failed — \d+s\n/u);
    assert.equal(h.out.stdout.split('\n').slice(1).join('\n'),
      '1 test over the 1 s slow-test indicator — not red; rebuild a new or changed one, or say in the PR why its cost is warranted:\n'
      + `slow tests/a.test.js › slow one — 1.400 s\nwhole output: ${LOG}\n`);
    const json = harness({ tests: ['tests/a.test.js'], finishAfter: 1, output: GREEN, code: 0, result: { ok: true, code: 0, slow_tests: slow_tests.slice(0, 1) } });
    assert.equal(await run(['tests/a.test.js', '--json'], json.deps), 0);
    assert.deepEqual(JSON.parse(json.out.stdout).slow_tests, slow_tests.slice(0, 1));
  });

  it('a green gate with no test over 1 s prints no slow line', async () => {
    const h = harness({ tests: ['tests/a.test.js'], finishAfter: 1, output: GREEN, code: 0, result: { ok: true, code: 0, slow_tests: [] } });
    assert.equal(await run(['tests/a.test.js'], h.deps), 0);
    assert.doesNotMatch(h.out.stdout, /slow/u);
  });

  it('a test cut at the stall guard is red and its line names the guard and the limit', async () => {
    const red_tests = [{ file: 'tests/a.test.js', name: 'hangs', error: ['test timed out after 30000ms'] }];
    const h = harness({ tests: ['tests/a.test.js'], finishAfter: 1, output: 'ℹ tests 1\nℹ pass 0\nℹ fail 1\n', code: 1, result: { ok: false, code: 1, red_tests } });
    assert.equal(await run(['tests/a.test.js'], h.deps), 1);
    assert.match(h.out.stdout, /^RED —/u);
    assert.match(h.out.stdout, /✖ hangs — reached the 30 s stall guard\n {4}test timed out after 30000ms/u);
  });

  it('reports declared unavailable execution as incomplete without changing the permitted zero exit', async () => {
    const unavailable = [{ id: 'db:postgres', packageScript: 'sql:pr-ci', command: "npm run 'sql:pr-ci'", exit: 69 }];
    const human = harness({ tests: ['a.test.js'], finishAfter: 1, output: GREEN,
      result: { code: 0, ok: false, process_ok: true, complete: false, verdict: 'incomplete', unavailable_commands: unavailable } });
    assert.equal(await run(['a.test.js'], human.deps), 0);
    assert.match(human.out.stdout, /^INCOMPLETE —/u);
    assert.match(human.out.stdout, /unavailable: db:postgres — npm run 'sql:pr-ci' — exit 69/u);
    assert.doesNotMatch(human.out.stdout, /GREEN/u);

    const json = harness({ tests: ['a.test.js'], finishAfter: 1, output: GREEN,
      result: { code: 0, ok: false, process_ok: true, complete: false, verdict: 'incomplete', unavailable_commands: unavailable,
        commands: [{ id: 'db:postgres', packageScript: 'sql:pr-ci', command: "npm run 'sql:pr-ci'", exit: 69, ok: false, state: 'unavailable', unavailable: true }] } });
    assert.equal(await run(['a.test.js', '--json'], json.deps), 0);
    const parsed = JSON.parse(json.out.stdout);
    assert.deepEqual([parsed.ok, parsed.process_ok, parsed.complete, parsed.verdict, parsed.exit], [false, true, false, 'incomplete', 0]);
    assert.deepEqual(parsed.unavailable_commands, unavailable);
    assert.deepEqual(parsed.commands[0], { id: 'db:postgres', packageScript: 'sql:pr-ci', command: "npm run 'sql:pr-ci'", exit: 69,
      ok: false, state: 'unavailable', unavailable: true });
  });

  it('does not infer unavailable state from stderr-like log wording', async () => {
    const h = harness({ tests: ['a.test.js'], finishAfter: 1, output: `unavailable on this machine\n${GREEN}` });
    assert.equal(await run(['a.test.js'], h.deps), 0);
    assert.match(h.out.stdout, /^GREEN —/u);
    assert.doesNotMatch(h.out.stdout, /INCOMPLETE|unavailable:/u);
  });

  it('named files run with the declared pr_tests_flags, which replace the test script\'s', async () => {
    const { out, deps, files } = harness({ manifest: { scripts: { test: 'node scripts/testing/ci.mjs' } }, tests: ['tests/x.test.js'], finishAfter: 1, output: GREEN });
    const asked = [];
    deps.declaration = (path, options) => { asked.push([path, options.contentDir]); return { ok: true, declaration: { pr_tests_flags: ['--import', './tests/_helpers/browser-paths.mjs'] } }; };
    assert.equal(await run(['tests/x.test.js'], deps), 0);
    assert.equal(out.spawned[0].args[1], `${LOG}.request.json`);
    assert.deepEqual(JSON.parse(files.get(`${LOG}.request.json`)).flags, ['--import', './tests/_helpers/browser-paths.mjs']);
    assert.deepEqual(asked, [['/repo/memoro', '/w/x']], 'named by the repository, read from the worktree, once');
  });

  /**
   * The verb on real declaration files: the worktree of a bare `memoro.git`,
   * its own `.mc/test.json`, and an operator table in a throwaway home. Only
   * git's answers, the spawn and the clock are the harness's.
   */
  function measuredTree({ own, override = null, script = 'node scripts/testing/ci.mjs', common = 'repos/memoro.git' }) {
    const dir = mkdtempSync(join(tmpdir(), 'mc-gate-policy-'));
    const wt = join(dir, 'wt');
    const home = join(dir, 'home');
    mkdirSync(join(wt, 'tests'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: script } }));
    writeFileSync(join(wt, 'tests', 'x.test.js'), '');
    if (own !== undefined) {
      mkdirSync(join(wt, '.mc'));
      writeFileSync(join(wt, '.mc', 'test.json'), typeof own === 'string' ? own : JSON.stringify(own));
    }
    if (override) writeFileSync(join(home, 'repo-gates.json'), JSON.stringify(override));
    const h = harness({ finishAfter: 1, output: GREEN });
    delete h.deps.declaration;
    Object.assign(h.deps, {
      cwd: wt,
      env: { MC_SCRATCH: '/scratch', MC_HOME: home },
      git: (cwd, args) => {
        if (args[0] === 'merge-base') return 'mb0000';
        if (args[0] === 'diff' || args[0] === 'ls-files') return '';
        if (args.includes('--git-common-dir')) return join(dir, common);
        return ({ '--show-toplevel': wt, '--absolute-git-dir': join(wt, '.git') })[args[1]] ?? null;
      },
      read: (path) => (h.files.has(path) ? h.files.get(path) : readFileSync(path, 'utf8')),
      exists: (path) => h.files.has(path) || existsSync(path),
      isFile: (path) => h.files.has(path) || (existsSync(path) && statSync(path).isFile()),
    });
    return { ...h, wt, home, request: () => JSON.parse(h.files.get(`${LOG}.request.json`)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const LOADER = ['--import', './tests/_helpers/browser-paths.mjs'];
  /**
   * The configuration a session gate binds for this fixture: the declaration it reads for
   * the repository (the same read `measuredDeclaration` makes), the flags and the identity.
   */
  function configurationOf(fx, flags, identity) {
    const declared = declarationFor(join(dirname(fx.wt), 'repos', 'stranger.git'), { root: fx.home, env: fx.deps.env, contentDir: fx.wt });
    assert.ok(declared.ok, declared.reason);
    return gateConfiguration(declared.declaration, flags, identity);
  }
  /** The measurement a session gate binds (its candidate identity and frozen base), answered by the harness. */
  function measurable(fx) {
    const git = fx.deps.git;
    fx.deps.git = (cwd, args) => (args[0] === 'rev-parse' && args[1] === 'origin/main^{commit}' ? 'b'.repeat(40) : git(cwd, args));
    fx.deps.snapshot = () => ({ repository: '/r/.git', tree: 'a'.repeat(40), fingerprint: 'f' });
    return fx;
  }

  it('timeout policy: a worktree of a bare memoro runs with its own 1000 under a loader-only override, and prints the notice', async () => {
    const fx = measuredTree({ own: { pr_tests_flags: [...LOADER, '--test-timeout=1000'] }, override: { memoro: { pr_tests_flags: LOADER } } });
    try {
      assert.equal(await run(['tests/x.test.js'], fx.deps), 0, fx.out.stderr);
      assert.equal(fx.out.spawned.length, 1);
      assert.deepEqual(fx.request().flags, [...LOADER, '--test-timeout=1000']);
      assert.equal(fx.out.stdout.split('\n')[0], `timeout policy: --test-timeout=1000 from ${join(fx.wt, '.mc', 'test.json')} — `
        + `pr_tests_flags from the operator override ${join(fx.home, 'repo-gates.json')} states no --test-timeout`);
      assert.match(fx.out.stdout, /^GREEN — node --test --import \.\/tests\/_helpers\/browser-paths\.mjs --test-timeout=1000 tests\/x\.test\.js — /mu);
    } finally { fx.cleanup(); }
  });

  it('timeout policy: a malformed worktree declaration or a looser override refuses before anything is spawned', async () => {
    for (const [setup, said] of [
      [{ own: '{"pr_tests_flags": [' }, 'could not be read as JSON'],
      [{ own: { pr_tests_flags: [...LOADER, '--test-timeout=1000'] }, override: { memoro: { pr_tests_flags: [...LOADER, '--test-timeout=600000'] } } }, 'states --test-timeout=600000 (looser than the measured tree)'],
    ]) {
      const fx = measuredTree(setup);
      try {
        assert.equal(await run(['tests/x.test.js'], fx.deps), 2);
        assert.deepEqual(fx.out.spawned, []);
        assert.equal(fx.files.has(`${LOG}.request.json`), false);
        assert.equal(fx.out.stdout, '');
        assert.ok(fx.out.stderr.startsWith('mc: ') && fx.out.stderr.includes(said) && fx.out.stderr.includes(join(fx.wt, '.mc', 'test.json')), fx.out.stderr);
      } finally { fx.cleanup(); }
    }
  });

  it('timeout policy: with no declaration at all, the test script\'s --test-timeout=1000 is the flag the gate runs with', async () => {
    const fx = measurable(measuredTree({ common: 'repos/stranger.git', script: 'node --test --import ./x.mjs --test-timeout=1000 \'tests/**/*.test.js\'' }));
    try {
      assert.equal(await run(['tests/x.test.js'], fx.deps), 0, fx.out.stderr);
      assert.deepEqual(fx.request().flags, ['--import', './x.mjs', '--test-timeout=1000']);
      assert.doesNotMatch(fx.out.stdout, /timeout policy/u);
      // The identity the measurement is bound to is the policy the worker spawns with: the script's 1000 ms, from the script.
      const script = 'node --test --import ./x.mjs --test-timeout=1000 \'tests/**/*.test.js\'';
      assert.deepEqual(fx.request().declared, []);
      assert.equal(fx.request().measurement.configuration, configurationOf(fx, ['--import', './x.mjs', '--test-timeout=1000'],
        executionIdentity(resolveTestPlan({ flags: [], script }))));
    } finally { fx.cleanup(); }
  });

  it('timeout policy: a script with no timeout is measured under the round\'s default, and says so in its identity', async () => {
    const fx = measurable(measuredTree({ common: 'repos/stranger.git', script: 'node --test --import ./x.mjs \'tests/**/*.test.js\'' }));
    try {
      assert.equal(await run(['tests/x.test.js'], fx.deps), 0, fx.out.stderr);
      assert.deepEqual(fx.request().flags, ['--import', './x.mjs']);
      assert.equal(fx.request().measurement.configuration, configurationOf(fx, ['--import', './x.mjs'],
        { timeoutMs: TEST_TIMEOUT_MS, timeoutSource: 'default', forceExit: true, nodeVersion: process.version }));
    } finally { fx.cleanup(); }
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

it('a measurement binding carries the affected gate worker to its reserved session and goal revision', async () => {
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

describe('mc gate reaches the repository ceiling', () => {
  // What the worker writes when its round reached the ceiling: stopped, not failed.
  const CEILING = {
    ok: false, code: 1, stopped_at: 'timeout', reason: 'repository gate ceiling reached after 900 s; unfinished: tests/b.test.js; slowest finished: tests/a.test.js (3 s)',
    red_files: ['tests/b.test.js'], slowest_files: [{ file: 'tests/a.test.js', seconds: 3 }],
  };
  // The worker's own lines for an interrupted run: they are the stop, not its cause.
  const INTERRUPTED = 'Error: tests interrupted\nError: gate interrupted\nRED — gate round reached its 900 s ceiling; unfinished: tests/b.test.js\n';

  it('the text verdict names the unfinished file and the slowest finished ones, and not the interruption', async () => {
    const { out, deps } = harness({ tests: ['a.test.js'], finishAfter: 1, code: 1, output: INTERRUPTED, result: CEILING });
    assert.equal(await run(['a.test.js'], deps), 1);
    assert.match(out.stdout, /^RED — /mu);
    assert.match(out.stdout, /repository gate ceiling reached after 900 s; unfinished: tests\/b\.test\.js; slowest finished: tests\/a\.test\.js \(3 s\)/u);
    assert.doesNotMatch(out.stdout, /tests interrupted|gate interrupted/u);
  });

  it('--json carries the stop, the unfinished files and the slowest finished ones', async () => {
    const json = harness({ tests: ['a.test.js'], finishAfter: 1, code: 1, output: INTERRUPTED, result: CEILING });
    assert.equal(await run(['a.test.js', '--json'], json.deps), 1);
    const parsed = JSON.parse(json.out.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.stopped_at, 'timeout');
    assert.deepEqual(parsed.red_files, ['tests/b.test.js']);
    assert.deepEqual(parsed.slowest_files, [{ file: 'tests/a.test.js', seconds: 3 }]);
  });
});

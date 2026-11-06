import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { it } from 'node:test';
import { runSessionGate, selectorCommand } from '../../src/mc/session-gate-run.js';
import { run as gateCommand } from '../../src/mc/commands/gate.js';
import { readGreenReceipt } from '../../src/mc/gate-greens.js';
import { runningRounds } from '../../src/mc/gate-lock.js';
import { realTests } from '../../src/mc/repo-gate.js';

const GREEN = 'TAP version 13\nok 1 - works\n1..1\n# tests 1\n# pass 1\n# fail 0\n';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// Liveness bounds, not speed limits: about 6 s idle, but the merger runs this
// beside another repository's round, where every git and node spawn is slower.
const BOUNDARY_MS = 60_000;
async function until(check) {
  const deadline = Date.now() + BOUNDARY_MS;
  while (!check()) {
    assert.ok(Date.now() < deadline, `worker reached its expected boundary within ${BOUNDARY_MS / 1000} seconds`);
    await sleep(25);
  }
}

for (const interrupt of [false, true]) it(`a detached worker ${interrupt ? 'interrupts its children' : 'survives the command exit'} before it ends`, { timeout: 4 * BOUNDARY_MS }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-worker-recovery-'));
  const cwd = join(root, 'repo');
  const state = join(root, 'state');
  const ready = join(root, 'ready');
  const finish = join(root, 'finish');
  let workerPid;
  let log;
  try {
    mkdirSync(cwd);
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', 'gate@example.invalid');
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(cwd, 'a.test.js'), `import { test } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
test('controlled completion', async () => {
  writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  while (!existsSync(${JSON.stringify(finish)})) await setTimeout(25);
});\n`);
    git('add', '.');
    git('commit', '-qm', 'initial');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(cwd, 'work.txt'), 'uncommitted change measured by the gate');
    const selection = { files: ['a.test.js'], commands: [], resourceClasses: { 'a.test.js': 'heavy' } };
    const select = `${JSON.stringify(process.execPath)} -e 'console.log(${JSON.stringify(JSON.stringify(selection))})' --`;
    const declaration = { select, pr_tests_flags: ['--no-warnings'] };
    const launcher = `import { run } from ${JSON.stringify(new URL('../../src/mc/commands/gate.js', import.meta.url).href)};
process.exitCode = await run(['--budget', '0.02'], {
  cwd: ${JSON.stringify(cwd)}, declaration: () => ({ ok: true, declaration: ${JSON.stringify(declaration)} }),
});`;
    const command = spawnSync(process.execPath, ['--input-type=module', '-e', launcher], {
      cwd, encoding: 'utf8', timeout: BOUNDARY_MS,
      env: { ...process.env, MC_HOME: state, MC_SCRATCH: root, MC_TEST_LANES: '2' },
    });
    assert.equal(command.status, 3, command.stderr || command.error?.message);
    assert.match(command.stdout, /^RUNNING/u);
    const lockPath = join(cwd, '.git', 'mc-gate.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    workerPid = lock.pid;
    log = lock.log;
    const { measurement } = JSON.parse(readFileSync(lock.request, 'utf8'));
    let output = '';
    const deps = { cwd, env: { ...process.env, MC_HOME: state }, stdout: { write: (s) => { output += s; } },
      stderr: { write: (s) => { output += s; } } };
    await until(() => existsSync(ready));
    const testPid = Number(readFileSync(ready, 'utf8'));
    assert.deepEqual(Object.values(runningRounds({ root: state })).filter(Boolean), [], 'a session gate holds no lane');
    assert.equal(existsSync(join(state, 'gate-evidence', `${measurement.run}.json`)), false);
    assert.equal(await gateCommand(['--wait', '--budget', '0.02'], deps), 3);
    assert.equal(existsSync(lockPath), true);
    if (interrupt) process.kill(workerPid, 'SIGTERM');
    else writeFileSync(finish, 'done');
    // The file can exist before its code is in it, and Number('') is 0.
    await until(() => existsSync(`${log}.exit`) && readFileSync(`${log}.exit`, 'utf8').trim());
    assert.equal(Number(readFileSync(`${log}.exit`, 'utf8')), interrupt ? 1 : 0);
    await until(() => !alive(workerPid));
    await until(() => !alive(testPid));
    output = '';
    assert.equal(await gateCommand(['--wait', '--json'], deps), interrupt ? 1 : 0);
    const result = JSON.parse(output);
    assert.equal(result.evidence.outcome, interrupt ? 'red' : 'green');
    assert.equal(existsSync(lockPath), false);
    const context = { root: state, repo: 'repo', repository: measurement.candidate.repository,
      run: measurement.run, configuration: measurement.configuration };
    const receipt = readGreenReceipt(context);
    if (interrupt) assert.equal(receipt, null);
    else {
      assert.equal(receipt.outcome, 'green');
      const bytes = readFileSync(result.evidence.path, 'utf8');
      assert.deepEqual(readGreenReceipt(context), receipt, 'a subsequent session discovers the same receipt');
      assert.equal(readFileSync(result.evidence.path, 'utf8'), bytes);
    }
  } finally {
    if (workerPid && alive(workerPid)) { process.kill(workerPid, 'SIGTERM'); await until(() => !alive(workerPid)); }
    rmSync(root, { recursive: true, force: true });
  }
});

it('receipt measurement preserves resource batching, lane counts and execution order', async () => {
  const candidate = { repository: '/repo/.git', tree: 'a'.repeat(40), fingerprint: 'bytes' };
  const files = ['standard.test.js', 'db.test.js', 'heavy.test.js'];
  const batches = [];
  let saved;
  const result = await runSessionGate({ cwd: '/repo', select: 'selector', flags: ['--no-warnings'],
    gate: { root: '/state', repo: 'repo' }, measurement: { repo: 'repo', run: 'resources', base: 'b'.repeat(40), candidate } }, {
    snapshot: () => candidate, write: () => {},
    select: async () => ({ ok: true, files, commands: [], classes: { 'db.test.js': 'sqlite', 'heavy.test.js': 'heavy' } }),
    tests: (options) => realTests({ ...options, lanes: 4, runBatch: async ({ files: batch, lanes, flags }) => {
      batches.push({ files: batch, lanes, flags });
      return { code: 0, tap: GREEN };
    } }),
    persist: ({ receipt }) => { saved = receipt; return '/state/receipt.json'; }, record: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(saved.outcome, 'green');
  assert.deepEqual(batches, files.map((file, i) => ({ files: [file], lanes: i === 2 ? 1 : 4, flags: ['--no-warnings'] })));
  assert.equal(saved.execution.tests.totals.runs, 3);
  assert.deepEqual(saved.coverage.files, files);
});

it('the automatic gate runs affected tests and command gates, including a project larger than 30 files', async () => {
  const files = Array.from({ length: 42 }, (_, i) => `tests/${i}.test.js`);
  const classes = { [files[0]]: 'heavy' };
  const calls = [];
  const result = await runSessionGate({ cwd: '/work', select: 'selector', base: 'origin/dev' }, {
    write: () => {},
    select: async () => ({ ok: true, files, classes, commands: [{ packageScript: 'lint', passBaseRef: true }] }),
    tests: async (args) => { calls.push(args); return { tap: GREEN, code: 0 }; },
    shell: async (cmd) => { calls.push(cmd); return { status: 1, stderr: 'broken contract' }; },
  });
  assert.deepEqual(calls[0].files, files);
  assert.deepEqual(calls[0].classes, classes);
  assert.equal(calls[1], "npm run 'lint' -- --base-ref 'origin/dev'");
  assert.equal(result.ok, false);
});

it('starts the serial command sequence beside tests without waiting additively', async () => {
  const started = [];
  let releaseCommand;
  let releaseTestsAfterCommand;
  let testFinished = false;
  let markTestsFinished;
  let releaseTests;
  const commandStarted = new Promise((resolve) => { releaseCommand = resolve; });
  const commandFinished = new Promise((resolve) => { releaseTestsAfterCommand = resolve; });
  const testStarted = new Promise((resolve) => { releaseTests = resolve; });
  const testsDone = new Promise((resolve) => { markTestsFinished = resolve; });
  const bounded = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('not-started'), 300))]);
  const result = await runSessionGate({ cwd: '/work', select: 'selector', base: 'frozen-base' }, {
    write: () => {},
    select: async () => ({ ok: true, files: ['a.test.js'], commands: [
      { packageScript: 'first', passBaseRef: true }, { packageScript: 'second' },
    ] }),
    tests: async () => {
      started.push('tests');
      releaseTests();
      assert.notEqual(await bounded(commandStarted), 'not-started', 'command sequence starts before tests complete');
      assert.notEqual(await bounded(commandFinished), 'not-started', 'command and tests both remain active until released');
      testFinished = true;
      markTestsFinished();
      return { tap: GREEN, code: 0 };
    },
    shell: async (invocation) => {
      started.push(invocation);
      if (invocation.includes('first')) {
        releaseCommand();
        assert.equal(await bounded(testStarted), undefined, 'test sequence has started');
        assert.equal(testFinished, false);
        releaseTestsAfterCommand();
        return { status: 0 };
      }
      assert.notEqual(await bounded(testsDone), 'not-started');
      assert.equal(testFinished, true);
      return { status: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(started, ['tests', "npm run 'first' -- --base-ref 'frozen-base'", "npm run 'second'"]);
  assert.deepEqual(result.execution.commands.map((entry) => entry.exit), [0, 0]);
});

it('classifies only an exact declared command exit as unavailable and keeps later commands running', async () => {
  const cases = [
    { name: 'declared exit', command: { id: 'db:postgres', packageScript: 'db:postgres', unavailableExitCode: 69 }, result: { status: 69 }, verdict: 'incomplete', code: 0 },
    { name: 'ordinary success', command: { id: 'lint', packageScript: 'lint', unavailableExitCode: 69 }, result: { status: 0 }, verdict: 'green', code: 0 },
    { name: 'undeclared exit', command: { id: 'lint', packageScript: 'lint' }, result: { status: 69 }, verdict: 'red', code: 1 },
    { name: 'different failure', command: { id: 'db:postgres', packageScript: 'db:postgres', unavailableExitCode: 69 }, result: { status: 70 }, verdict: 'red', code: 1 },
    { name: 'error with declared exit', command: { id: 'db:postgres', packageScript: 'db:postgres', unavailableExitCode: 69 }, result: { status: 69, error: { code: 'ENOENT' } }, verdict: 'red', code: 1 },
    { name: 'signal with declared exit', command: { id: 'db:postgres', packageScript: 'db:postgres', unavailableExitCode: 69 }, result: { status: 69, signal: 'SIGTERM' }, verdict: 'red', code: 1 },
  ];
  for (const item of cases) {
    const output = [];
    const result = await runSessionGate({ cwd: '/work', select: 'selector' }, {
      write: (line) => output.push(line), select: async () => ({ ok: true, files: [], commands: [item.command] }),
      shell: async () => item.result,
    });
    assert.equal(result.code, item.code, item.name);
    assert.equal(result.verdict, item.verdict, item.name);
    assert.equal(result.process_ok, item.code === 0, item.name);
    assert.deepEqual(result.unavailable_commands || [], item.verdict === 'incomplete'
      ? [{ id: 'db:postgres', packageScript: 'db:postgres', command: "npm run 'db:postgres'", exit: 69 }] : [], item.name);
    assert.equal(result.execution.commands[0].exit, item.result.status, item.name);
    assert.equal(result.execution.commands[0].id, item.command.id, item.name);
    assert.equal(result.execution.commands[0].state, item.verdict === 'incomplete' ? 'unavailable' : 'completed', item.name);
    assert.equal(output.some((line) => line.includes('unavailable (exit 69)')), item.verdict === 'incomplete', item.name);
  }

  for (const failing of ['test', 'command', 'none']) {
    const calls = [];
    const result = await runSessionGate({ cwd: '/work', select: 'selector' }, {
      write: () => {}, select: async () => ({ ok: true, files: ['a.test.js'], commands: [
        { id: 'db:postgres', packageScript: 'db:postgres', unavailableExitCode: 69 }, { id: 'lint:after', packageScript: 'lint:after' },
      ] }),
      tests: async () => ({ tap: failing === 'test' ? '# tests 1\n# pass 0\n# fail 1\n' : GREEN, code: failing === 'test' ? 1 : 0 }),
      shell: async (command) => { calls.push(command); return { status: command.includes('db:postgres') ? 69 : failing === 'command' ? 3 : 0 }; },
    });
    assert.equal(result.code, failing === 'test' || failing === 'command' ? 1 : 0);
    assert.equal(result.verdict, failing === 'test' || failing === 'command' ? 'red' : 'incomplete');
    assert.deepEqual(calls, ["npm run 'db:postgres'", "npm run 'lint:after'"]);
    assert.deepEqual(result.unavailable_commands.map(({ id, exit }) => ({ id, exit })), [{ id: 'db:postgres', exit: 69 }]);
    assert.deepEqual(result.execution.commands.map(({ id, exit, state }) => ({ id, exit, state })), [
      { id: 'db:postgres', exit: 69, state: 'unavailable' }, { id: 'lint:after', exit: failing === 'command' ? 3 : 0, state: 'completed' },
    ]);
  }
});

it('both concurrent halves contribute failures and thrown failures settle the collaborator', async () => {
  const calls = [];
  const failed = await runSessionGate({ cwd: '/work', select: 'selector' }, {
    write: () => {},
    select: async () => ({ ok: true, files: ['a.test.js'], commands: [{ packageScript: 'lint' }] }),
    tests: async () => { calls.push('tests'); return { tap: '# tests 1\\n# pass 0\\n# fail 1\\n', code: 1 }; },
    shell: async () => { calls.push('command'); return { status: 2 }; },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(calls, ['tests', 'command']);
  assert.equal(failed.execution.tests.exit, 1);
  assert.equal(failed.execution.commands[0].exit, 2);

  // Each half throws while the other is held pending: no verdict may arrive
  // before the held half is released, and its final evidence must be in it.
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const bounded = (promise, what) => Promise.race([promise, sleep(2_000).then(() => { throw new Error(`${what} within 2 s`); })]);
  const turns = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  for (const thrower of ['tests', 'command']) {
    const heldStarted = deferred();
    const release = deferred();
    const threw = deferred();
    let verdict = false;
    const gate = runSessionGate({ cwd: '/work', select: 'selector' }, {
      write: () => {},
      select: async () => ({ ok: true, files: ['a.test.js'], commands: [{ packageScript: 'lint' }] }),
      tests: async () => {
        if (thrower === 'tests') { await bounded(heldStarted.promise, 'held command started'); threw.resolve(); throw new Error('test half threw'); }
        heldStarted.resolve();
        await release.promise;
        return { tap: GREEN, code: 0 };
      },
      shell: async () => {
        if (thrower === 'command') { await bounded(heldStarted.promise, 'held tests started'); threw.resolve(); throw new Error('command half threw'); }
        heldStarted.resolve();
        await release.promise;
        return { status: 0 };
      },
    }).then((result) => { verdict = true; return result; });
    try {
      await bounded(threw.promise, `${thrower} half threw`);
      await turns();
      assert.equal(verdict, false, `no verdict while the collaborator of a thrown ${thrower} half is pending`);
    } finally { release.resolve(); }
    const result = await bounded(gate, 'verdict after release');
    assert.equal(result.ok, false);
    if (thrower === 'tests') {
      assert.match(result.execution.tests.error, /test half threw/u);
      assert.deepEqual(result.execution.commands.map(({ state, exit, ok }) => ({ state, exit, ok })), [{ state: 'completed', exit: 0, ok: true }]);
    } else {
      assert.match(result.execution.commands[0].error, /command half threw/u);
      assert.equal(result.execution.tests.exit, 0);
      assert.equal(result.execution.tests.finished, true);
    }
  }
});

it('an abort stops the serial sequence after passing or unavailable evidence', async () => {
  for (const unavailable of [false, true]) {
    const controller = new AbortController();
    const invoked = [];
    const result = await runSessionGate({ cwd: '/work', select: 'selector' }, {
      write: () => {}, signal: controller.signal,
      select: async () => ({ ok: true, files: [], commands: [{ packageScript: 'first', unavailableExitCode: 69 }, { packageScript: 'second' }] }),
      shell: async (command) => { invoked.push(command); controller.abort(); return { status: unavailable ? 69 : 0 }; },
    });
    assert.equal(result.ok, false);
    assert.deepEqual([result.code, result.process_ok, result.complete, result.verdict], [1, false, false, 'red']);
    assert.deepEqual(invoked, ["npm run 'first'"]);
    assert.deepEqual(result.execution.commands.map((entry) => entry.state), [unavailable ? 'unavailable' : 'completed', 'pending']);
    assert.deepEqual(result.unavailable_commands || [], unavailable
      ? [{ id: 'first', packageScript: 'first', command: "npm run 'first'", exit: 69 }] : []);
  }
});

it('an empty, failed or invalid selection never reports green', async () => {
  for (const selected of [{ ok: true, files: [] }, { ok: false, reason: 'unmapped path' }, { ok: true, files: ['../outside.test.js'] }]) {
    const result = await runSessionGate({ cwd: '/work', select: 'selector' }, {
      write: () => {}, select: async () => selected, tests: () => { throw new Error('must not run'); },
    });
    assert.equal(result.ok, false);
  }
});

it('a nonzero test process is not green just because it printed passing counts', async () => {
  const result = await runSessionGate({ cwd: '/work', files: ['a.test.js'] }, {
    write: () => {}, tests: async () => ({ tap: GREEN, code: 1 }),
  });
  assert.equal(result.ok, false);
});

it('new untracked tests are included even when the selector only knows tracked files', async () => {
  let files;
  const result = await runSessionGate({ cwd: '/work', select: 'selector', addedTests: ['new.test.js'] }, {
    write: () => {}, select: async () => ({ ok: true, files: ['old.test.js'], commands: [] }),
    tests: async (args) => { files = args.files; return { tap: GREEN, code: 0 }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(files, ['old.test.js', 'new.test.js']);
});

it('an interruption cannot become green even if a child reports success', async () => {
  const controller = new AbortController();
  const result = await runSessionGate({ cwd: '/work', files: ['a.test.js'] }, {
    write: () => {}, signal: controller.signal,
    tests: async () => { controller.abort(); return { tap: GREEN, code: 0 }; },
  });
  assert.equal(result.ok, false);
});

it('a repository gate ceiling aborts a hanging test and reports its file red', async () => {
  let output = '';
  const result = await runSessionGate({ cwd: '/work', files: ['tests/hangs.test.js'], round_timeout_ms: 20 }, {
    write: (text) => { output += text; },
    tests: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => {
      resolve({ code: null, tap: '', aborted: true });
    }, { once: true })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopped_at, 'timeout');
  assert.deepEqual(result.red_files, ['tests/hangs.test.js']);
  assert.match(output, /reached its 1 s ceiling.*tests\/hangs\.test\.js/u);
});

it('a ceiling names the file that did not finish, and the slowest file that did, apart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-session-ceiling-'));
  let output = '';
  try {
    const result = await runSessionGate({ cwd: '/work', files: ['tests/done.test.js', 'tests/hangs.test.js'], round_timeout_ms: 200, gate: { root: dir, repo: 'work' } }, {
      write: (text) => { output += text; },
      // What node's reporter writes while the run is going: one file finished, one test that never ended.
      tests: ({ times, signal }) => new Promise((resolve) => {
        const path = join(dir, 'times.jsonl');
        writeFileSync(path, [
          { file: '/work/tests/done.test.js', started: true }, { file: '/work/tests/done.test.js', done: true, ms: 2000 },
          { file: '/work/tests/hangs.test.js', started: true },
        ].map((line) => JSON.stringify(line)).join('\n') + '\n');
        times.track(path);
        signal.addEventListener('abort', () => resolve({ code: null, tap: '', aborted: true }), { once: true });
      }),
    });
    assert.equal(result.stopped_at, 'timeout');
    assert.deepEqual(result.red_files, ['tests/hangs.test.js']);
    assert.deepEqual(result.slowest_files, [{ file: 'tests/done.test.js', seconds: 2 }]);
    assert.match(output, /RED — gate round reached its 1 s ceiling; phase: tests; unfinished: tests\/hangs\.test\.js; slowest finished: tests\/done\.test\.js \(2 s\)/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('test-name filters reach node as flags, before the test paths', async () => {
  let args;
  await runSessionGate({ cwd: '/work', files: ['a.test.js'], pattern: 'one|two', flags: ['--import', './loader.mjs'] }, {
    write: () => {}, tests: async (value) => { args = value; return { tap: GREEN, code: 0 }; },
  });
  assert.deepEqual(args.flags, ['--import', './loader.mjs', '--test-name-pattern=one|two']);
});

it('the real gate request and worker preserve whole affected selection, costly failures, and default partial mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-whole-selection-'));
  const cwd = join(root, 'repo');
  const state = join(root, 'state');
  const selectedFiles = ['tests/selected.test.js', 'tests/costly.test.js'];
  const selectedCommands = [{ id: 'lint:selected', packageScript: 'lint:selected', passBaseRef: true }];
  const base = 'a'.repeat(40);
  const candidate = { repository: '/repo/memoro/.git', tree: 'tree', fingerprint: 'bytes' };
  const table = join(state, 'test-times', 'memoro.json');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(state, 'test-times'), { recursive: true });
  writeFileSync(table, JSON.stringify({ 'tests/costly.test.js': 500 }));

  async function requestFor(whole) {
    const files = new Map();
    const output = { stdout: '', stderr: '', spawned: [], alive: new Set() };
    const now = new Date('2026-11-05T12:00:00.000Z');
    const deps = {
      cwd, env: { MC_HOME: state, MC_WORK_ROOT: root, MC_SCRATCH: root },
      stdout: { write: (text) => { output.stdout += text; } },
      stderr: { write: (text) => { output.stderr += text; } },
      now: () => now, id: () => whole ? 'whole' : 'partial',
      claim: () => ({ ok: true, marker: 'claimed' }), release: () => true,
      snapshot: () => candidate,
      git: (_cwd, args) => {
        if (args[0] === 'merge-base') return base;
        if (args[0] === 'diff') return 'implementation.js\0';
        if (args[0] === 'ls-files') return '';
        if (args[0] === 'rev-parse' && args[1] === 'origin/main^{commit}') return base;
        if (args.includes('--git-common-dir')) return '/repo/memoro/.git';
        return ({ '--show-toplevel': cwd, '--absolute-git-dir': join(cwd, '.git') })[args[1]] ?? null;
      },
      declaration: () => ({ ok: true, declaration: { select: 'node select.js --base-ref origin/main' } }),
      read: (path) => {
        if (path === join(cwd, 'package.json')) return JSON.stringify({ scripts: { test: 'node --test' } });
        if (files.has(path)) return files.get(path);
        throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      }, exists: () => false, isFile: () => false,
      write: (path, text) => { files.set(path, text); }, remove: (path) => files.delete(path),
      mkdir: () => {}, open: () => 9, close: () => {},
      spawn: (_file, args) => { output.spawned.push(args); output.alive.add(4242); return { pid: 4242, unref() {} }; },
      alive: (pid) => output.alive.has(pid),
      sleep: async () => {
        const requestPath = output.spawned[0][1];
        const logPath = requestPath.slice(0, -'.request.json'.length);
        files.set(logPath, 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n');
        files.set(`${logPath}.exit`, '0\n');
        output.alive.clear();
      },
    };
    const args = whole ? ['--whole-selection'] : [];
    assert.equal(await gateCommand(args, deps), 0, output.stderr);
    return JSON.parse(files.get(output.spawned[0][1]));
  }

  async function execute(request, failing = false) {
    const actual = { files: [], commands: [] };
    const result = await runSessionGate(request, {
      snapshot: () => candidate, persist: () => '/scratch/no-reusable-receipt.json', record: () => {}, write: () => {},
      select: async () => ({ ok: true, files: selectedFiles, commands: selectedCommands,
        classes: { 'tests/selected.test.js': 'standard', 'tests/costly.test.js': 'sqlite' } }),
      tests: async ({ files: chosen }) => {
        actual.files = [...chosen];
        return failing
          ? { code: 1, tap: 'not ok 1 - costly failure\n# tests 1\n# pass 0\n# fail 1\n' }
          : { code: 0, tap: GREEN };
      },
      shell: async (command) => { actual.commands.push(command); return { status: 0, stdout: '', stderr: '' }; },
    });
    return { result, actual };
  }

  try {
    const wholeRequest = await requestFor(true);
    const whole = await execute(wholeRequest);
    assert.deepEqual(whole.actual.files, selectedFiles);
    assert.equal(wholeRequest.defer, false);
    assert.deepEqual(whole.result.files, selectedFiles);
    assert.deepEqual(whole.result.deferred, []);
    assert.deepEqual(whole.actual.commands, ["npm run 'lint:selected' -- --base-ref '" + base + "'"]);
    assert.deepEqual(whole.result.coverage.commands, selectedCommands);

    const failed = await execute(wholeRequest, true);
    assert.deepEqual(failed.actual.files, selectedFiles);
    assert.equal(failed.result.ok, false, 'failure in the costly selected file remains red');
    assert.equal(failed.result.code, 1);

    const ordinaryRequest = await requestFor(false);
    assert.equal(ordinaryRequest.defer, true);
    const ordinary = await execute(ordinaryRequest);
    assert.deepEqual(ordinary.actual.files, ['tests/selected.test.js']);
    assert.deepEqual(ordinary.result.files, ['tests/selected.test.js']);
    assert.deepEqual(ordinary.result.deferred, ['tests/costly.test.js']);
    assert.deepEqual(ordinary.actual.commands, ["npm run 'lint:selected' -- --base-ref '" + base + "'"]);
    assert.equal(ordinary.result.coverage.kind, 'partial');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('selection replaces the old base and quotes every changed path', () => {
  assert.equal(selectorCommand('node select.js --base-ref origin/main', { base: 'origin/topic', changed: ["src/it's.js", 'src/new.js'] }),
    "node select.js --base-ref 'origin/topic' --changed-path 'src/it'\\''s.js' --changed-path 'src/new.js'");
});

it('unknown exits and zero-test summaries are not completed green tests', async () => {
  for (const run of [{ code: null, tap: GREEN }, { tap: GREEN }, { code: 0, tap: '# tests 0\n# pass 0\n# fail 0\n' }]) {
    const result = await runSessionGate({ cwd: '/work', files: ['a.test.js'] }, {
      write: () => {}, tests: async () => run,
    });
    assert.equal(result.ok, false);
  }
});

it('a command ceiling retains reporter and pending or unavailable evidence without claiming success', async () => {
  for (const unavailable of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'mc-session-command-ceiling-'));
    try {
      const result = await runSessionGate({ cwd: '/work', select: 'selector', round_timeout_ms: 30, gate: { root: dir, repo: 'work' } }, {
        write: () => {},
        select: async () => ({ ok: true, files: ['tests/done.test.js'], commands: [
          ...(unavailable ? [{ id: 'db', packageScript: 'db', unavailableExitCode: 69 }] : []), { packageScript: 'lint:x' },
        ] }),
        tests: async ({ times }) => {
          const path = join(dir, 'times.jsonl');
          times.track(path);
          writeFileSync(path, [
            { file: '/work/tests/done.test.js', started: true },
            { file: '/work/tests/done.test.js', done: true, ms: 1500 },
          ].map(line => JSON.stringify(line)).join('\n'));
          times.complete(path);
          rmSync(path);
          return { code: 0, tap: GREEN };
        },
        shell: (command) => command === "npm run 'db'" ? Promise.resolve({ status: 69 }) : new Promise(() => {}),
      });
      assert.equal(result.stopped_at, 'timeout');
      assert.deepEqual([result.code, result.ok, result.process_ok, result.complete, result.verdict], [1, false, false, false, 'red']);
      assert.deepEqual(result.unavailable_commands || [], unavailable
        ? [{ id: 'db', packageScript: 'db', command: "npm run 'db'", exit: 69 }] : []);
      assert.deepEqual(result.red_files, []);
      assert.deepEqual(result.slowest_files, [{ file: 'tests/done.test.js', seconds: 1.5 }]);
      assert.equal(result.timeout_phase, 'command lint:x');
      assert.deepEqual(result.running_commands, ["npm run 'lint:x'"]);
      assert.equal(result.execution.commands.at(-1).state, 'running');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

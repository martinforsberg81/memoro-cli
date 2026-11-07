import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { it } from 'node:test';
import { runSessionGate as sessionGate, selectorCommand } from '../../src/mc/session-gate-run.js';
import { spawnedBatch, withSpawnedBatches } from './_helpers/spawned-batch.js';

/** Every fake `tests` here stands for a spawn: it reports the batch that spawn would carry. */
const runSessionGate = (request, deps = {}) => sessionGate(request, deps.tests ? { ...deps, tests: withSpawnedBatches(deps.tests) } : deps);
import { run as gateCommand } from '../../src/mc/commands/gate.js';
import { readGreenReceipt } from '../../src/mc/gate-greens.js';
import { runningRounds } from '../../src/mc/gate-lock.js';
import { realTests } from '../../src/mc/repo-gate.js';
import timesReporter from '../../src/mc/test-times-reporter.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'mc-receipt-batches-'));
  let saved;
  try {
    // Unwrapped: this fake is the real `realTests`, which reports its own launches.
    const result = await sessionGate({ cwd: '/repo', select: 'selector', flags: ['--no-warnings'],
      gate: { root: '/state', repo: 'repo' }, measurement: { repo: 'repo', run: 'resources', base: 'b'.repeat(40), candidate } }, {
      snapshot: () => candidate, write: () => {},
      select: async () => ({ ok: true, files, commands: [], classes: { 'db.test.js': 'sqlite', 'heavy.test.js': 'heavy' } }),
      tests: (options) => realTests({ ...options, lanes: 4, runBatch: async ({ files: batch, lanes, flags, times, plan, resource, onBatch }) => {
        batches.push({ files: batch, lanes, flags });
        // The batch as node's reporter leaves it when each of its files finishes, through the round's tracker.
        const path = join(dir, `batch-${batches.length}.jsonl`);
        writeFileSync(path, batch.flatMap((file) => [{ file: `/repo/${file}`, started: true }, { file: `/repo/${file}`, done: true, ms: 1 }, { file: `/repo/${file}`, ended: true, ok: true }])
          .map((line) => JSON.stringify(line)).join('\n') + '\n');
        times.track(path);
        times.complete(path);
        onBatch?.(spawnedBatch({ plan, files: batch, lanes, resource }));
        return { code: 0, tap: GREEN };
      } }),
      persist: ({ receipt }) => { saved = receipt; return '/state/receipt.json'; }, record: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(saved.outcome, 'green');
    assert.deepEqual(batches, files.map((file, i) => ({ files: [file], lanes: i === 2 ? 1 : 4, flags: ['--no-warnings'] })));
    assert.equal(saved.execution.tests.totals.runs, 3);
    assert.deepEqual(saved.coverage.files, files);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

it('a passed test over 1 s is listed slow and the gate stays green; a quick test is not listed', async () => {
  const measured = [
    { file: 'tests/a.test.js', name: 'slow one', line: 3, seconds: 1.4, failed: false, timeout: null },
    { file: 'tests/a.test.js', name: 'quick one', line: 9, seconds: 0.2, failed: false, timeout: null },
  ];
  const result = await runSessionGate({ cwd: '/work', select: 'selector' }, {
    write: () => {},
    select: async () => ({ ok: true, files: ['tests/a.test.js'], commands: [] }),
    tests: async () => ({ tap: GREEN, code: 0, tests: measured }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.verdict, 'green');
  assert.deepEqual(result.slow_tests, [{ file: 'tests/a.test.js', name: 'slow one', seconds: 1.4 }]);
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

it('a run that exits 0 with its summary is red when the tracker says a requested file was cut short', async () => {
  // What node's reporter left, written through the real tracker: a file that never
  // started, a file with a top-level test that never ended, and a file that finished.
  const cases = [
    { files: ['tests/done.test.js', 'tests/cut.test.js'], lines: [
      { file: '/work/tests/done.test.js', started: true }, { file: '/work/tests/done.test.js', done: true, ms: 5 }, { file: '/work/tests/done.test.js', ended: true, ok: true },
      { file: '/work/tests/cut.test.js', started: true },
    ], cut: 'tests/cut.test.js' },
    { files: ['tests/done.test.js', 'tests/absent.test.js'], lines: [
      { file: '/work/tests/done.test.js', started: true }, { file: '/work/tests/done.test.js', done: true, ms: 5 }, { file: '/work/tests/done.test.js', ended: true, ok: true },
    ], cut: 'tests/absent.test.js' },
    { files: ['tests/done.test.js', 'tests/two.test.js'], lines: [
      { file: '/work/tests/done.test.js', started: true }, { file: '/work/tests/done.test.js', done: true, ms: 5 }, { file: '/work/tests/done.test.js', ended: true, ok: true },
      { file: '/work/tests/two.test.js', started: true }, { file: '/work/tests/two.test.js', done: true, ms: 5 }, { file: '/work/tests/two.test.js', ended: true, ok: true },
    ], cut: null },
  ];
  for (const { files, lines, cut } of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'mc-session-cut-'));
    let output = '';
    try {
      const result = await runSessionGate({ cwd: '/work', files, gate: { root: dir, repo: 'work' } }, {
        write: (text) => { output += text; },
        tests: async ({ times }) => {
          const path = join(dir, 'times.jsonl');
          writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
          times.track(path);
          times.complete(path);
          rmSync(path);
          return { code: 0, tap: GREEN };
        },
      });
      if (cut) {
        assert.equal(result.ok, false, cut);
        assert.equal(result.code, 1);
        assert.match(output, new RegExp(`Error: output cut: ${cut.replace(/[.]/gu, '\\.')}\\n`, 'u'));
      } else {
        assert.equal(result.ok, true, output);
        assert.doesNotMatch(output, /output cut/u);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

it('a cancelled test is counted on its own line, and the run is red', async () => {
  let output = '';
  const result = await runSessionGate({ cwd: '/work', files: ['a.test.js'] }, {
    write: (text) => { output += text; },
    tests: async () => ({ code: 1, tap: '# tests 82\n# pass 66\n# fail 0\n# cancelled 16\n# skipped 0\n' }),
  });
  assert.equal(result.ok, false);
  assert.match(output, /^ℹ cancelled 16$/mu);
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
    const args = Array.isArray(whole) ? whole : whole ? ['--whole-selection'] : [];
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
    assert.equal(wholeRequest.fresh, false);
    assert.equal((await requestFor(['--whole-selection', '--fresh'])).fresh, true, '--fresh reaches the worker');
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

/**
 * Resume on unchanged content (Martin, 2026-11-06). Each attempt persists its
 * receipt into one temporary state root, and the next reads it back from there.
 * The test child sends node's own events for each file through the real
 * reporter (`test-times-reporter.mjs`), and the tracker reads what it wrote:
 * `pass`, `fail`, `cancel` and `timeout` end their file; `hang` is a file cut
 * after its first test passed, as node reports it — the test that hangs never
 * starts in the events, and the file gets no summary; `absent` never starts.
 */
const BASE = 'b'.repeat(40);
const CONTENT = { repository: '/repo/.git', tree: 'a'.repeat(40), fingerprint: 'bytes' };
const COMMANDS = [{ packageScript: 'lint', passBaseRef: true }, { id: 'db', packageScript: 'check:db', unavailableExitCode: 69 }];
const FAILURES = { fail: { failureType: 'testCodeFailure', message: 'boom' }, cancel: { failureType: 'cancelledByParent', message: 'cancelled' },
  timeout: { failureType: 'testTimeoutFailure', message: 'test timed out after 30000ms' } };
async function reporterLines(file, outcome) {
  const at = `/work/${file}`;
  if (outcome === 'absent') return '';
  const test = (name, line, error) => [{ type: 'test:start', data: { file: at, nesting: 0, name, line } },
    { type: error ? 'test:fail' : 'test:pass', data: { file: at, nesting: 0, name, line, details: { duration_ms: 4, ...(error ? { error } : {}) } } }];
  const counts = { failed: outcome === 'fail' || outcome === 'timeout' ? 1 : 0, cancelled: outcome === 'cancel' ? 1 : 0 };
  const events = outcome === 'hang' ? test(`${file} pass`, 3)
    : [...test(`${file} ${outcome}`, 3, FAILURES[outcome]), { type: 'test:summary', data: { file: at, success: outcome === 'pass', counts } }];
  let text = '';
  for await (const chunk of timesReporter((async function* () { yield* events; })())) text += chunk;
  return text;
}
function resumable(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-session-resume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let attempts = 0;
  let tick = 0;
  const attempt = async ({ files = ['a.test.js', 'b.test.js', 'c.test.js'], commands = COMMANDS, outcomes = {}, status = {},
    content = CONTENT, flags = [], pattern = null, named = false, base = BASE, configuration = 'config', fresh = false,
    stop = null, timed = {} } = {}) => {
    const run = `run-${++attempts}`;
    const ran = { files: null, commands: [] };
    let output = '';
    const controller = new AbortController();
    const lines = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await reporterLines(file, outcomes[file] || 'pass')])));
    const request = { cwd: '/work', select: 'selector', files: named ? files : null, flags, pattern, base, fresh, timed,
      gate: { root, repo: 'repo' }, ...(stop === 'ceiling' ? { round_timeout_ms: 1 } : {}),
      measurement: { repo: 'repo', run, base, candidate: content, configuration } };
    const result = await runSessionGate(request, {
      snapshot: () => content, record: () => {}, signal: controller.signal,
      now: () => new Date(Date.UTC(2026, 10, 6, 12, 0, tick++)).toISOString(),
      write: (text) => { output += text; },
      select: async () => ({ ok: true, files, commands: named ? [] : commands }),
      tests: ({ files: chosen, times, signal }) => {
        ran.files = [...chosen];
        const path = join(root, `${run}.jsonl`);
        times.track(path);
        // Written before the commands start: an interrupt comes while they wait.
        writeFileSync(path, chosen.map((file) => lines[file]).join(''));
        if (stop) {
          // The run is still going when the ceiling comes or the worker is stopped.
          if (stop === 'interrupt') controller.abort();
          return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ code: null, tap: '', aborted: true }), { once: true }));
        }
        times.complete(path);
        const red = chosen.some((file) => (outcomes[file] || 'pass') !== 'pass');
        return Promise.resolve({ code: red ? 1 : 0, tap: red ? 'not ok 1 - x\n1..1\n# tests 1\n# pass 0\n# fail 1\n' : GREEN,
          tests: chosen.filter((file) => Object.hasOwn(timed, file)).map((file) => ({ file, name: `${file} pass`, line: 3, seconds: 0.004 })) });
      },
      shell: async (command) => { ran.commands.push(command); return { status: status[command] ?? 0 }; },
    });
    const receipt = JSON.parse(readFileSync(result.evidence.path, 'utf8'));
    const reused = /^reused .*$/mu.exec(output)?.[0] ?? null;
    return { run, result, receipt, ran, output, reused, path: result.evidence.path };
  };
  return { root, attempt };
}
const LINT = `npm run 'lint' -- --base-ref '${BASE}'`;
const DB = "npm run 'check:db'";
const fileMembers = (receipt) => receipt.members.files.map(({ file, how, from, outcome }) => ({ file, how, from, outcome }));
const commandMembers = (receipt) => receipt.members.commands.map(({ packageScript, how, from, outcome }) => ({ packageScript, how, from, outcome }));

it('a whole selection stopped at the ceiling or by an interrupt resumes on the same content and completes green', async (t) => {
  for (const stop of ['ceiling', 'interrupt']) {
    const { attempt } = resumable(t);
    const first = await attempt({ stop, outcomes: { 'b.test.js': 'hang', 'c.test.js': 'absent' } });
    assert.equal(first.receipt.outcome, 'red', stop);
    assert.equal(first.receipt.stopped_at, stop === 'ceiling' ? 'timeout' : 'interrupted');
    assert.deepEqual(fileMembers(first.receipt), [
      { file: 'a.test.js', how: 'ran', from: null, outcome: 'passed' },
      { file: 'b.test.js', how: 'ran', from: null, outcome: 'unfinished' },
      { file: 'c.test.js', how: 'ran', from: null, outcome: 'not-started' },
    ], stop);
    // At the ceiling both commands had passed; the interrupt came before they started.
    const ceiling = stop === 'ceiling';
    assert.deepEqual(commandMembers(first.receipt).map((member) => member.outcome), ceiling ? ['passed', 'passed'] : ['pending', 'pending']);
    const second = await attempt();
    assert.deepEqual(second.ran.files, ['b.test.js', 'c.test.js'], stop);
    assert.deepEqual(second.ran.commands, ceiling ? [] : [LINT, DB], stop);
    assert.equal(second.reused, `reused 1 file and ${ceiling ? 2 : 0} commands from ${first.run}; running ${ceiling ? 2 : 4}`);
    assert.equal(second.receipt.outcome, 'green', stop);
    assert.equal(second.result.ok, true);
    assert.deepEqual(second.receipt.coverage.files, ['a.test.js', 'b.test.js', 'c.test.js']);
    assert.deepEqual(fileMembers(second.receipt), [
      { file: 'a.test.js', how: 'reused', from: first.run, outcome: 'passed' },
      { file: 'b.test.js', how: 'ran', from: null, outcome: 'passed' },
      { file: 'c.test.js', how: 'ran', from: null, outcome: 'passed' },
    ]);
    assert.deepEqual(commandMembers(second.receipt), ['lint', 'check:db'].map((packageScript) => (ceiling
      ? { packageScript, how: 'reused', from: first.run, outcome: 'passed' } : { packageScript, how: 'ran', from: null, outcome: 'passed' })));
    assert.deepEqual(second.receipt.resumed, { from: [first.run], files: { 'a.test.js': first.run },
      commands: ceiling ? [{ packageScript: 'lint', from: first.run }, { packageScript: 'check:db', from: first.run }] : [] });
    assert.ok(readGreenReceipt({ root: second.path.split('/gate-evidence/')[0], repo: 'repo', repository: CONTENT.repository,
      run: second.run, configuration: 'config' }), 'the resumed green reads as a green receipt');
  }
});

it('a red attempt resumes with only its failed members, and reuse draws on two earlier attempts', async (t) => {
  const { attempt } = resumable(t);
  const first = await attempt({ outcomes: { 'b.test.js': 'fail', 'c.test.js': 'fail' }, status: { [LINT]: 1 } });
  assert.equal(first.receipt.outcome, 'red');
  const second = await attempt({ outcomes: { 'c.test.js': 'fail' } });
  assert.deepEqual(second.ran.files, ['b.test.js', 'c.test.js']);
  assert.deepEqual(second.ran.commands, [LINT]);
  assert.equal(second.reused, `reused 1 file and 1 command from ${first.run}; running 3`);
  assert.equal(second.receipt.outcome, 'red', 'a member still failing keeps the resumed attempt red');
  const third = await attempt();
  assert.deepEqual(third.ran.files, ['c.test.js']);
  assert.deepEqual(third.ran.commands, []);
  assert.equal(third.reused, `reused 2 files and 2 commands from ${first.run}, ${second.run}; running 1`);
  assert.equal(third.receipt.outcome, 'green');
  assert.deepEqual(fileMembers(third.receipt), [
    { file: 'a.test.js', how: 'reused', from: first.run, outcome: 'passed' },
    { file: 'b.test.js', how: 'reused', from: second.run, outcome: 'passed' },
    { file: 'c.test.js', how: 'ran', from: null, outcome: 'passed' },
  ]);
  assert.deepEqual(commandMembers(third.receipt), [
    { packageScript: 'lint', how: 'reused', from: second.run, outcome: 'passed' },
    { packageScript: 'check:db', how: 'reused', from: first.run, outcome: 'passed' },
  ]);
  // Everything already passed: nothing runs, and that is still a completed green.
  const fourth = await attempt();
  assert.equal(fourth.ran.files, null, 'no test child for an all-reused selection');
  assert.deepEqual(fourth.ran.commands, []);
  assert.equal(fourth.reused, `reused 3 files and 2 commands from ${first.run}, ${second.run}, ${third.run}; running 0`);
  assert.equal(fourth.receipt.outcome, 'green');
  assert.deepEqual(fourth.receipt.members.files.map((member) => member.from), [first.run, second.run, third.run],
    'a reuse names the run that ran it, never a run that reused it');
});

it('--fresh and a newly selected file: fresh reuses nothing, a new member runs', async (t) => {
  const { attempt } = resumable(t);
  const first = await attempt();
  assert.equal(first.receipt.outcome, 'green');
  const fresh = await attempt({ fresh: true });
  assert.deepEqual(fresh.ran.files, ['a.test.js', 'b.test.js', 'c.test.js']);
  assert.deepEqual(fresh.ran.commands, [LINT, DB]);
  assert.equal(fresh.reused, null);
  assert.equal(fresh.receipt.resumed, null);
  assert.deepEqual(fresh.receipt.members.files.map((member) => member.how), ['ran', 'ran', 'ran']);
  const wider = await attempt({ files: ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js'] });
  assert.deepEqual(wider.ran.files, ['d.test.js']);
  assert.deepEqual(wider.receipt.coverage.files, ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js']);
  const narrower = await attempt({ files: ['b.test.js'], commands: [] });
  assert.equal(narrower.ran.files, null);
  assert.deepEqual(narrower.receipt.coverage.files, ['b.test.js'], 'only the current selection counts');
  assert.deepEqual(narrower.receipt.members.commands, []);
});

it('a reused file is timed from its source run and says so; nothing is measured twice', async (t) => {
  const { attempt, root } = resumable(t);
  const timed = { 'a.test.js': null };
  await attempt({ timed, outcomes: { 'b.test.js': 'fail' } });
  const second = await attempt({ timed });
  assert.deepEqual(second.ran.files, ['b.test.js']);
  assert.deepEqual(second.result.timed_tests, [{ file: 'a.test.js', name: 'a.test.js pass', line: 3, seconds: 0.004, reused: 'run-1' }]);
  assert.equal(existsSync(join(root, 'test-times')), false, 'a reused file adds no measured time');
});

it('nothing is reused across a content change, other flags, a name pattern, configuration or measurement version', async (t) => {
  const changes = {
    tree: { content: { ...CONTENT, tree: 'c'.repeat(40) } },
    fingerprint: { content: { ...CONTENT, fingerprint: 'other bytes' } },
    repository: { content: { ...CONTENT, repository: '/other/.git' } },
    flags: { flags: ['--import', './other.mjs'] },
    configuration: { configuration: 'other config' },
    pattern: { named: true, pattern: 'a' },
  };
  for (const [name, change] of Object.entries(changes)) {
    const { attempt } = resumable(t);
    await attempt(change.named ? { named: true } : {});
    const again = await attempt(change);
    assert.equal(again.reused, null, name);
    assert.deepEqual(again.ran.files, ['a.test.js', 'b.test.js', 'c.test.js'], name);
    assert.deepEqual(again.ran.commands, change.named ? [] : [LINT, DB], name);
  }
  // A source measured under a name pattern resumes nothing either.
  const { attempt } = resumable(t);
  await attempt({ named: true, pattern: 'a' });
  assert.deepEqual((await attempt({ named: true })).ran.files, ['a.test.js', 'b.test.js', 'c.test.js']);
  // A receipt from another measurement version is not a source.
  const versioned = resumable(t);
  const old = await versioned.attempt();
  writeFileSync(old.path, JSON.stringify({ ...old.receipt, gate_version: old.receipt.gate_version - 1 }));
  const after = await versioned.attempt();
  assert.equal(after.reused, null);
  assert.deepEqual(after.ran.files, ['a.test.js', 'b.test.js', 'c.test.js']);
});

it('a base-passing command is not reused across bases; files and other commands are', async (t) => {
  const { attempt } = resumable(t);
  const first = await attempt();
  const other = 'e'.repeat(40);
  const moved = await attempt({ base: other });
  assert.equal(moved.ran.files, null);
  assert.deepEqual(moved.ran.commands, [`npm run 'lint' -- --base-ref '${other}'`]);
  assert.deepEqual(commandMembers(moved.receipt), [
    { packageScript: 'lint', how: 'ran', from: null, outcome: 'passed' },
    { packageScript: 'check:db', how: 'reused', from: first.run, outcome: 'passed' },
  ]);
});

it('failed, cancelled, timed-out, unfinished and never-started files and failed or unavailable commands always rerun', async (t) => {
  const { attempt } = resumable(t);
  const files = ['ok.test.js', 'fail.test.js', 'cancel.test.js', 'timeout.test.js', 'hang.test.js', 'absent.test.js'];
  const first = await attempt({ files, status: { [LINT]: 2, [DB]: 69 }, outcomes: { 'fail.test.js': 'fail',
    'cancel.test.js': 'cancel', 'timeout.test.js': 'timeout', 'hang.test.js': 'hang', 'absent.test.js': 'absent' } });
  assert.deepEqual(fileMembers(first.receipt).map(({ file, outcome }) => [file, outcome]), [['ok.test.js', 'passed'],
    ['fail.test.js', 'failed'], ['cancel.test.js', 'failed'], ['timeout.test.js', 'failed'], ['hang.test.js', 'unfinished'],
    ['absent.test.js', 'not-started']]);
  assert.deepEqual(commandMembers(first.receipt).map(({ outcome }) => outcome), ['failed', 'unavailable']);
  const second = await attempt({ files });
  assert.deepEqual(second.ran.files, files.slice(1));
  assert.deepEqual(second.ran.commands, [LINT, DB]);
  assert.equal(second.reused, `reused 1 file and 0 commands from ${first.run}; running 7`);
  assert.equal(second.receipt.outcome, 'green');
});

it('a file red under load and green alone settles the gate green, says so and resumes as passed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-session-settle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const red = `TAP version 13\nok 1 - passes\n# Subtest: scans\nnot ok 2 - scans\n  ---\n  location: '/work/a.test.js:3:1'\n  failureType: 'testTimeoutFailure'\n  error: 'test timed out after 1000ms'\n  ...\n1..2\n# tests 2\n# pass 1\n# fail 1\n`;
  const calls = [];
  let output = '';
  const lines = { pass: await reporterLines('a.test.js', 'pass'), timeout: await reporterLines('a.test.js', 'timeout'), b: await reporterLines('b.test.js', 'pass') };
  const result = await runSessionGate({ cwd: '/work', select: 'selector', files: null, flags: [], base: BASE, gate: { root, repo: 'repo' },
    measurement: { repo: 'repo', run: 'run-settle', base: BASE, candidate: CONTENT, configuration: 'config' } }, {
    snapshot: () => CONTENT, record: () => {}, now: () => new Date(Date.UTC(2026, 10, 7, 12, 0, calls.length)).toISOString(),
    write: (text) => { output += text; },
    select: async () => ({ ok: true, files: ['a.test.js', 'b.test.js'], commands: [] }),
    tests: async ({ files, lanes, times }) => {
      calls.push({ files, lanes });
      const path = join(root, `times-${calls.length}.jsonl`);
      times.track(path);
      const first = calls.length === 1;
      writeFileSync(path, first ? `${lines.timeout}${lines.b}` : lines.pass);
      times.complete(path);
      return first ? { code: 1, tap: red } : { code: 0, tap: GREEN };
    },
  });
  assert.deepEqual(calls, [{ files: ['a.test.js', 'b.test.js'], lanes: undefined }, { files: ['a.test.js'], lanes: 1 }]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.settled, { alone: ['a.test.js'], main: [], base: null, red: [] });
  assert.match(output, /green alone — red in the round under load, passed run by themselves: a\.test\.js/u);
  const receipt = JSON.parse(readFileSync(result.evidence.path, 'utf8'));
  assert.notEqual(receipt.outcome, 'green', 'a settled run is not a green receipt: its round had a failure');
  assert.deepEqual(receipt.members.files.map(({ file, outcome }) => ({ file, outcome })),
    [{ file: 'a.test.js', outcome: 'passed' }, { file: 'b.test.js', outcome: 'passed' }], 'the next attempt reuses both');
});

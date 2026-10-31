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
import { gateLockPath, releaseGateLock, runningRound, takeGateLock } from '../../src/mc/gate-lock.js';
import { realTests } from '../../src/mc/repo-gate.js';

const GREEN = 'TAP version 13\nok 1 - works\n1..1\n# tests 1\n# pass 1\n# fail 0\n';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// Liveness bounds, not speed limits: about 6 s idle, but the merger runs this
// beside the other lane's round, where every git and node spawn is slower.
const BOUNDARY_MS = 60_000;
async function until(check) {
  const deadline = Date.now() + BOUNDARY_MS;
  while (!check()) {
    assert.ok(Date.now() < deadline, `worker reached its expected boundary within ${BOUNDARY_MS / 1000} seconds`);
    await sleep(25);
  }
}

for (const interrupt of [false, true]) it(`a detached worker ${interrupt ? 'interrupts its children' : 'survives the command exit'} before releasing its lane`, { timeout: 4 * BOUNDARY_MS }, async () => {
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
    const reservation = { root: state, lane: 'light', repo: 'repo' };
    const selection = { files: ['a.test.js'], commands: [], resourceClasses: { 'a.test.js': 'heavy' } };
    const select = `${JSON.stringify(process.execPath)} -e 'console.log(${JSON.stringify(JSON.stringify(selection))})' --`;
    assert.equal(takeGateLock(reservation).ok, true, 'another owner initially holds the lane');
    const declaration = { select, pr_tests_flags: ['--no-warnings'] };
    const launcher = `import { run } from ${JSON.stringify(new URL('../../src/mc/commands/gate.js', import.meta.url).href)};
process.exitCode = await run(['--budget', '0.02'], {
  cwd: ${JSON.stringify(cwd)}, declaration: () => ({ ok: true, declaration: ${JSON.stringify(declaration)} }), lane: () => 'light',
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
    await until(() => readFileSync(log, 'utf8').includes('waiting for'));
    assert.equal(await gateCommand(['--wait', '--budget', '0.02'], deps), 3);
    assert.match(output, /still waiting for the light lane/u);
    assert.equal(existsSync(ready), false);
    assert.equal(releaseGateLock(reservation), true);
    await until(() => existsSync(ready));
    const testPid = Number(readFileSync(ready, 'utf8'));
    assert.equal(runningRound({ root: state, lane: 'light' }).pid, workerPid, 'the worker, not the command, owns the lane');
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
    assert.equal(runningRound({ root: state, lane: 'light' }), null);
    assert.equal(existsSync(`${gateLockPath(state, 'light')}.claim`), false);
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
    assert.equal(takeGateLock(reservation).ok, true, 'the next run can reserve the released resource');
    releaseGateLock(reservation);
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
    reservation: { root: '/state' }, measurement: { repo: 'repo', run: 'resources', base: 'b'.repeat(40), candidate } }, {
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

it('test-name filters reach node as flags, before the test paths', async () => {
  let args;
  await runSessionGate({ cwd: '/work', files: ['a.test.js'], pattern: 'one|two', flags: ['--import', './loader.mjs'] }, {
    write: () => {}, tests: async (value) => { args = value; return { tap: GREEN, code: 0 }; },
  });
  assert.deepEqual(args.flags, ['--import', './loader.mjs', '--test-name-pattern=one|two']);
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

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { describe } from 'node:test';

import {
  LOCAL_HEAVY_JOB_ACTIVE_ENV,
  LOCAL_HEAVY_JOB_THREADS_ENV,
  LOCAL_RESOURCE_GUARD_ENV,
  acquireHeavyJobSlot,
  applyThreadLimits,
  evaluateLocalHeavyJobPreflight,
  evaluateLocalHeavyJobRuntime,
  isLocalHeavyNodeCommand,
  isLocalHeavyPythonCommand,
  prepareLocalResourceGuardEnv,
  processTreeRssMb,
  releaseHeavyJobSlot,
  runLocalResourceGuardShim,
  waitForHeavyJobSlot,
} from '../../src/mc/local-resource-guard.js';
import { buildLocalResourceProfile } from '../../src/mc/local-resource-profile.js';

const BALANCED = buildLocalResourceProfile('balanced');

describe('local resource guard policy', () => {
  test('recognises known local image and motion commands only', () => {
    assert.equal(isLocalHeavyPythonCommand(['inference.py', '--flag-force-cpu']), true);
    assert.equal(isLocalHeavyPythonCommand(['-m', 'sandbox_programs.avatar.motion']), true);
    assert.equal(isLocalHeavyPythonCommand(['/repo/liveportrait/inference.py']), true);
    assert.equal(isLocalHeavyPythonCommand(['-m', 'pytest']), false);
    assert.equal(isLocalHeavyPythonCommand(['scripts/admin/report.py']), false);
  });

  test('sets numerical-library thread limits without dropping the environment', () => {
    const env = applyThreadLimits({ PATH: '/bin', KEEP: 'yes' }, 2);
    assert.equal(env.KEEP, 'yes');
    assert.equal(env.OMP_NUM_THREADS, '2');
    assert.equal(env.MKL_NUM_THREADS, '2');
    assert.equal(env.OPENBLAS_NUM_THREADS, '2');
    assert.equal(env.VECLIB_MAXIMUM_THREADS, '2');
    assert.equal(env.TOKENIZERS_PARALLELISM, 'false');
  });

  test('blocks unsafe disk/swap preflight and excessive runtime RSS', () => {
    assert.equal(evaluateLocalHeavyJobPreflight(BALANCED, { freeDiskGb: 14, swapUsedMb: 0 }).ok, false);
    assert.equal(evaluateLocalHeavyJobPreflight(BALANCED, { freeDiskGb: 30, swapUsedMb: 2048 }).ok, false);
    assert.equal(evaluateLocalHeavyJobPreflight(BALANCED, { freeDiskGb: 30, swapUsedMb: 0 }).ok, true);
    assert.equal(evaluateLocalHeavyJobRuntime(BALANCED, {
      freeDiskGb: 30,
      swapUsedMb: 0,
      processTreeRssMb: 5000,
    }).ok, false);
  });

  test('sums RSS across the protected process tree', () => {
    const rss = processTreeRssMb(10, {
      ps: () => ({
        status: 0,
        stdout: '10 1 1024\n11 10 2048\n12 11 3072\n20 1 9999\n',
      }),
    });
    assert.equal(rss, 6);
  });
});

describe('local resource guard installation and runtime', () => {
  test('unlimited is the default and installs no PATH shim', () => {
    const prepared = prepareLocalResourceGuardEnv({
      baseEnv: { PATH: '/usr/bin' },
      config: {},
    });
    assert.equal(prepared.installed, false);
    assert.equal(prepared.env.PATH, '/usr/bin');
    assert.equal(prepared.env[LOCAL_RESOURCE_GUARD_ENV], undefined);
  });

  test('opt-in profile installs an importing Python shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-resource-guard-'));
    try {
      const prepared = prepareLocalResourceGuardEnv({
        mcDir: root,
        codingSessionId: 'sess/A B',
        baseEnv: { PATH: '/usr/bin' },
        config: { resources: { localHeavyJobs: { profile: 'conservative' } } },
      });
      assert.equal(prepared.installed, true);
      assert.equal(prepared.env[LOCAL_RESOURCE_GUARD_ENV], 'conservative');
      assert.ok(prepared.env.PATH.startsWith(prepared.dir + delimiter));
      const script = readFileSync(join(prepared.dir, 'python3'), 'utf8');
      assert.match(script, /runLocalResourceGuardShim/);
      assert.match(script, /"maxThreads":2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('generated shim imports and passes ordinary Python through untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-resource-smoke-'));
    const realBin = join(root, 'real-bin');
    mkdirSync(realBin, { recursive: true });
    const realPython = join(realBin, 'python3');
    writeFileSync(realPython, '#!/bin/sh\nprintf "real-python:%s:threads=%s\\n" "$*" "$OMP_NUM_THREADS"\n');
    chmodSync(realPython, 0o700);
    try {
      const prepared = prepareLocalResourceGuardEnv({
        mcDir: root,
        codingSessionId: 'sess_smoke',
        baseEnv: { ...process.env, PATH: `${realBin}${delimiter}${process.env.PATH || ''}` },
        config: { resources: { localHeavyJobs: { profile: 'balanced' } } },
      });
      const result = spawnSync(join(prepared.dir, 'python3'), ['-m', 'pytest'], {
        env: prepared.env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /real-python:-m pytest:threads=/);
      assert.doesNotMatch(result.stdout, /threads=4/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('node test runs are heavy; ordinary node and npm work is not', () => {
    assert.equal(isLocalHeavyNodeCommand('node', ['--test', 'tests/']), true);
    assert.equal(isLocalHeavyNodeCommand('node', ['script.js']), false);
    assert.equal(isLocalHeavyNodeCommand('npm', ['test']), true);
    assert.equal(isLocalHeavyNodeCommand('npm', ['t']), true);
    assert.equal(isLocalHeavyNodeCommand('npm', ['run', 'test:live']), true);
    assert.equal(isLocalHeavyNodeCommand('npm', ['run', 'css:build']), false);
    assert.equal(isLocalHeavyNodeCommand('npm', ['ci']), false);
    assert.equal(isLocalHeavyNodeCommand('npm', ['run', 'dev']), false);
  });

  test('a protected npm test queues for the slot and marks the child environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-resource-node-'));
    const realBin = join(root, 'real-bin');
    mkdirSync(realBin, { recursive: true });
    writeFileSync(join(realBin, 'npm'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(realBin, 'npm'), 0o700);
    try {
      const profile = buildLocalResourceProfile('conservative');
      const waits = [];
      let spawnedEnv = null;
      const code = await runLocalResourceGuardShim({
        invokedPath: join(root, 'guard', 'npm'),
        argv: ['test'],
        profile,
        lockRoot: join(root, 'locks'),
        codingSessionId: 'sess_node',
        env: { PATH: `${realBin}${delimiter}/usr/bin` },
        stderr: { write: () => {} },
        deps: {
          existsSync: (path) => path === join(realBin, 'npm') || existsSync(path),
          waitForHeavyJobSlot: async (options) => {
            waits.push(options.maxConcurrent);
            return { path: join(root, 'locks', 'slot-1'), token: 't' };
          },
          releaseHeavyJobSlot: () => true,
          spawn: (bin, args, options) => {
            spawnedEnv = options.env;
            const child = new EventEmitter();
            child.pid = 4242;
            setImmediate(() => child.emit('close', 0, null));
            return child;
          },
          collectHostMetrics: () => ({ freeDiskGb: 100, swapUsedMb: 0 }),
          processTreeRssMb: () => 10,
        },
      });

      assert.equal(code, 0);
      assert.deepEqual(waits, [1]);
      assert.equal(spawnedEnv[LOCAL_HEAVY_JOB_ACTIVE_ENV], '1');
      assert.equal(spawnedEnv[LOCAL_HEAVY_JOB_THREADS_ENV], '2');
      assert.equal(spawnedEnv.UV_THREADPOOL_SIZE, '2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a nested guarded command inside a protected job passes through without a second slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-resource-nested-'));
    const realBin = join(root, 'real-bin');
    mkdirSync(realBin, { recursive: true });
    writeFileSync(join(realBin, 'node'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(realBin, 'node'), 0o700);
    try {
      const profile = buildLocalResourceProfile('conservative');
      let acquired = 0;
      let passArgs = null;
      const code = await runLocalResourceGuardShim({
        invokedPath: join(root, 'guard', 'node'),
        argv: ['--test', 'tests/'],
        profile,
        lockRoot: join(root, 'locks'),
        codingSessionId: 'sess_nested',
        env: {
          PATH: `${realBin}${delimiter}/usr/bin`,
          [LOCAL_HEAVY_JOB_ACTIVE_ENV]: '1',
          [LOCAL_HEAVY_JOB_THREADS_ENV]: '2',
        },
        stderr: { write: () => {} },
        deps: {
          existsSync: (path) => path === join(realBin, 'node') || existsSync(path),
          acquireHeavyJobSlot: () => { acquired += 1; return null; },
          waitForHeavyJobSlot: async () => { acquired += 1; return null; },
          spawnSync: (bin, args) => {
            passArgs = args;
            return { status: 0 };
          },
        },
      });

      assert.equal(code, 0);
      assert.equal(acquired, 0);
      // The nested test runner still gets its worker count capped.
      assert.deepEqual(passArgs, ['--test', '--test-concurrency=2', 'tests/']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('waitForHeavyJobSlot polls until a slot frees and nags while queued', async () => {
    let clock = 0;
    let free = false;
    const nags = [];
    const lock = await waitForHeavyJobSlot({
      lockRoot: '/tmp/none',
      maxConcurrent: 1,
      stderr: { write: (line) => nags.push(line) },
      waitMs: 100_000,
      pollMs: 1_000,
      nagMs: 30_000,
      deps: {
        acquireHeavyJobSlot: () => (free ? { path: '/tmp/none/slot-1', token: 't' } : null),
        sleep: async () => { clock += 1_000; if (clock >= 65_000) free = true; },
        now: () => clock,
      },
    });
    assert.ok(lock);
    assert.equal(nags.length, 2);
    assert.match(nags[0], /waiting for a protected job slot/);
  });

  test('waitForHeavyJobSlot gives up at the deadline', async () => {
    let clock = 0;
    const lock = await waitForHeavyJobSlot({
      lockRoot: '/tmp/none',
      maxConcurrent: 1,
      stderr: { write: () => {} },
      waitMs: 10_000,
      pollMs: 1_000,
      deps: {
        acquireHeavyJobSlot: () => null,
        sleep: async () => { clock += 1_000; },
        now: () => clock,
      },
    });
    assert.equal(lock, null);
  });

  test('global slots enforce concurrency and recover stale owners', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-resource-lock-'));
    try {
      const first = acquireHeavyJobSlot({ lockRoot: root, maxConcurrent: 1, pid: process.pid });
      assert.ok(first);
      assert.equal(acquireHeavyJobSlot({ lockRoot: root, maxConcurrent: 1, pid: process.pid }), null);
      assert.equal(releaseHeavyJobSlot(first), true);

      const staleDir = join(root, 'slot-1');
      mkdirSync(staleDir);
      writeFileSync(join(staleDir, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'old' }));
      const recovered = acquireHeavyJobSlot({
        lockRoot: root,
        maxConcurrent: 1,
        pid: process.pid,
        isAlive: () => false,
      });
      assert.ok(recovered);
      assert.equal(releaseHeavyJobSlot(recovered), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('watchdog stops only the protected heavy child at the memory threshold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-resource-watch-'));
    const realBin = join(root, 'real-bin');
    mkdirSync(realBin);
    const realPython = join(realBin, 'python3');
    writeFileSync(realPython, '#!/bin/sh\nexit 0\n');
    chmodSync(realPython, 0o700);
    const signals = [];
    const fakeChild = new EventEmitter();
    fakeChild.pid = 4242;
    fakeChild.kill = (signal) => {
      signals.push(signal);
      queueMicrotask(() => fakeChild.emit('close', null, signal));
      return true;
    };
    const stderr = { text: '', write(chunk) { this.text += String(chunk); } };
    let locked = false;
    let released = false;
    try {
      const code = await runLocalResourceGuardShim({
        invokedPath: join(root, 'guard', 'python3'),
        argv: ['inference.py', '--flag-force-cpu'],
        profile: BALANCED,
        lockRoot: join(root, 'locks'),
        env: { PATH: realBin },
        stderr,
        deps: {
          platform: 'win32',
          existsSync,
          collectHostMetrics: () => ({ freeDiskGb: 30, swapUsedMb: 0 }),
          processTreeRssMb: () => 5000,
          acquireHeavyJobSlot: () => { locked = true; return { path: 'x', token: 'y' }; },
          releaseHeavyJobSlot: () => { released = true; return true; },
          spawn: () => fakeChild,
          watchIntervalMs: 5,
        },
      });
      assert.equal(code, 75);
      assert.equal(locked, true);
      assert.equal(released, true);
      assert.deepEqual(signals, ['SIGTERM']);
      assert.match(stderr.text, /stopping local heavy job/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

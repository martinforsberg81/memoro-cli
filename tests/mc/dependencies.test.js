import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireDependencyLock,
  cloneDependencyDirectory,
  computeDependencyFingerprint,
  dependencySnapshotPath,
  dependencyStatus,
  hydrateDependencies,
} from '../../src/mc/dependencies.js';

function makePlan(root, mode = 'auto') {
  return {
    worktree_path: root,
    service: { name: 'web', source: '.mc/dev.json' },
    profile: { name: 'agent', source: '.mc/dev.json' },
    dependency_mode: { name: mode, source: 'package-defaults' },
    dependencies: {
      manager: 'npm',
      fingerprint_files: ['package.json', 'package-lock.json'],
      install: { argv: ['npm', 'ci'] },
    },
  };
}

function writePackageInputs(root, suffix = '') {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', suffix }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, suffix }));
}

const runtime = {
  nodeAbi: '137',
  platform: 'darwin',
  arch: 'arm64',
  npmVersion: '11.4.2',
};

describe('dependency fingerprints', () => {
  test('include package inputs, Node ABI, platform, architecture, and npm version', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-fingerprint-'));
    try {
      writePackageInputs(root);
      const plan = makePlan(root);
      const first = await computeDependencyFingerprint(plan, runtime);
      const same = await computeDependencyFingerprint(plan, runtime);
      assert.equal(first.value, same.value);
      assert.match(first.value, /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(first.runtime, {
        node_abi: '137',
        platform: 'darwin',
        arch: 'arm64',
        npm_version: '11.4.2',
      });
      assert.deepEqual(first.files.map((file) => file.path), ['package-lock.json', 'package.json']);

      writePackageInputs(root, 'changed');
      const changedLock = await computeDependencyFingerprint(plan, runtime);
      assert.notEqual(changedLock.value, first.value);
      const changedAbi = await computeDependencyFingerprint(plan, { ...runtime, nodeAbi: '138' });
      assert.notEqual(changedAbi.value, changedLock.value);
      const changedNpm = await computeDependencyFingerprint(plan, { ...runtime, npmVersion: '12.0.0' });
      assert.notEqual(changedNpm.value, changedLock.value);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dependency snapshots', () => {
  test('publishes a cache miss and hydrates a second worktree without sharing node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-hydrate-'));
    const mcDir = join(root, 'mc-home');
    const firstRoot = join(root, 'first');
    const secondRoot = join(root, 'second');
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(secondRoot, { recursive: true });
    writePackageInputs(firstRoot);
    writePackageInputs(secondRoot);
    const installs = [];
    const runInstall = async (argv, options) => {
      installs.push({ argv, options });
      mkdirSync(join(options.cwd, 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(join(options.cwd, 'node_modules', 'fixture', 'index.js'), 'export default 1;\n');
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    try {
      const first = await hydrateDependencies(makePlan(firstRoot), {
        mcDir,
        fingerprintOptions: runtime,
        deps: { runProcess: runInstall, platform: 'linux' },
      });
      assert.equal(first.ok, true);
      assert.equal(first.source, 'install');
      assert.equal(installs.length, 1);
      assert.deepEqual(installs[0].argv, ['npm', 'ci']);
      assert.equal(installs[0].options.env.npm_config_prefer_offline, 'true');
      assert.equal(first.status.worktree.state, 'ready');
      assert.equal(first.status.snapshot.state, 'ready');

      const second = await hydrateDependencies(makePlan(secondRoot), {
        mcDir,
        fingerprintOptions: runtime,
        deps: {
          runProcess: async () => assert.fail('cache hit must not run npm ci'),
          platform: 'linux',
        },
      });
      assert.equal(second.ok, true);
      assert.equal(second.source, 'snapshot');
      assert.equal(readFileSync(join(secondRoot, 'node_modules', 'fixture', 'index.js'), 'utf8'), 'export default 1;\n');
      assert.equal(lstatSync(join(secondRoot, 'node_modules')).isSymbolicLink(), false);
      assert.notEqual(lstatSync(join(firstRoot, 'node_modules')).ino, lstatSync(join(secondRoot, 'node_modules')).ino);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('isolated installs never publish snapshots and off never runs install code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-modes-'));
    const mcDir = join(root, 'mc-home');
    const isolatedRoot = join(root, 'isolated');
    const offRoot = join(root, 'off');
    mkdirSync(isolatedRoot, { recursive: true });
    mkdirSync(offRoot, { recursive: true });
    writePackageInputs(isolatedRoot);
    writePackageInputs(offRoot);
    try {
      const isolated = await hydrateDependencies(makePlan(isolatedRoot, 'isolated'), {
        mcDir,
        fingerprintOptions: runtime,
        deps: {
          runProcess: async (_argv, options) => {
            mkdirSync(join(options.cwd, 'node_modules'), { recursive: true });
            return { ok: true, code: 0, stdout: '', stderr: '' };
          },
        },
      });
      assert.equal(isolated.ok, true);
      assert.equal(isolated.source, 'install-isolated');
      assert.equal(existsSync(isolated.status.snapshot.path), false);

      const published = await hydrateDependencies(makePlan(isolatedRoot, 'auto'), {
        mcDir,
        fingerprintOptions: runtime,
        deps: {
          runProcess: async () => assert.fail('a ready managed worktree can publish without reinstalling'),
          platform: 'linux',
        },
      });
      assert.equal(published.ok, true);
      assert.equal(published.source, 'existing');
      assert.equal(published.snapshot_published, true);
      assert.equal(published.status.snapshot.state, 'ready');

      const off = await hydrateDependencies(makePlan(offRoot, 'off'), {
        mcDir,
        fingerprintOptions: runtime,
        deps: { runProcess: async () => assert.fail('off must not execute install argv') },
      });
      assert.equal(off.ok, false);
      assert.equal(off.reason, 'dependency-management-off');
      assert.equal(existsSync(join(offRoot, 'node_modules')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses unmanaged node_modules unless replacement is explicit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-unmanaged-'));
    const worktree = join(root, 'worktree');
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    writePackageInputs(worktree);
    try {
      const refused = await hydrateDependencies(makePlan(worktree), {
        mcDir: join(root, 'mc-home'),
        fingerprintOptions: runtime,
        deps: { runProcess: async () => assert.fail('refusal must precede install') },
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'existing-unmanaged-node-modules');

      const replaced = await hydrateDependencies(makePlan(worktree), {
        mcDir: join(root, 'mc-home'),
        replace: true,
        fingerprintOptions: runtime,
        deps: {
          platform: 'linux',
          runProcess: async (_argv, options) => {
            mkdirSync(join(options.cwd, 'node_modules', 'managed'), { recursive: true });
            return { ok: true, code: 0, stdout: '', stderr: '' };
          },
        },
      });
      assert.equal(replaced.ok, true);
      assert.equal(replaced.status.worktree.state, 'ready');
      assert.equal(existsSync(join(worktree, 'node_modules', 'managed')), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('status is read-only and distinguishes a missing worktree copy from a ready snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-status-'));
    const worktree = join(root, 'worktree');
    const mcDir = join(root, 'mc-home');
    mkdirSync(worktree, { recursive: true });
    writePackageInputs(worktree);
    try {
      const fingerprint = await computeDependencyFingerprint(makePlan(worktree), runtime);
      const snapshot = dependencySnapshotPath(fingerprint.value, { mcDir });
      mkdirSync(join(snapshot, 'node_modules'), { recursive: true });
      writeFileSync(join(snapshot, 'metadata.json'), JSON.stringify({
        schema_version: 1,
        fingerprint: fingerprint.value,
      }));
      const status = await dependencyStatus(makePlan(worktree), {
        mcDir,
        fingerprint,
      });
      assert.equal(status.worktree.state, 'missing');
      assert.equal(status.snapshot.state, 'ready');
      assert.equal(status.recommended_action, 'hydrate-from-snapshot');
      assert.equal(existsSync(join(worktree, 'node_modules')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats a top-level node_modules symlink as unsafe and never follows it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-symlink-'));
    const worktree = join(root, 'worktree');
    const external = join(root, 'external-node-modules');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'keep.txt'), 'keep');
    writePackageInputs(worktree);
    symlinkSync(external, join(worktree, 'node_modules'));
    try {
      const status = await dependencyStatus(makePlan(worktree), {
        mcDir: join(root, 'mc-home'),
        fingerprintOptions: runtime,
      });
      assert.equal(status.worktree.state, 'unsafe-symlink');
      const result = await hydrateDependencies(makePlan(worktree), {
        mcDir: join(root, 'mc-home'),
        fingerprintOptions: runtime,
        deps: { runProcess: async () => assert.fail('unsafe symlink must be refused before install') },
      });
      assert.equal(result.reason, 'existing-unmanaged-node-modules');
      assert.equal(readFileSync(join(external, 'keep.txt'), 'utf8'), 'keep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('never publishes a snapshot when package inputs change during npm ci', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-race-'));
    const worktree = join(root, 'worktree');
    const mcDir = join(root, 'mc-home');
    mkdirSync(worktree, { recursive: true });
    writePackageInputs(worktree);
    try {
      const result = await hydrateDependencies(makePlan(worktree), {
        mcDir,
        fingerprintOptions: runtime,
        deps: {
          platform: 'linux',
          runProcess: async (_argv, options) => {
            mkdirSync(join(options.cwd, 'node_modules'), { recursive: true });
            writePackageInputs(options.cwd, 'changed-during-install');
            return { ok: true, code: 0, stdout: '', stderr: '' };
          },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'dependency-inputs-changed');
      assert.equal(existsSync(join(worktree, 'node_modules', '.mc-dependency-snapshot.json')), false);
      const snapshotsRoot = join(mcDir, 'dependency-snapshots', 'v1', 'npm');
      assert.equal(existsSync(snapshotsRoot), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dependency copy and locking', () => {
  test('requests APFS clone-copy first on Darwin and never creates a symlink', async () => {
    const calls = [];
    const result = await cloneDependencyDirectory('/snapshot/node_modules', '/worktree/node_modules.tmp', {
      platform: 'darwin',
      runProcess: async (argv) => {
        calls.push(argv);
        return { ok: true, code: 0, stdout: '', stderr: '' };
      },
      copy: () => assert.fail('successful APFS clone must not use ordinary copy'),
    });
    assert.deepEqual(calls, [['/bin/cp', '-cR', '/snapshot/node_modules', '/worktree/node_modules.tmp']]);
    assert.equal(result.method, 'apfs-clone');
  });

  test('lock creation is exclusive and release is token-safe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-lock-'));
    const path = join(root, 'fingerprint.lock');
    try {
      const first = await acquireDependencyLock(path, { timeoutMs: 50, pollMs: 5 });
      await assert.rejects(
        acquireDependencyLock(path, { timeoutMs: 20, pollMs: 5 }),
        /timed out waiting for dependency lock/,
      );
      first.release();
      const second = await acquireDependencyLock(path, { timeoutMs: 50, pollMs: 5 });
      assert.equal(second.acquired, true);
      second.release();
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers a crashed lock owner without waiting for the long invalid-lock TTL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deps-dead-lock-'));
    const path = join(root, 'fingerprint.lock');
    try {
      writeFileSync(path, JSON.stringify({ pid: 999_999, token: 'dead-owner' }));
      const acquired = await acquireDependencyLock(path, {
        now: () => Date.now() + 2_000,
        timeoutMs: 50,
        pollMs: 5,
        isAlive: () => false,
      });
      assert.equal(acquired.acquired, true);
      acquired.release();
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

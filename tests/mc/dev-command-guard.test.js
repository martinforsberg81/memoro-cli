import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEV_ENSURE_LAUNCH_ENV,
  isManagedDevCommand,
  prepareDevCommandGuardEnv,
} from '../../src/mc/dev-command-guard.js';

const prefixes = [
  ['npm', 'run', 'dev'],
  ['node', 'scripts/dev.mjs'],
  ['npx', 'wrangler', 'dev'],
];

describe('dev command guard policy', () => {
  test('matches exact declared prefixes and npm dev variants only', () => {
    assert.equal(isManagedDevCommand(['npm', 'run', 'dev'], prefixes), true);
    assert.equal(isManagedDevCommand(['npm', 'run', 'dev', '--', '--port', '3000'], prefixes), true);
    assert.equal(isManagedDevCommand(['npm', 'run', 'dev:quick'], prefixes), true);
    assert.equal(isManagedDevCommand(['node', 'scripts/dev.mjs', '--help'], prefixes), true);
    assert.equal(isManagedDevCommand(['npx', 'wrangler', 'dev'], prefixes), true);
    assert.equal(isManagedDevCommand(['npm', 'test'], prefixes), false);
    assert.equal(isManagedDevCommand(['npx', 'wrangler', 'versions'], prefixes), false);
  });
});

describe('dev command guard installation and runtime', () => {
  test('does nothing when the repository has no dev definition', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-dev-guard-missing-'));
    try {
      const prepared = prepareDevCommandGuardEnv({
        worktreePath: root,
        mcDir: join(root, 'home'),
        baseEnv: { PATH: '/bin', [DEV_ENSURE_LAUNCH_ENV]: '1' },
      });
      assert.equal(prepared.installed, false);
      assert.deepEqual(prepared.env, { PATH: '/bin' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocks direct managed starts while preserving normal commands and the ensure launch', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-dev-guard-'));
    const worktree = join(root, 'repo');
    const child = join(worktree, 'packages', 'web');
    const realBin = join(root, 'real-bin');
    mkdirSync(join(worktree, '.mc'), { recursive: true });
    mkdirSync(child, { recursive: true });
    mkdirSync(realBin, { recursive: true });
    writeFileSync(join(worktree, '.mc', 'dev.json'), JSON.stringify(definition()));
    for (const command of ['npm', 'node', 'npx']) {
      const path = join(realBin, command);
      writeFileSync(path, '#!/bin/sh\nexit 42\n');
      chmodSync(path, 0o700);
    }

    try {
      const prepared = prepareDevCommandGuardEnv({
        worktreePath: worktree,
        mcDir: join(root, 'home'),
        codingSessionId: 'sess_guard',
        baseEnv: { ...process.env, PATH: realBin },
      });
      assert.equal(prepared.installed, true);
      assert.deepEqual(prepared.commands, ['node', 'npm', 'npx']);
      assert.match(prepared.env.MC_DEV_COMMAND_GUARD, /^sha256:/);

      const blocked = spawnSync(join(prepared.dir, 'npm'), ['run', 'dev:quick'], {
        cwd: child,
        env: prepared.env,
        encoding: 'utf8',
      });
      assert.equal(blocked.status, 75);
      assert.match(blocked.stderr, /use `mc dev ensure`/);

      const allowed = spawnSync(join(prepared.dir, 'npm'), ['test'], {
        cwd: worktree,
        env: prepared.env,
        encoding: 'utf8',
      });
      assert.equal(allowed.status, 42);

      const ensureLaunch = spawnSync(join(prepared.dir, 'npm'), ['run', 'dev'], {
        cwd: worktree,
        env: { ...prepared.env, [DEV_ENSURE_LAUNCH_ENV]: '1' },
        encoding: 'utf8',
      });
      assert.equal(ensureLaunch.status, 42);

      const outside = spawnSync(join(prepared.dir, 'npm'), ['run', 'dev'], {
        cwd: root,
        env: prepared.env,
        encoding: 'utf8',
      });
      assert.equal(outside.status, 42);
      assert.equal(prepared.env.PATH, `${prepared.dir}${delimiter}${realBin}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function definition() {
  return {
    schema_version: 1,
    default_service: 'web',
    services: {
      web: {
        default_profile: 'agent',
        profiles: {
          agent: {
            start: { argv: ['npm', 'run', 'dev'] },
            readiness: { kind: 'runtime-manifest', path: '.runtime/dev.json', timeout_ms: 1000 },
          },
        },
        dependencies: {
          manager: 'npm',
          fingerprint_files: ['package.json', 'package-lock.json'],
          install: { argv: ['npm', 'ci'] },
        },
        managed_argv_prefixes: prefixes,
      },
    },
  };
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { describe } from 'node:test';

import {
  GUARD_ENV,
  extractNpxWranglerArgs,
  isAllowedAdminAncestor,
  isAllowedAdminCommandLine,
  isDeniedWranglerCommand,
  prepareCloudflareGuardEnv,
} from '../../src/mc/cloudflare-guard.js';

describe('Cloudflare guard policy', () => {
  test('denies D1 commands that can return row data', () => {
    assert.equal(isDeniedWranglerCommand(['d1', 'execute', 'memoro-db', '--remote']), true);
    assert.equal(isDeniedWranglerCommand(['d1', 'export', 'memoro-db']), true);
    assert.equal(isDeniedWranglerCommand(['d1', 'backup', 'memoro-db']), true);
    assert.equal(isDeniedWranglerCommand(['d1', 'time-travel', 'restore']), true);
  });

  test('allows D1 schema/admin commands unless they target remote production apply', () => {
    assert.equal(isDeniedWranglerCommand(['d1', 'migrations', 'list', 'memoro-db']), false);
    assert.equal(isDeniedWranglerCommand(['d1', 'info', 'memoro-db']), false);
    assert.equal(isDeniedWranglerCommand(['d1', 'migrations', 'apply', 'memoro-db', '--local']), false);
    assert.equal(isDeniedWranglerCommand(['d1', 'migrations', 'apply', 'memoro-db', '--remote']), true);
    assert.equal(isDeniedWranglerCommand(['--env', 'production', 'd1', 'migrations', 'apply', 'memoro-db']), true);
  });

  test('denies R2/KV/log/secret surfaces that expose data', () => {
    assert.equal(isDeniedWranglerCommand(['r2', 'object', 'get', 'bucket/key']), true);
    assert.equal(isDeniedWranglerCommand(['r2', 'object', 'list', 'bucket']), true);
    assert.equal(isDeniedWranglerCommand(['kv', 'key', 'get', 'KEY']), true);
    assert.equal(isDeniedWranglerCommand(['kv', 'bulk', 'get']), true);
    assert.equal(isDeniedWranglerCommand(['tail']), true);
    assert.equal(isDeniedWranglerCommand(['dev', '--remote']), true);
    assert.equal(isDeniedWranglerCommand(['secret', 'list']), true);
    assert.equal(isDeniedWranglerCommand(['queues', 'consumer', 'tail']), true);
    assert.equal(isDeniedWranglerCommand(['vectorize', 'query', 'idx']), true);
  });

  test('parses npx wrangler invocations', () => {
    assert.deepEqual(extractNpxWranglerArgs(['wrangler', 'd1', 'execute']), ['d1', 'execute']);
    assert.deepEqual(extractNpxWranglerArgs(['--yes', 'wrangler@latest', 'r2', 'object', 'get']), ['r2', 'object', 'get']);
    assert.deepEqual(extractNpxWranglerArgs(['--package', 'wrangler', 'wrangler', 'tail']), ['tail']);
    assert.equal(extractNpxWranglerArgs(['eslint', '.']), null);
  });

  test('recognises approved admin script ancestors', () => {
    assert.equal(isAllowedAdminCommandLine('node scripts/admin/my-recent-items.mjs --limit 5'), true);
    assert.equal(isAllowedAdminCommandLine('/opt/homebrew/bin/node /repo/scripts/admin/aggregate-test-users.mjs'), true);
    assert.equal(isAllowedAdminCommandLine('node scripts/admin/inspect-user.mjs'), true);
    assert.equal(isAllowedAdminCommandLine('node scripts/admin/list-all-users.mjs'), false);
    assert.equal(isAllowedAdminCommandLine('node -e "spawn wrangler"'), false);
    assert.equal(isAllowedAdminCommandLine('node -e "spawn wrangler" scripts/admin/my-item.mjs'), false);
  });

  test('walks ancestor process commands through injected ps', () => {
    const seen = new Map([
      ['10:command=', 'node -e test'],
      ['10:ppid=', '9'],
      ['9:command=', 'node scripts/admin/my-item.mjs --item-id x'],
      ['9:ppid=', '1'],
    ]);
    assert.equal(isAllowedAdminAncestor({
      pid: 10,
      ps: (pid, field) => seen.get(`${pid}:${field}`) || '',
    }), true);
  });
});

describe('Cloudflare guard runtime shim', () => {
  test('installs guard commands and prepends PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-cf-guard-'));
    try {
      const res = prepareCloudflareGuardEnv({
        mcDir: dir,
        codingSessionId: 'sess/A B',
        baseEnv: { PATH: '/usr/bin' },
      });
      assert.equal(res.env[GUARD_ENV], 'codex');
      assert.ok(res.env.PATH.startsWith(res.dir + delimiter));
      assert.match(res.dir, /sess_A_B$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('blocks denied wrangler commands before the real binary runs', () => {
    const fixture = setupRuntimeFixture();
    try {
      const result = spawnSync(join(fixture.guardDir, 'wrangler'), ['d1', 'execute', 'memoro-db', '--remote'], {
        env: fixture.env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 126);
      assert.match(result.stderr, /blocked direct Cloudflare data access/);
      assert.equal(result.stdout, '');
    } finally {
      fixture.cleanup();
    }
  });

  test('passes allowed wrangler commands to the real binary', () => {
    const fixture = setupRuntimeFixture();
    try {
      const result = spawnSync(join(fixture.guardDir, 'wrangler'), ['d1', 'migrations', 'list', 'memoro-db'], {
        env: fixture.env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /real-wrangler d1 migrations list memoro-db/);
    } finally {
      fixture.cleanup();
    }
  });

  test('blocks npx wrangler commands before the real npx runs', () => {
    const fixture = setupRuntimeFixture();
    try {
      const result = spawnSync(join(fixture.guardDir, 'npx'), ['--yes', 'wrangler', 'r2', 'object', 'get', 'bucket/key'], {
        env: fixture.env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 126);
      assert.match(result.stderr, /blocked direct Cloudflare data access/);
    } finally {
      fixture.cleanup();
    }
  });
});

function setupRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-cf-runtime-'));
  const realBin = join(root, 'real-bin');
  const mcDir = join(root, 'mc-home');
  mkdirSync(realBin, { recursive: true });
  writeExecutable(join(realBin, 'wrangler'), '#!/bin/sh\nprintf "real-wrangler %s\\n" "$*"\n');
  writeExecutable(join(realBin, 'npx'), '#!/bin/sh\nprintf "real-npx %s\\n" "$*"\n');
  const prepared = prepareCloudflareGuardEnv({
    mcDir,
    codingSessionId: 'sess_test',
    baseEnv: {
      ...process.env,
      PATH: `${realBin}${delimiter}${process.env.PATH || ''}`,
    },
  });
  return {
    guardDir: prepared.dir,
    env: prepared.env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

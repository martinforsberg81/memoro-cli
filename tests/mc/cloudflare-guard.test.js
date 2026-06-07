import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { describe } from 'node:test';

import {
  GUARD_ENV,
  approvedScriptsFromEffectiveConfig,
  extractNpxWranglerArgs,
  isAllowedAdminAncestor,
  isAllowedAdminCommandLine,
  isDeniedWranglerCommand,
  normaliseApprovedScriptSpecs,
  prepareCloudflareGuardEnv,
  renderCloudflareGuardScript,
} from '../../src/mc/cloudflare-guard.js';

const APPROVED_SCRIPTS = Object.freeze([
  { command: 'node', args: ['scripts/admin/my-*.mjs'] },
  { command: '/opt/homebrew/bin/node', args: ['scripts/admin/aggregate-*.mjs'] },
  'node scripts/admin/inspect-*.mjs',
]);

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

  test('requires repo-approved admin scripts for ancestor bypass', () => {
    assert.equal(isAllowedAdminCommandLine('node scripts/admin/my-recent-items.mjs --limit 5'), false);
    assert.equal(isAllowedAdminCommandLine('node scripts/admin/my-recent-items.mjs --limit 5', {
      approvedScripts: APPROVED_SCRIPTS,
    }), true);
    assert.equal(isAllowedAdminCommandLine('/opt/homebrew/bin/node /repo/scripts/admin/aggregate-test-users.mjs', {
      approvedScripts: APPROVED_SCRIPTS,
    }), true);
    assert.equal(isAllowedAdminCommandLine('node scripts/admin/inspect-user.mjs', {
      approvedScripts: APPROVED_SCRIPTS,
    }), true);
    assert.equal(isAllowedAdminCommandLine('node scripts/admin/list-all-users.mjs', {
      approvedScripts: APPROVED_SCRIPTS,
    }), false);
    assert.equal(isAllowedAdminCommandLine('node other.mjs scripts/admin/my-item.mjs', {
      approvedScripts: APPROVED_SCRIPTS,
    }), false);
    assert.equal(isAllowedAdminCommandLine('node -e "spawn wrangler"', {
      approvedScripts: APPROVED_SCRIPTS,
    }), false);
    assert.equal(isAllowedAdminCommandLine('node -e "spawn wrangler" scripts/admin/my-item.mjs', {
      approvedScripts: APPROVED_SCRIPTS,
    }), false);
  });

  test('normalises approved script policy from config shapes', () => {
    assert.deepEqual(normaliseApprovedScriptSpecs([
      { command: 'node', args: ['scripts/admin/my-*.mjs'] },
      'node --loader tsx scripts/admin/inspect-*.mjs',
      { command: 'bash', args: ['scripts/admin/nope.sh'] },
      { command: 'node', args: ['-e', 'scripts/admin/nope.mjs'] },
      null,
    ]), [
      { command: 'node', script: 'scripts/admin/my-*.mjs' },
      { command: 'node', script: 'scripts/admin/inspect-*.mjs' },
    ]);
    assert.deepEqual(approvedScriptsFromEffectiveConfig({
      dataAccess: {
        cloudflare: {
          approvedScripts: {
            value: ['node scripts/admin/my-*.mjs'],
          },
        },
      },
    }), [
      { command: 'node', script: 'scripts/admin/my-*.mjs' },
    ]);
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
      approvedScripts: APPROVED_SCRIPTS,
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
        approvedScripts: APPROVED_SCRIPTS,
      });
      assert.equal(res.env[GUARD_ENV], 'codex');
      assert.ok(res.env.PATH.startsWith(res.dir + delimiter));
      assert.match(res.dir, /sess_A_B$/);
      assert.match(readFileSync(join(res.dir, 'wrangler'), 'utf8'), /scripts\/admin\/my-\*\.mjs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('renders no hardcoded repo admin script allowlist by default', () => {
    const script = renderCloudflareGuardScript();
    assert.doesNotMatch(script, /scripts\/admin\/\{my/);
    assert.doesNotMatch(script, /aggregate-\[\^/);
    assert.equal(isAllowedAdminCommandLine('node scripts/admin/my-item.mjs'), false);
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

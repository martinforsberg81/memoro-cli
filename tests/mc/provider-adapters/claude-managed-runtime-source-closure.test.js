import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  verifyInstalledManagedClaudeRuntimeSourceClosure,
} from '../../../src/mc/provider-adapters/claude-managed-runtime-source-closure.js';
import {
  parseHostArgv,
} from '../../../src/mc/provider-adapters/claude-managed-runtime-host.js';

test('managed Claude runtime source graph matches its fixed closure', () => {
  assert.deepEqual(verifyInstalledManagedClaudeRuntimeSourceClosure(), {
    ok: true,
    code: 'managed-claude-runtime-source-verified',
  });
  const checked = spawnSync(process.execPath, [
    'scripts/security/check-managed-claude-runtime-source-closure.mjs',
  ], {
    cwd: new URL('../../../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /verified \(22 files\)/);
});

test('managed Claude host pins its verifier and accepts only one fixed manifest slot', () => {
  const host = readFileSync(
    new URL('../../../src/mc/provider-adapters/claude-managed-runtime-host.js', import.meta.url),
    'utf8',
  );
  const closure = readFileSync(
    new URL('../../../src/mc/provider-adapters/claude-managed-runtime-source-closure.js', import.meta.url),
  );
  const pinned = host.match(
    /const SOURCE_CLOSURE_SHA256 =\s*'([a-f0-9]{64})';/u,
  )?.[1];
  assert.equal(
    pinned,
    createHash('sha256').update(closure).digest('hex'),
  );
  assert.deepEqual(parseHostArgv([
    '--manifest',
    '/managed/manifest.json',
    '--',
    '--resume',
    'native-session',
  ]), {
    manifestPath: '/managed/manifest.json',
    providerArgv: ['--resume', 'native-session'],
  });
  assert.equal(parseHostArgv([
    '--manifest',
    'relative.json',
    '--',
  ]), null);
});

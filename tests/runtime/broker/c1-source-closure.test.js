import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  verifyC1SourceClosureFixture,
  verifyInstalledC1SourceClosure,
} from '../../../src/runtime/broker/c1-source-closure.js';

test('installed C1 source closure matches its fixed release manifest', () => {
  assert.deepEqual(verifyInstalledC1SourceClosure(), {
    ok: true,
    code: 'c1-source-closure-verified',
  });
});

test('C1 release graph contains every transitive local source edge', () => {
  const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const output = execFileSync(
    process.execPath,
    ['scripts/security/check-c1-source-closure.mjs'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  assert.match(output, /^C1 source closure verified \(18 files\)\n$/u);
});

test('C1 source closure rejects tamper, missing files, symlinks, and writable source paths', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-c1-source-')));
  const sourceDir = join(root, 'src');
  const sourcePath = join(sourceDir, 'entry.js');
  const secondPath = join(sourceDir, 'dependency.js');
  mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  writeFileSync(sourcePath, 'export const entry = true;\n', { mode: 0o600 });
  writeFileSync(secondPath, 'export const dependency = true;\n', { mode: 0o600 });
  const expected = {
    'src/dependency.js': sha256('export const dependency = true;\n'),
    'src/entry.js': sha256('export const entry = true;\n'),
  };
  try {
    assert.equal(verifyC1SourceClosureFixture({ packageRoot: root, expected }).ok, true);

    writeFileSync(secondPath, 'export const dependency = false;\n', { mode: 0o600 });
    assert.equal(verifyC1SourceClosureFixture({ packageRoot: root, expected }).ok, false);
    writeFileSync(secondPath, 'export const dependency = true;\n', { mode: 0o600 });

    chmodSync(sourceDir, 0o770);
    assert.equal(verifyC1SourceClosureFixture({ packageRoot: root, expected }).ok, false);
    chmodSync(sourceDir, 0o700);

    chmodSync(secondPath, 0o622);
    assert.equal(verifyC1SourceClosureFixture({ packageRoot: root, expected }).ok, false);
    chmodSync(secondPath, 0o600);

    rmSync(secondPath);
    assert.equal(verifyC1SourceClosureFixture({ packageRoot: root, expected }).ok, false);
    symlinkSync(sourcePath, secondPath);
    assert.equal(verifyC1SourceClosureFixture({ packageRoot: root, expected }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C1 source closure rejects traversal and malformed digest manifests', () => {
  assert.equal(verifyC1SourceClosureFixture({
    packageRoot: '/private/tmp',
    expected: { '../outside.js': 'a'.repeat(64) },
  }).ok, false);
  assert.equal(verifyC1SourceClosureFixture({
    packageRoot: '/private/tmp',
    expected: { 'inside.js': 'not-a-digest' },
  }).ok, false);
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

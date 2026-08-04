import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  localSourcePath,
  resolveLocalSourceSync,
} from '../../src/mc/local-source.js';
import { createSessionHomeSync } from '../../src/mc/session-home.js';

let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('mints one immutable machine source identity and reuses it', () => {
  const mcHomeDir = home();
  const first = resolveLocalSourceSync({
    mcHomeDir,
    random: () => Buffer.alloc(12, 0xab),
    now: () => '2026-08-03T10:00:00.000Z',
  });
  const before = readFileSync(localSourcePath(mcHomeDir), 'utf8');
  const second = resolveLocalSourceSync({
    mcHomeDir,
    random: () => Buffer.alloc(12, 0xcd),
    now: () => '2026-08-03T11:00:00.000Z',
  });
  assert.deepEqual(second, first);
  assert.equal(first.source_id, `machine_${'ab'.repeat(12)}`);
  assert.equal(readFileSync(localSourcePath(mcHomeDir), 'utf8'), before);
});

test('adopts the sole existing session-home owner during cutover', () => {
  const mcHomeDir = home();
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId: 'mcs_000000000000000000000001',
    sourceId: 'machine_existing',
    name: 'alpha',
  });
  assert.equal(resolveLocalSourceSync({ mcHomeDir }).source_id, 'machine_existing');
});

test('fails closed on ambiguous or corrupt local source authority', () => {
  const mcHomeDir = home();
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId: 'mcs_000000000000000000000001',
    sourceId: 'machine_one',
    name: 'alpha',
  });
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId: 'mcs_000000000000000000000002',
    sourceId: 'machine_two',
    name: 'beta',
  });
  assert.throws(() => resolveLocalSourceSync({ mcHomeDir }),
    (error) => error.reason === 'multiple-machine-sources');

  const other = home();
  resolveLocalSourceSync({ mcHomeDir: other });
  writeFileSync(localSourcePath(other), '{bad-json', { mode: 0o600 });
  assert.throws(() => resolveLocalSourceSync({ mcHomeDir: other }),
    (error) => error.code === 'MC_LOCAL_SOURCE_ERROR');
});

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-local-source-'));
  roots.push(root);
  return root;
}

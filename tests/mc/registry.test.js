import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  patchEntriesIfPresent,
  readRegistry,
  upsertEntry,
} from '../../src/mc/registry.js';

let tempHome = null;
const originalMcHome = process.env.MC_HOME;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
  if (originalMcHome === undefined) delete process.env.MC_HOME;
  else process.env.MC_HOME = originalMcHome;
});

test('new registry entries default to the package default tool', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-default-'));
  process.env.MC_HOME = tempHome;

  const entry = upsertEntry({ name: 'implicit-tool' });

  assert.equal(entry.tool, 'codex');
});

test('patchEntriesIfPresent updates atomically without resurrecting missing entries', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-patch-'));
  process.env.MC_HOME = tempHome;
  upsertEntry({ name: 'present', branch: 'sess/present' });

  const missing = patchEntriesIfPresent([
    { name: 'present', tool_session_id: 'session_present' },
    { name: 'already-removed', tool_session_id: 'session_removed' },
  ]);

  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['already-removed']);
  assert.equal(readRegistry().entries.length, 1);
  assert.equal(readRegistry().entries[0].tool_session_id, null);

  const updated = patchEntriesIfPresent([
    { name: 'present', tool_session_id: 'session_present' },
  ]);
  assert.equal(updated.ok, true);
  assert.equal(readRegistry().entries[0].tool_session_id, 'session_present');
});

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { upsertEntry } from '../../src/mc/registry.js';

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

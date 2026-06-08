import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installHooks, uninstallHooks } from '../../src/adapters/codex.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'memoro-codex-hooks-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('codex adapter — raw hook lifecycle', () => {
  test('installHooks does not create a raw codex shim', async () => withTempDir(async (dir) => {
    const launcherPath = join(dir, 'codex-memoro');
    const shimPath = join(dir, 'codex');

    const result = await installHooks({ launcherPath, shimPath });

    assert.equal(result.skipped, true);
    assert.match(result.reason, /no longer wrapped/);
    assert.equal(existsSync(launcherPath), false);
    assert.equal(existsSync(shimPath), false);
  }));

  test('uninstallHooks removes legacy memoro codex shims only', async () => withTempDir(async (dir) => {
    const launcherPath = join(dir, 'codex-memoro');
    const shimPath = join(dir, 'codex');
    writeFileSync(
      launcherPath,
      '#!/bin/sh\nexec memoro-cli codex run --real-codex \'/opt/homebrew/bin/codex\' -- "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      shimPath,
      `#!/bin/sh\nexec '${launcherPath}' "$@"\n`,
      { mode: 0o755 },
    );

    const result = await uninstallHooks({ launcherPath, shimPath });

    assert.deepEqual(result.removed.sort(), [launcherPath, shimPath].sort());
    assert.equal(existsSync(launcherPath), false);
    assert.equal(existsSync(shimPath), false);
  }));

  test('uninstallHooks leaves unrelated codex files untouched', async () => withTempDir(async (dir) => {
    const launcherPath = join(dir, 'codex-memoro');
    const shimPath = join(dir, 'codex');
    writeFileSync(shimPath, '#!/bin/sh\necho real codex\n', { mode: 0o755 });

    const result = await uninstallHooks({ launcherPath, shimPath });

    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(shimPath), true);
  }));
});

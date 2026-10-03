import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { uninstallHooks } from '../../src/adapters/codex.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'memoro-codex-hooks-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('codex adapter — official hook lifecycle', () => {
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

    const result = await uninstallHooks({ launcherPath, shimPath, configPath: join(dir, '.codex', 'hooks.json') });

    assert.deepEqual(result.removed.sort(), [launcherPath, shimPath].sort());
    assert.equal(existsSync(launcherPath), false);
    assert.equal(existsSync(shimPath), false);
  }));

  test('uninstallHooks leaves unrelated codex files untouched', async () => withTempDir(async (dir) => {
    const launcherPath = join(dir, 'codex-memoro');
    const shimPath = join(dir, 'codex');
    writeFileSync(shimPath, '#!/bin/sh\necho real codex\n', { mode: 0o755 });

    const result = await uninstallHooks({ launcherPath, shimPath, configPath: join(dir, '.codex', 'hooks.json') });

    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(shimPath), true);
  }));

  test('uninstall removes only the marked SessionStart entry', async () => withTempDir(async (dir) => {
    const configPath = join(dir, '.codex', 'hooks.json');
    mkdirSync(join(dir, '.codex'), { mode: 0o700 });
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'user-start' }] },
          { _memoro: 'memoro-cli', matcher: 'startup|resume', hooks: [{ type: 'command', command: 'memoro-cli provider-artifact capture --tool codex' }] },
        ],
      },
    }), { mode: 0o600 });
    const result = await uninstallHooks({ configPath, launcherPath: join(dir, 'missing-launcher'), shimPath: join(dir, 'missing-shim') });
    assert.deepEqual(result.removed, [configPath]);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'user-start' }] }] },
    });
  }));
});

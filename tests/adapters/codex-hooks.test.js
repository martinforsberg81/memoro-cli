import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installHooks, uninstallHooks } from '../../src/adapters/codex.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'memoro-codex-hooks-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('codex adapter — official hook lifecycle', () => {
  test('installs one marked SessionStart hook without creating a raw codex shim', async () => withTempDir(async (dir) => {
    const launcherPath = join(dir, 'codex-memoro');
    const shimPath = join(dir, 'codex');
    const configPath = join(dir, '.codex', 'hooks.json');

    const result = await installHooks({ configPath });

    assert.equal(result.configPath, configPath);
    assert.equal(existsSync(launcherPath), false);
    assert.equal(existsSync(shimPath), false);
    assert.equal(statSync(join(dir, '.codex')).mode & 0o777, 0o700);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      hooks: {
        SessionStart: [{
          _memoro: 'memoro-cli',
          matcher: 'startup|resume',
          hooks: [{ type: 'command', command: 'memoro-cli provider-artifact capture --tool codex' }],
        }],
      },
    });
  }));

  test('preserves user hooks and replaces only the marked hook idempotently', async () => withTempDir(async (dir) => {
    const configPath = join(dir, '.codex', 'hooks.json');
    mkdirSync(join(dir, '.codex'), { mode: 0o700 });
    writeFileSync(configPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'user-pre-tool' }] }],
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'user-start' }] },
          { _memoro: 'memoro-cli', matcher: 'startup', hooks: [{ type: 'command', command: 'old memoro command' }] },
        ],
      },
      user_setting: true,
    }), { mode: 0o600 });

    await installHooks({ configPath, memoroCliBin: '/opt/memoro-cli' });
    await installHooks({ configPath, memoroCliBin: '/opt/memoro-cli' });

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.user_setting, true);
    assert.deepEqual(config.hooks.PreToolUse, [{ matcher: 'shell', hooks: [{ type: 'command', command: 'user-pre-tool' }] }]);
    assert.deepEqual(config.hooks.SessionStart, [
      { matcher: 'startup', hooks: [{ type: 'command', command: 'user-start' }] },
      {
        _memoro: 'memoro-cli', matcher: 'startup|resume',
        hooks: [{ type: 'command', command: '/opt/memoro-cli provider-artifact capture --tool codex' }],
      },
    ]);
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

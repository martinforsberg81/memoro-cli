import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, lstatSync, readlinkSync, symlinkSync,
} from 'node:fs';
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

  test('uninstall drops an emptied SessionStart and keeps other events and top-level keys', async () => withTempDir(async (dir) => {
    const configPath = join(dir, '.codex', 'hooks.json');
    mkdirSync(join(dir, '.codex'), { mode: 0o700 });
    const stopEntry = { matcher: 'stop', hooks: [{ type: 'command', command: 'user-stop' }] };
    writeFileSync(configPath, JSON.stringify({
      theme: 'x',
      hooks: {
        SessionStart: [
          { _memoro: 'memoro-cli', matcher: 'startup|resume', hooks: [{ type: 'command', command: 'memoro-cli provider-artifact capture --tool codex' }] },
        ],
        Stop: [stopEntry],
      },
    }), { mode: 0o600 });
    const result = await uninstallHooks({ configPath, launcherPath: join(dir, 'missing-launcher'), shimPath: join(dir, 'missing-shim') });
    assert.deepEqual(result.removed, [configPath]);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { theme: 'x', hooks: { Stop: [stopEntry] } });
  }));

  const rejectedConfigs = [
    ['malformed JSON', '{"hooks": ', { message: /^Codex hooks\.json is invalid JSON: / }],
    ['hooks as an array', JSON.stringify({ hooks: [] }), { message: 'Codex hooks.json hooks must be an object' }],
    ['hooks as a string', JSON.stringify({ hooks: 'x' }), { message: 'Codex hooks.json hooks must be an object' }],
    ['SessionStart as a non-array object', JSON.stringify({ hooks: { SessionStart: { _memoro: 'memoro-cli' } } }), { message: 'Codex hooks.json hooks.SessionStart must be an array' }],
  ];
  for (const [name, text, expected] of rejectedConfigs) {
    test(`uninstall rejects ${name} and leaves hooks.json bytes unchanged`, async () => withTempDir(async (dir) => {
      const configPath = join(dir, '.codex', 'hooks.json');
      mkdirSync(join(dir, '.codex'), { mode: 0o700 });
      const bytes = Buffer.from(text, 'utf8');
      writeFileSync(configPath, bytes, { mode: 0o600 });
      await assert.rejects(
        uninstallHooks({ configPath, launcherPath: join(dir, 'missing-launcher'), shimPath: join(dir, 'missing-shim') }),
        expected,
      );
      assert.deepEqual(readFileSync(configPath), bytes);
    }));
  }

  test('uninstall refuses a symlinked hooks.json and leaves the link and its target untouched', async () => withTempDir(async (dir) => {
    const configPath = join(dir, '.codex', 'hooks.json');
    const targetPath = join(dir, 'target-hooks.json');
    mkdirSync(join(dir, '.codex'), { mode: 0o700 });
    const targetBytes = Buffer.from(JSON.stringify({
      hooks: { SessionStart: [{ _memoro: 'memoro-cli', hooks: [] }] },
    }), 'utf8');
    writeFileSync(targetPath, targetBytes, { mode: 0o600 });
    symlinkSync(targetPath, configPath);
    await assert.rejects(
      uninstallHooks({ configPath, launcherPath: join(dir, 'missing-launcher'), shimPath: join(dir, 'missing-shim') }),
      { message: 'Codex hooks.json is unsafe' },
    );
    assert.equal(lstatSync(configPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(configPath), targetPath);
    assert.deepEqual(readFileSync(targetPath), targetBytes);
  }));
});

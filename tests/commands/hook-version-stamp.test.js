/**
 * Tests for the version-stamping + update-command install behaviour added
 * to the claude-code adapter.
 *
 * Sandboxes HOME so the real ~/.claude/settings.json is never touched.
 */

import assert from 'node:assert/strict';
import test, { describe, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installHooks,
  readInstalledHookVersion,
  installUpdateCommand,
  uninstallHooks,
  uninstallCommands,
} from '../../src/adapters/claude-code.js';
import { getPackageVersion } from '../../src/lib/version.js';

let sandbox;
let originalHome;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'memoro-hook-stamp-'));
  originalHome = process.env.HOME;
  process.env.HOME = sandbox;
});

after(() => {
  process.env.HOME = originalHome;
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  // Wipe ~/.claude between tests so each starts from a clean slate.
  try { rmSync(join(sandbox, '.claude'), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('claude-code adapter — hook version stamp', () => {
  test('installHooks writes _memoro_version on every managed entry', async () => {
    await installHooks({ memoroCliBin: 'memoro-cli' });
    const settings = JSON.parse(readFileSync(join(sandbox, '.claude', 'settings.json'), 'utf8'));
    const expected = await getPackageVersion();

    const start = settings.hooks.SessionStart.find(h => h._memoro === 'memoro-cli');
    const end   = settings.hooks.SessionEnd.find(h => h._memoro === 'memoro-cli');
    assert.equal(start._memoro_version, expected);
    assert.equal(end._memoro_version, expected);
  });

  test('readInstalledHookVersion returns the stamped version', async () => {
    await installHooks({ memoroCliBin: 'memoro-cli' });
    const v = await readInstalledHookVersion();
    assert.equal(v, await getPackageVersion());
  });

  test('readInstalledHookVersion returns null when no settings.json exists', async () => {
    // beforeEach wiped ~/.claude.
    const v = await readInstalledHookVersion();
    assert.equal(v, null);
  });

  test('readInstalledHookVersion returns null when an older install left no stamp', async () => {
    // Simulate a pre-stamp install: a memoro block without _memoro_version.
    mkdirSync(join(sandbox, '.claude'), { recursive: true });
    writeFileSync(
      join(sandbox, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { _memoro: 'memoro-cli', hooks: [{ type: 'command', command: 'memoro-cli lens pull' }] },
          ],
        },
      }),
    );
    const v = await readInstalledHookVersion();
    assert.equal(v, null);
  });

  test('re-installing replaces the stamp instead of duplicating entries', async () => {
    await installHooks({ memoroCliBin: 'memoro-cli' });
    await installHooks({ memoroCliBin: 'memoro-cli' });
    const settings = JSON.parse(readFileSync(join(sandbox, '.claude', 'settings.json'), 'utf8'));
    const startEntries = settings.hooks.SessionStart.filter(h => h._memoro === 'memoro-cli');
    const endEntries   = settings.hooks.SessionEnd.filter(h => h._memoro === 'memoro-cli');
    assert.equal(startEntries.length, 1);
    assert.equal(endEntries.length, 1);
  });

  test('uninstallHooks removes the stamped entry', async () => {
    await installHooks({ memoroCliBin: 'memoro-cli' });
    await uninstallHooks();
    const v = await readInstalledHookVersion();
    assert.equal(v, null);
  });
});

describe('claude-code adapter — /memoro-update slash command', () => {
  test('installUpdateCommand writes the recipe file with the managed marker', async () => {
    const file = await installUpdateCommand({ memoroCliBin: 'memoro-cli' });
    assert.ok(file.endsWith('memoro-update.md'));
    assert.ok(existsSync(file));

    const body = readFileSync(file, 'utf8');
    assert.match(body, /memoro:managed:command/);
    assert.match(body, /description:/);
    // The recipe must surface both steps.
    assert.match(body, /npm install -g memoro-cli/);
    assert.match(body, /memoro-cli hook install --tool claude-code/);
    // No leading `!` — the body is a prompt, not an auto-exec line.
    assert.equal(body.includes('\n!'), false, 'update slash command must not auto-execute');
    // The body must clearly tell the LLM not to run the recipe — `npm
    // install -g` is sanctioned global persistence and auto-mode will
    // (correctly) block it.
    assert.match(body, /[Dd]isplay/);
    assert.match(body, /do not (try to )?run/i);
  });

  test('installUpdateCommand is idempotent (overwrites cleanly)', async () => {
    const a = await installUpdateCommand({ memoroCliBin: 'memoro-cli' });
    const b = await installUpdateCommand({ memoroCliBin: 'memoro-cli' });
    assert.equal(a, b);
    assert.ok(existsSync(a));
  });

  test('uninstallCommands sweeps memoro-update.md by managed marker', async () => {
    await installUpdateCommand({ memoroCliBin: 'memoro-cli' });
    const removed = await uninstallCommands();
    assert.ok(removed.some(p => p.endsWith('memoro-update.md')));
    assert.ok(!existsSync(join(sandbox, '.claude', 'commands', 'memoro-update.md')));
  });

  test('honours a custom memoroCliBin', async () => {
    const file = await installUpdateCommand({ memoroCliBin: '/usr/local/bin/memoro-cli' });
    const body = readFileSync(file, 'utf8');
    // The hook-install step is rendered against the resolved binary path so
    // an alternate global install location still points to the right tool.
    assert.match(body, /\/usr\/local\/bin\/memoro-cli hook install/);
  });
});

/**
 * Tests for the claude-code adapter's slash-command install/uninstall.
 *
 * Sandboxes HOME so tests don't touch the real ~/.claude/commands/.
 */

import assert from 'node:assert/strict';
import test, { describe, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installCommands, uninstallCommands } from '../src/adapters/claude-code.js';

let sandbox;
let originalHome;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'memoro-cli-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = sandbox;
});

after(() => {
  process.env.HOME = originalHome;
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  const commandsDir = join(sandbox, '.claude', 'commands');
  try { rmSync(commandsDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('claude-code adapter — slash command install', () => {
  test('writes one .md file per section with the managed marker', async () => {
    const written = await installCommands({
      memoroCliBin: 'memoro-cli',
      sections: ['loose-ends', 'decisions'],
    });

    assert.equal(written.length, 2);

    const looseEnds = readFileSync(join(sandbox, '.claude', 'commands', 'memoro-loose-ends.md'), 'utf8');
    assert.match(looseEnds, /memoro:managed:command/);
    assert.match(looseEnds, /!memoro-cli show loose-ends/);
    assert.match(looseEnds, /description:/);

    const decisions = readFileSync(join(sandbox, '.claude', 'commands', 'memoro-decisions.md'), 'utf8');
    assert.match(decisions, /!memoro-cli show decisions/);
  });

  test('uninstall removes only files carrying the managed marker', async () => {
    await installCommands({
      memoroCliBin: 'memoro-cli',
      sections: ['loose-ends', 'rules'],
    });

    // User also dropped a hand-authored slash command with the memoro- prefix
    // — no managed marker, so uninstall must leave it alone.
    const userFile = join(sandbox, '.claude', 'commands', 'memoro-notes.md');
    writeFileSync(userFile, '# My own notes command\n\n!echo hi\n');

    const removed = await uninstallCommands();
    assert.equal(removed.length, 2);

    assert.ok(existsSync(userFile), 'user-authored file must survive uninstall');
    assert.ok(!existsSync(join(sandbox, '.claude', 'commands', 'memoro-loose-ends.md')));
    assert.ok(!existsSync(join(sandbox, '.claude', 'commands', 'memoro-rules.md')));
  });

  test('uninstall is a no-op when commands dir does not exist', async () => {
    const removed = await uninstallCommands();
    assert.deepEqual(removed, []);
  });

  test('install with empty sections writes nothing', async () => {
    const written = await installCommands({ sections: [] });
    assert.deepEqual(written, []);
    const commandsDir = join(sandbox, '.claude', 'commands');
    if (existsSync(commandsDir)) {
      assert.equal(readdirSync(commandsDir).length, 0);
    }
  });
});

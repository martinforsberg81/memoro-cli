import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { __test__, ensureCoordinatorSlashCommand } from '../../src/mc/coordinator-command.js';

describe('coordinator slash command body', () => {
  test('carries the managed marker so hook uninstall can clean it up', () => {
    assert.ok(__test__.COMMAND_BODY.includes(__test__.COMMAND_MARKER));
  });

  test('runs `mc sessions list` on slash-command invocation', () => {
    assert.match(__test__.COMMAND_BODY, /!\s*mc sessions list/);
  });

  test('instructs the LLM to present sessions as a numbered list', () => {
    assert.match(__test__.COMMAND_BODY, /numbered list/i);
  });

  test('documents the three coordinator actions with label-or-id', () => {
    assert.match(__test__.COMMAND_BODY, /mc sessions list/);
    assert.match(__test__.COMMAND_BODY, /mc sessions read <label\|id>/);
    assert.match(__test__.COMMAND_BODY, /mc sessions send <label\|id>/);
  });

  test('teaches the LLM to flag PAUSED sessions explicitly', () => {
    assert.match(__test__.COMMAND_BODY, /PAUSED/);
  });

  test('points users at /memoro-coordinator-suggest for next-step recs', () => {
    assert.match(__test__.COMMAND_BODY, /\/memoro-coordinator-suggest/);
  });

  test('points users at /mc map for map reconciliation', () => {
    assert.match(__test__.COMMAND_BODY, /\/mc map/);
    assert.doesNotMatch(__test__.COMMAND_BODY, /\/memoro-map/);
  });

  test('has the required frontmatter description', () => {
    assert.match(__test__.COMMAND_BODY, /^---\ndescription:/);
  });
});

describe('coordinator-suggest slash command body', () => {
  test('carries the managed marker', () => {
    assert.ok(__test__.COMMAND_BODY_SUGGEST.includes(__test__.COMMAND_MARKER));
  });

  test('runs `mc sessions list` on invocation', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /!\s*mc sessions list/);
  });

  test('instructs the LLM to call mc sessions read per session', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /mc sessions read/);
  });

  test('requires numbered-list output with Doing + Next lines', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /numbered list/i);
    assert.match(__test__.COMMAND_BODY_SUGGEST, /Doing:/);
    assert.match(__test__.COMMAND_BODY_SUGGEST, /Next:/);
  });

  test('forbids the LLM from dispatching on its own', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /[Dd]o not dispatch/);
  });

  test('asks for a prioritisation at the end', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /prioritis/i);
  });
});

describe('/mc map slash command body', () => {
  test('carries the managed marker and frontmatter', () => {
    assert.ok(__test__.COMMAND_BODY_MAP.includes(__test__.COMMAND_MARKER));
    assert.match(__test__.COMMAND_BODY_MAP, /^---\ndescription:/);
  });

  test('implements the /mc map in-session habit', () => {
    assert.match(__test__.COMMAND_BODY_MAP, /\/mc map/);
    assert.match(__test__.COMMAND_BODY_MAP, /\$ARGUMENTS/);
    assert.match(__test__.COMMAND_BODY_MAP, /only `\/mc map`/);
    assert.match(__test__.COMMAND_BODY_MAP, /Update `MEMORO\.md` if the roadmap needs it/);
    assert.match(__test__.COMMAND_BODY_MAP, /No map change/);
    assert.match(__test__.COMMAND_BODY_MAP, /focused patch/);
  });

  test('keeps the command prompt concise', () => {
    assert.doesNotMatch(__test__.COMMAND_BODY_MAP, /!\s*git status/);
    assert.doesNotMatch(__test__.COMMAND_BODY_MAP, /Gather Bounded Evidence/);
    assert.doesNotMatch(__test__.COMMAND_BODY_MAP, /focused unified diff/);
  });

  test('forbids secret/runtime scans and transcript reads by default', () => {
    assert.match(__test__.COMMAND_BODY_MAP, /Do not scan secrets/);
    assert.match(__test__.COMMAND_BODY_MAP, /\.env/);
    assert.match(__test__.COMMAND_BODY_MAP, /\.dev\.vars/);
    assert.match(__test__.COMMAND_BODY_MAP, /vault materialisation/);
    assert.match(__test__.COMMAND_BODY_MAP, /broad transcripts/);
  });

  test('explicitly rejects terminal-first and mc end reconciliation flows', () => {
    assert.match(__test__.COMMAND_BODY_MAP, /Do not invent a terminal `mc map` command/);
    assert.match(__test__.COMMAND_BODY_MAP, /use `mc end` for map/);
  });
});

describe('coordinator slash command installer', () => {
  test('installs the managed /mc command alongside coordinator commands', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mc-coord-commands-'));
    const oldHome = process.env.HOME;
    process.env.HOME = sandbox;
    try {
      await ensureCoordinatorSlashCommand();
      const mapCommand = readFileSync(join(sandbox, '.claude', 'commands', 'mc.md'), 'utf8');
      assert.match(mapCommand, /\/mc map/);
      assert.match(mapCommand, /memoro:managed:command/);
    } finally {
      process.env.HOME = oldHome;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('removes the legacy managed /memoro-map command', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mc-coord-commands-'));
    const oldHome = process.env.HOME;
    process.env.HOME = sandbox;
    try {
      mkdirSync(join(sandbox, '.claude', 'commands'), { recursive: true });
      const legacyPath = join(sandbox, '.claude', 'commands', 'memoro-map.md');
      writeFileSync(legacyPath, `${__test__.COMMAND_MARKER}\nlegacy`, { mode: 0o644 });
      await ensureCoordinatorSlashCommand();
      assert.equal(existsSync(legacyPath), false);
      assert.equal(existsSync(join(sandbox, '.claude', 'commands', 'mc.md')), true);
    } finally {
      process.env.HOME = oldHome;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('does not remove a hand-authored legacy command', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mc-coord-commands-'));
    const oldHome = process.env.HOME;
    process.env.HOME = sandbox;
    try {
      mkdirSync(join(sandbox, '.claude', 'commands'), { recursive: true });
      const legacyPath = join(sandbox, '.claude', 'commands', 'memoro-map.md');
      writeFileSync(legacyPath, 'user command', { mode: 0o644 });
      await ensureCoordinatorSlashCommand();
      assert.equal(readFileSync(legacyPath, 'utf8'), 'user command');
    } finally {
      process.env.HOME = oldHome;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('does not overwrite a hand-authored /mc command', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mc-coord-commands-'));
    const oldHome = process.env.HOME;
    process.env.HOME = sandbox;
    try {
      mkdirSync(join(sandbox, '.claude', 'commands'), { recursive: true });
      const mcPath = join(sandbox, '.claude', 'commands', 'mc.md');
      writeFileSync(mcPath, 'user-owned mc command', { mode: 0o644 });
      await ensureCoordinatorSlashCommand();
      assert.equal(readFileSync(mcPath, 'utf8'), 'user-owned mc command');
    } finally {
      process.env.HOME = oldHome;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('keeps legacy managed command when /mc is user-owned', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mc-coord-commands-'));
    const oldHome = process.env.HOME;
    process.env.HOME = sandbox;
    try {
      mkdirSync(join(sandbox, '.claude', 'commands'), { recursive: true });
      const mcPath = join(sandbox, '.claude', 'commands', 'mc.md');
      const legacyPath = join(sandbox, '.claude', 'commands', 'memoro-map.md');
      writeFileSync(mcPath, 'user-owned mc command', { mode: 0o644 });
      writeFileSync(legacyPath, `${__test__.COMMAND_MARKER}\nlegacy`, { mode: 0o644 });
      await ensureCoordinatorSlashCommand();
      assert.equal(readFileSync(mcPath, 'utf8'), 'user-owned mc command');
      assert.equal(existsSync(legacyPath), true);
    } finally {
      process.env.HOME = oldHome;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

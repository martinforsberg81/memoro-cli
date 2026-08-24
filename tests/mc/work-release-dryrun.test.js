/**
 * The dry run says what the apply does (2026-08-24).
 *
 * `mc work release` on an area with no worktree promised "would remove
 * <conversation>" in the dry run, then the apply found the inbox files,
 * kept everything, and said "nothing to release". One emptiness forecast
 * now serves both modes, and whatever holds the area is named.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { releaseWorkArea } from '../../src/mc/work-area.js';

const CONVERSATION_ID = '3f9d2c81-0000-4000-8000-000000000002';

function fixture({ inbox = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-release-dry-'));
  const workRoot = join(root, 'work');
  const areaPath = join(workRoot, 'x');
  mkdirSync(areaPath, { recursive: true });
  if (inbox) {
    mkdirSync(join(areaPath, 'inbox'));
    writeFileSync(join(areaPath, 'inbox', 'unread.md'), 'a message');
  }
  // A Claude conversation on record for the area, in a throwaway store.
  const claudeHome = join(root, 'claude');
  const projectDir = join(claudeHome, 'projects', areaPath.replace(/[/.]/gu, '-'));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${CONVERSATION_ID}.jsonl`), `${JSON.stringify({ cwd: areaPath, type: 'user' })}\n`);
  const env = { ...process.env, MC_WORK_ROOT: workRoot, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: join(root, 'codex') };
  return { root, areaPath, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('one emptiness forecast for both modes', () => {
  it('an inbox that holds the area is named in the dry run, and the apply tells the same story', () => {
    const fx = fixture({ inbox: true });
    try {
      const dry = releaseWorkArea('x', { env: fx.env, dryRun: true });
      assert.deepEqual(dry.conversations, [], 'the dry run must not promise conversations the apply will keep');
      assert.deepEqual(dry.held_by, ['inbox']);
      const applied = releaseWorkArea('x', { env: fx.env, dryRun: false });
      assert.deepEqual(applied.conversations, []);
      assert.deepEqual(applied.held_by, ['inbox']);
      assert.ok(existsSync(join(fx.areaPath, 'inbox', 'unread.md')), 'nothing was touched');
    } finally { fx.cleanup(); }
  });

  it('an area held by nothing releases its conversations — promised by the dry run, done by the apply', () => {
    const fx = fixture();
    try {
      const dry = releaseWorkArea('x', { env: fx.env, dryRun: true });
      assert.equal(dry.conversations.length, 1);
      assert.deepEqual(dry.held_by, []);
      assert.ok(existsSync(fx.areaPath), 'a dry run removes nothing');
      const applied = releaseWorkArea('x', { env: fx.env, dryRun: false });
      assert.equal(applied.conversations.length, 1);
      assert.equal(existsSync(fx.areaPath), false, 'the area went, as promised');
    } finally { fx.cleanup(); }
  });
});

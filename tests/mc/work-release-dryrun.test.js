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
  // A workarea holds checkouts and nothing else, so a directory that is not one
  // is not work and the release takes it. The point of the assertion is that it
  // is *named before it happens*: the dry run reports the same directory the
  // apply removes, so nothing goes quietly. This used to be the inbox's guard —
  // `held_by: ['inbox']` — and the inbox is gone, but any leftover directory
  // reaches the same code and must reach the same promise.
  it('a directory that is not a checkout is named by the dry run and taken by the apply', () => {
    const fx = fixture({ inbox: true });
    try {
      const dry = releaseWorkArea('x', { env: fx.env, dryRun: true });
      assert.deepEqual(dry.removed.map((item) => [item.repo, item.what]), [['inbox', 'directory']]);
      // Nothing holds the area any more, so the conversations go with it — and
      // the dry run says so rather than the apply finding them.
      assert.deepEqual(dry.held_by, []);
      assert.ok(existsSync(join(fx.areaPath, 'inbox', 'unread.md')), 'a dry run touches nothing');

      const applied = releaseWorkArea('x', { env: fx.env, dryRun: false });
      assert.deepEqual(applied.removed.map((item) => [item.repo, item.what]), [['inbox', 'directory']]);
      assert.equal(existsSync(join(fx.areaPath, 'inbox')), false, 'the apply did what the dry run said');
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

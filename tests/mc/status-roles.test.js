/**
 * The work model says what each area *is*, and stops calling filing "work".
 *
 * Two things, both about the same misreading. An area that carries a role
 * looked exactly like an ordinary one, so a reader could not answer the
 * question people actually have when several areas are running: which of
 * these is the PM, which is a worker. And the directory the channel writes —
 * `inbox/` — was being listed as a worktree, which announced a repository that
 * is not one. `handoff/` was the other; it had no writer and is gone.
 *
 * The rule for both: the model may grow fields, never change them. Everything
 * that reads it today must keep reading exactly what it read. It was asked
 * through `mc status --sessions --json` until decision mc-3 removed the
 * board; the model is asked directly now, and answers the same.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { areasByName } from './_helpers/board.js';
import { inspectWorkArea, listWorkAreas } from '../../src/mc/work-area.js';

const WORKER_MD = `---
name: worker
model: fable
singleton: false
tools: claude, codex
---
You are a worker.`;

/**
 * A work root with three areas: one marked with a role, one plain, and one
 * that has nothing but filing in it.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-status-roles-'));
  const workRoot = join(root, 'work');
  const rolesDir = join(root, 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, 'worker.md'), WORKER_MD);

  for (const name of ['marked', 'plain', 'filed']) mkdirSync(join(workRoot, name), { recursive: true });
  writeFileSync(join(workRoot, 'marked', '.mc-role'), 'worker\n');
  // Filing, in an ordinary area: the channel makes inbox/ on first message.
  mkdirSync(join(workRoot, 'filed', 'inbox'), { recursive: true });
  mkdirSync(join(workRoot, 'marked', 'inbox'), { recursive: true });
  // And one directory that is genuinely work, beside the filing.
  mkdirSync(join(workRoot, 'filed', 'some-repo'), { recursive: true });

  return {
    root,
    workRoot,
    env: {
      MC_HOME: join(root, 'home'),
      MC_WORK_ROOT: workRoot,
      MC_ROLES_DIR: rolesDir,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('the work model, on roles and on filing', () => {
  it('carries the area\'s role, and null when it has none', async () => {
    const fx = fixture();
    try {
      const areas = await areasByName(fx.env);
      assert.equal(areas.marked.role, 'worker');
      assert.equal(areas.plain.role, null);
      assert.equal(areas.filed.role, null);
    } finally { fx.cleanup(); }
  });

  it('adds that field without disturbing one that was already there', async () => {
    const fx = fixture();
    try {
      const areas = await areasByName(fx.env);
      // The shape every existing reader depends on, spelled out: same keys,
      // same meanings, plus the ones added since (role, stopped).
      assert.deepEqual(
        Object.keys(areas.plain).sort(),
        ['conversations', 'menu', 'name', 'path', 'role', 'running', 'stopped', 'waiting', 'working', 'worktrees'],
      );
      assert.equal(areas.plain.name, 'plain');
      assert.equal(areas.plain.path, join(fx.workRoot, 'plain'));
      assert.deepEqual(areas.plain.running, []);
      assert.deepEqual(areas.plain.worktrees, []);
      assert.equal(areas.plain.waiting, false);
      assert.equal(areas.plain.working, false);
    } finally { fx.cleanup(); }
  });

  it('never calls the channel\'s inbox a worktree', async () => {
    const fx = fixture();
    try {
      const areas = await areasByName(fx.env);
      assert.deepEqual(areas.filed.worktrees.map((worktree) => worktree.repo), ['some-repo']);
      assert.deepEqual(areas.marked.worktrees, []);

      // Same answer through the work model itself, which is what `mc work`
      // and every release/discard decision reads.
      const inspected = inspectWorkArea('filed', fx.env, { conversations: false, git: false });
      assert.deepEqual(inspected.worktrees.map((worktree) => worktree.repo), ['some-repo']);
    } finally { fx.cleanup(); }
  });

  it('leaves filing where it is — the listing hides it, nothing removes it', () => {
    const fx = fixture();
    try {
      const areas = listWorkAreas(fx.env, { conversations: false, git: false });
      const filed = areas.find((area) => area.name === 'filed');
      assert.deepEqual(filed.worktrees.map((worktree) => worktree.repo), ['some-repo']);
      // The directories are still on disk: this is a question of what counts
      // as work, never of what may be deleted.
      assert.equal(inspectWorkArea('filed', fx.env, { conversations: false, git: false }).exists, true);
      assert.deepEqual(
        ['inbox', 'some-repo'].filter((name) => existsDir(join(fx.workRoot, 'filed', name))),
        ['inbox', 'some-repo'],
      );
    } finally { fx.cleanup(); }
  });
});

function existsDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

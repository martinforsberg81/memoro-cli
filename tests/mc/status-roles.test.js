/**
 * The board says what each area *is*, and stops calling filing "work".
 *
 * Two things, both about the same misreading. An area that carries a role
 * looks exactly like an ordinary one on the status page, so the page cannot
 * answer the question people actually have when several areas are running:
 * which of these is the PM, which is a worker. And the directories the
 * channel and the handoff protocol write — `inbox/`, `handoff/` — were being
 * listed as worktrees, which announced a repository that is not one.
 *
 * The rule for both: the JSON page may grow fields, never change them.
 * Everything that reads it today must keep reading exactly what it read.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runMcCli } from './_helpers/mc-cli.js';
import { renderLines } from '../../src/mc/status-render.js';
import { inspectWorkArea } from '../../src/mc/work-area.js';

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
  // Filing, in an ordinary area: the channel makes inbox/ on first message,
  // the handoff protocol makes handoff/ on first baton.
  mkdirSync(join(workRoot, 'filed', 'inbox'), { recursive: true });
  mkdirSync(join(workRoot, 'filed', 'handoff'), { recursive: true });
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

function board(fx) {
  const result = runMcCli(['status', '--json'], fx.env);
  assert.equal(result.status, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  return Object.fromEntries(page.areas.map((area) => [area.name, area]));
}

describe('the board, on roles and on filing', () => {
  it('carries the area\'s role in the page, and null when it has none', () => {
    const fx = fixture();
    try {
      const areas = board(fx);
      assert.equal(areas.marked.role, 'worker');
      assert.equal(areas.plain.role, null);
      assert.equal(areas.filed.role, null);
    } finally { fx.cleanup(); }
  });

  it('adds that field without disturbing one that was already there', () => {
    const fx = fixture();
    try {
      const areas = board(fx);
      // The shape every existing reader depends on, spelled out: same keys,
      // same meanings, plus the ones added since (role, open_tasks).
      assert.deepEqual(
        Object.keys(areas.plain).sort(),
        ['conversations', 'name', 'open_tasks', 'path', 'role', 'running', 'waiting', 'working', 'worktrees'],
      );
      assert.equal(areas.plain.name, 'plain');
      assert.equal(areas.plain.path, join(fx.workRoot, 'plain'));
      assert.deepEqual(areas.plain.running, []);
      assert.deepEqual(areas.plain.worktrees, []);
      assert.equal(areas.plain.waiting, false);
      assert.equal(areas.plain.working, false);
    } finally { fx.cleanup(); }
  });

  it('never calls the channel\'s inbox or the handoff baton a worktree', () => {
    const fx = fixture();
    try {
      const areas = board(fx);
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
      runMcCli(['status', '--json'], fx.env);
      runMcCli(['work', 'list', '--json'], fx.env);
      const listed = runMcCli(['work', 'list', '--json'], fx.env);
      const areas = JSON.parse(listed.stdout).areas;
      const filed = areas.find((area) => area.name === 'filed');
      assert.deepEqual(filed.worktrees.map((worktree) => worktree.repo), ['some-repo']);
      // The directories are still on disk: this is a question of what counts
      // as work, never of what may be deleted.
      assert.equal(inspectWorkArea('filed', fx.env, { conversations: false, git: false }).exists, true);
      assert.deepEqual(
        ['inbox', 'handoff', 'some-repo'].filter((name) => existsDir(join(fx.workRoot, 'filed', name))),
        ['inbox', 'handoff', 'some-repo'],
      );
    } finally { fx.cleanup(); }
  });

  it('shows the role beside the name in the row header', () => {
    const report = {
      areas: [
        {
          name: 'mc-repo',
          path: '/x/mc-repo',
          role: 'worker',
          running: [],
          worktrees: [],
          conversations: [],
          waiting: false,
          working: false,
        },
        {
          name: 'ordinary',
          path: '/x/ordinary',
          role: null,
          running: [],
          worktrees: [],
          conversations: [],
          waiting: false,
          working: false,
        },
      ],
      summary: { areas: 2, waiting: 0, working: 0 },
    };
    const lines = renderLines(report, { columns: 100, now: 0 });
    assert.ok(lines.some((line) => /mc-repo · worker/u.test(line)), lines.join('\n'));

    // An area with no role reads exactly as it did before: no separator, no
    // empty space where a role would have been. Said as an identity against a
    // page with no `role` field at all — the shape every older reader saw —
    // rather than by looking for `·`, which is also the idle marker.
    const before = renderLines(
      { ...report, areas: report.areas.map(({ role, ...area }) => area) },
      { columns: 100, now: 0 },
    );
    const row = (page) => page.find((line) => line.includes('ordinary'));
    assert.equal(row(lines), row(before));
    assert.doesNotMatch(row(lines).replace(/^\s*·\s/u, ''), /·/u);
  });
});

function existsDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

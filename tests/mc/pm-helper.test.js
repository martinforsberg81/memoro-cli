/**
 * The PM helper's mechanics (design note v0.2, built 2026-08-24).
 *
 * §3: one module knows where intake comes from — the path, the file forms,
 * the quarter-hour grouping — and processing moves, never deletes. §5: the
 * helper's tool does not carry `mc repo merge` without `--check`; the role
 * must not have to remember the boundary.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listIntake, processIntake } from '../../src/mc/pm-helper-intake.js';
import { helperMergeRefusal } from '../../src/mc/commands/repo.js';
import { runRoleSingleton } from '../../src/mc/commands/role-singleton.js';

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-helper-intake-'));
  mkdirSync(join(root, 'intake', 'processed'), { recursive: true });
  writeFileSync(join(root, 'intake', 'README.md'), '# intake\n');
  return root;
}

const at = (root, name, iso) => {
  const seconds = Date.parse(iso) / 1000;
  utimesSync(join(root, 'intake', name), seconds, seconds);
};

describe('the intake module — the one place that knows the file forms', () => {
  it('pairs an attachment with its .md description by stem, and groups by quarter hour', () => {
    const root = home();
    try {
      writeFileSync(join(root, 'intake', 'fault.png'), 'PNG');
      writeFileSync(join(root, 'intake', 'fault.md'), 'The dialog over the empty list\n');
      writeFileSync(join(root, 'intake', 'note.md'), 'Just a line of text\n');
      at(root, 'fault.png', '2026-08-24T10:01:00Z');
      at(root, 'fault.md', '2026-08-24T10:03:00Z');
      at(root, 'note.md', '2026-08-24T11:40:00Z');
      const items = listIntake(root);
      assert.deepEqual(items.map((item) => item.stem), ['fault', 'note']);
      assert.deepEqual(items[0].files, ['fault.md', 'fault.png']);
      assert.equal(items[0].description, 'The dialog over the empty list');
      assert.equal(items[1].description, 'Just a line of text', 'a lone .md is its own item');
      assert.notEqual(items[0].group, items[1].group, 'different quarter hours');
      // Same quarter hour: same group.
      writeFileSync(join(root, 'intake', 'log.txt'), 'trace');
      at(root, 'log.txt', '2026-08-24T10:04:00Z');
      const again = listIntake(root);
      assert.equal(again.find((i) => i.stem === 'log').group, again.find((i) => i.stem === 'fault').group);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('processing MOVES to processed/<date>/ — never deletes — and a missing stem is said', () => {
    const root = home();
    try {
      writeFileSync(join(root, 'intake', 'shot.png'), 'PNG');
      writeFileSync(join(root, 'intake', 'shot.md'), 'desc');
      const outcome = processIntake(root, ['shot', 'ghost'], { now: new Date('2026-08-24T12:00:00Z') });
      assert.deepEqual(outcome.moved.sort(), ['shot.md', 'shot.png']);
      assert.deepEqual(outcome.missing, ['ghost']);
      assert.ok(existsSync(join(root, 'intake', 'processed', '2026-08-24', 'shot.png')), 'Martin can go back to his own screenshot');
      assert.equal(existsSync(join(root, 'intake', 'shot.png')), false);
      assert.deepEqual(listIntake(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an intake directory that does not exist is an empty list, not an error', () => {
    assert.deepEqual(listIntake('/nowhere/at/all'), []);
  });
});

describe('mc pm-helper intake — the door to the module', () => {
  it('lists, marks done, and says so when a stem names nothing', async () => {
    const box = mkdtempSync(join(tmpdir(), 'mc-helper-cli-'));
    try {
      const workRoot = join(box, 'work');
      mkdirSync(join(workRoot, 'pm-helper', 'intake'), { recursive: true });
      writeFileSync(join(workRoot, 'pm-helper', 'intake', 'shot.png'), 'PNG');
      const io = () => { const out = []; return { out, stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => out.push(t) } }; };
      const env = { ...process.env, MC_WORK_ROOT: workRoot };
      const listed = io();
      assert.equal(await runRoleSingleton('pm-helper', ['intake'], { ...listed, env }), 0);
      assert.match(listed.out.join(''), /shot {2}\(shot\.png\)/u);
      const done = io();
      assert.equal(await runRoleSingleton('pm-helper', ['intake', 'done', 'shot'], { ...done, env }), 0);
      assert.match(done.out.join(''), /processed shot\.png/u);
      const ghost = io();
      assert.equal(await runRoleSingleton('pm-helper', ['intake', 'done', 'ghost'], { ...ghost, env }), 1);
      assert.match(ghost.out.join(''), /nothing in intake\/ is called ghost/u);
    } finally { rmSync(box, { recursive: true, force: true }); }
  });
});

describe('the boundary the role does not have to remember (§5)', () => {
  it('refuses merge without --check for the helper, and only for the helper', () => {
    const helper = { name: 'pm-helper', kind: 'work-area' };
    assert.match(helperMergeRefusal(helper, { check: false }), /does not carry mc repo merge without --check/u);
    assert.equal(helperMergeRefusal(helper, { check: true }), null, 'the check form measures and reports');
    assert.equal(helperMergeRefusal({ name: 'helper', kind: 'work-area' }, { check: false }) === null, false, 'the alias is the same role');
    assert.equal(helperMergeRefusal({ name: 'pm', kind: 'work-area' }, { check: false }), null, 'the PM lands');
    assert.equal(helperMergeRefusal({ name: 'mc-repo', kind: 'work-area' }, { check: false }), null);
    assert.equal(helperMergeRefusal({ name: 'pm-helper', kind: 'shell' }, { check: false }), null, 'a shell that happens to stand there is not the role');
  });
});

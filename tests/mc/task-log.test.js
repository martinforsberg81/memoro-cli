/**
 * Tasks (designnote §6, D-0113): the storage law, asserted directly against
 * the module rather than through the CLI, because the thing at stake here —
 * append-only, replay is state, age is since the last line — is about the
 * file, not about argument parsing.
 */
import assert from 'node:assert/strict';
import {
  appendFileSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  blockTask, findTask, listOpenTasks, markTaskDone, openTask, openTaskCount, openTasks,
  readTasks, taskLogPath, TASK_SCHEMA, TASK_VERSION,
} from '../../src/mc/task-log.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-task-log-'));
  return { root, cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } } };
}

const SENDER = { name: 'pm', kind: 'work-area' };

describe('task storage', () => {
  it('a task opened is one line, well-formed, and readable back', () => {
    const fx = fixture();
    try {
      const now = new Date('2026-08-21T09:00:00.000Z');
      const opened = openTask({
        session: 'alpha', text: 'do step 3 in plan mc-task', sender: SENDER, root: fx.root, now,
      });
      assert.equal(opened.state, 'open');
      assert.equal(opened.text, 'do step 3 in plan mc-task');
      assert.equal(opened.sender, 'pm');
      assert.equal(opened.opened_at, now.toISOString());
      assert.equal(opened.updated_at, now.toISOString());

      const raw = readFileSync(taskLogPath('alpha', fx.root), 'utf8').trim().split('\n');
      assert.equal(raw.length, 1);
      const line = JSON.parse(raw[0]);
      assert.equal(line.schema, TASK_SCHEMA);
      assert.equal(line.version, TASK_VERSION);
      assert.equal(line.event, 'open');
      assert.equal(line.id, opened.id);

      const [task] = readTasks('alpha', { root: fx.root });
      assert.deepEqual(task, opened);
    } finally { fx.cleanup(); }
  });

  it('append-only: every movement is one more line, and none already written ever changes', () => {
    const fx = fixture();
    try {
      const opened = openTask({ session: 'alpha', text: 'do it', sender: SENDER, root: fx.root });
      const path = taskLogPath('alpha', fx.root);
      const afterOpen = readFileSync(path, 'utf8');

      blockTask(opened.id, 'waiting on review', { root: fx.root });
      const afterBlock = readFileSync(path, 'utf8');
      assert.ok(afterBlock.startsWith(afterOpen), 'the open line was rewritten');
      assert.equal(afterBlock.split('\n').filter(Boolean).length, 2);

      markTaskDone(opened.id, { root: fx.root });
      const afterDone = readFileSync(path, 'utf8');
      assert.ok(afterDone.startsWith(afterBlock), 'an earlier line was rewritten');
      assert.equal(afterDone.split('\n').filter(Boolean).length, 3);
    } finally { fx.cleanup(); }
  });

  it('state is the replay of the lines: blocked, then done, and done wins', () => {
    const fx = fixture();
    try {
      const opened = openTask({ session: 'alpha', text: 'do it', sender: SENDER, root: fx.root });
      blockTask(opened.id, 'waiting on review', { root: fx.root });
      let [task] = readTasks('alpha', { root: fx.root });
      assert.equal(task.state, 'blocked');
      assert.equal(task.reason, 'waiting on review');

      markTaskDone(opened.id, { root: fx.root });
      [task] = readTasks('alpha', { root: fx.root });
      assert.equal(task.state, 'done');
      // The reason from the blocked line is still in the replay — done does
      // not erase what came before it, it only ends the arrow.
      assert.equal(task.reason, 'waiting on review');
    } finally { fx.cleanup(); }
  });

  it('age is since the last line for that id, not since it was opened', () => {
    const fx = fixture();
    try {
      const opened = openTask({
        session: 'alpha', text: 'do it', sender: SENDER, root: fx.root, now: new Date('2026-08-20T00:00:00.000Z'),
      });
      const blocked = blockTask(opened.id, 'stuck', {
        root: fx.root, now: new Date('2026-08-21T00:00:00.000Z'),
      });
      assert.ok(blocked.ok);
      const [task] = readTasks('alpha', { root: fx.root });
      assert.equal(task.opened_at, '2026-08-20T00:00:00.000Z');
      assert.equal(task.updated_at, '2026-08-21T00:00:00.000Z');
    } finally { fx.cleanup(); }
  });

  it('done is where the arrow ends: blocking a done task is refused', () => {
    const fx = fixture();
    try {
      const opened = openTask({ session: 'alpha', text: 'do it', sender: SENDER, root: fx.root });
      markTaskDone(opened.id, { root: fx.root });
      const blocked = blockTask(opened.id, 'too late', { root: fx.root });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.reason, 'already-done');

      const [task] = readTasks('alpha', { root: fx.root });
      assert.equal(task.state, 'done');
    } finally { fx.cleanup(); }
  });

  it('marking an already-done task done again is the same fact, not an error', () => {
    const fx = fixture();
    try {
      const opened = openTask({ session: 'alpha', text: 'do it', sender: SENDER, root: fx.root });
      const first = markTaskDone(opened.id, { root: fx.root });
      assert.equal(first.ok, true);
      assert.equal(first.already, false);

      const second = markTaskDone(opened.id, { root: fx.root });
      assert.equal(second.ok, true);
      assert.equal(second.already, true);

      // And it did not write a second done line.
      const raw = readFileSync(taskLogPath('alpha', fx.root), 'utf8').trim().split('\n');
      assert.equal(raw.length, 2);
    } finally { fx.cleanup(); }
  });

  it('open tasks exclude done, and include blocked', () => {
    const fx = fixture();
    try {
      const a = openTask({ session: 'alpha', text: 'a', sender: SENDER, root: fx.root });
      const b = openTask({ session: 'alpha', text: 'b', sender: SENDER, root: fx.root });
      const c = openTask({ session: 'alpha', text: 'c', sender: SENDER, root: fx.root });
      markTaskDone(a.id, { root: fx.root });
      blockTask(b.id, 'waiting', { root: fx.root });

      const open = openTasks('alpha', { root: fx.root }).map((task) => task.id).sort();
      assert.deepEqual(open, [b.id, c.id].sort());
      assert.equal(openTaskCount('alpha', { root: fx.root }), 2);
    } finally { fx.cleanup(); }
  });

  it('a session that has never had a task costs one existence check, not a scan', () => {
    const fx = fixture();
    try {
      assert.equal(openTaskCount('nothing-here', { root: fx.root }), 0);
      assert.deepEqual(openTasks('nothing-here', { root: fx.root }), []);
      assert.deepEqual(readTasks('nothing-here', { root: fx.root }), []);
    } finally { fx.cleanup(); }
  });

  it('lists across every session that has a task log', () => {
    const fx = fixture();
    try {
      openTask({ session: 'alpha', text: 'a', sender: SENDER, root: fx.root });
      openTask({ session: 'beta', text: 'b', sender: SENDER, root: fx.root });
      const sessions = listOpenTasks({ root: fx.root }).map((task) => task.session).sort();
      assert.deepEqual(sessions, ['alpha', 'beta']);
    } finally { fx.cleanup(); }
  });

  it('finds a task by id or by a prefix that names exactly one', () => {
    const fx = fixture();
    try {
      const a = openTask({ session: 'alpha', text: 'a', sender: SENDER, root: fx.root });
      const byFull = findTask(a.id, { root: fx.root });
      assert.equal(byFull.length, 1);
      const byPrefix = findTask(a.id.slice(0, 8), { root: fx.root });
      assert.equal(byPrefix.length, 1);
      assert.equal(byPrefix[0].id, a.id);

      assert.deepEqual(findTask('not-an-id', { root: fx.root }), []);
    } finally { fx.cleanup(); }
  });

  it('a prefix naming more than one task is reported as ambiguous, not guessed', () => {
    const fx = fixture();
    try {
      // Two ids that happen to share a first character — forced rather than
      // hoped for, since real ids are random.
      openTask({
        session: 'alpha', text: 'a', sender: SENDER, root: fx.root, id: 'aaaa1111-0000-4000-8000-000000000001',
      });
      openTask({
        session: 'alpha', text: 'b', sender: SENDER, root: fx.root, id: 'aaaa2222-0000-4000-8000-000000000002',
      });
      const matches = findTask('aaaa', { root: fx.root });
      assert.equal(matches.length, 2);

      const outcome = markTaskDone('aaaa', { root: fx.root });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.reason, 'ambiguous');
      assert.equal(outcome.matches.length, 2);
    } finally { fx.cleanup(); }
  });

  it('a line nobody here recognises is skipped, not corrupting what came after it', () => {
    const fx = fixture();
    try {
      const opened = openTask({ session: 'alpha', text: 'a', sender: SENDER, root: fx.root });
      const path = taskLogPath('alpha', fx.root);
      const before = readFileSync(path, 'utf8');
      // A line from a future version, or nonsense — either way, not this
      // reader's to understand.
      const bogus = `${JSON.stringify({ schema: TASK_SCHEMA, version: 99, id: opened.id, event: 'open', at: new Date().toISOString() })}\n`;
      appendFileSync(path, bogus);
      appendFileSync(path, 'not json at all\n');

      const [task] = readTasks('alpha', { root: fx.root });
      assert.equal(task.state, 'open');
      assert.equal(task.text, 'a');
      // The file itself kept everything — mc adds, never removes, even a
      // line it cannot make sense of.
      assert.ok(readFileSync(path, 'utf8').startsWith(before));
    } finally { fx.cleanup(); }
  });
});

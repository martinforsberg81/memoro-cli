/**
 * `mc task`, and `mc work send … --task` that opens one (designnote §6,
 * D-0113): the CLI wiring around the storage law asserted in
 * task-log.test.js.
 *
 *   - a task exists only when --task asked for one — never inferred;
 *   - creation and the order are the same action;
 *   - `mc task list` reads it back, `done` and `block` are the only two
 *     movements;
 *   - `mc status` counts it, per session, on the area line;
 *   - the log lives under mc's home, never inside the work area.
 */
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runMcCli } from './_helpers/mc-cli.js';
import { board as workModel } from './_helpers/board.js';
import { taskLogPath } from '../../src/mc/task-log.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-task-cli-'));
  const workRoot = join(root, 'work');
  const mcHome = join(root, 'home');
  mkdirSync(join(workRoot, 'pm'), { recursive: true });
  mkdirSync(join(workRoot, 'alpha'), { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  return {
    root,
    workRoot,
    mcHome,
    env: {
      MC_HOME: mcHome,
      MC_WORK_ROOT: workRoot,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

function json(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe('mc work send --task', () => {
  it('creates no task without the flag', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'just a message'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 0, sent.stderr);
      assert.equal(existsSync(taskLogPath('pm', fx.mcHome)), false);
      const list = json(runMcCli(['task', 'list', 'pm', '--json'], fx.env));
      assert.deepEqual(list.tasks, []);
    } finally { fx.cleanup(); }
  });

  it('opens a task in the same action as the order, carrying the order\'s own text', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'do step 3 in plan mc-task', '--task'], fx.env, {
        cwd: join(fx.workRoot, 'alpha'),
      });
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /task [0-9a-f]{8} opened for pm/u);

      const list = json(runMcCli(['task', 'list', 'pm', '--json'], fx.env));
      assert.equal(list.tasks.length, 1);
      assert.equal(list.tasks[0].session, 'pm');
      assert.equal(list.tasks[0].state, 'open');
      assert.equal(list.tasks[0].text, 'do step 3 in plan mc-task');
      assert.equal(list.tasks[0].sender, 'alpha');
      assert.equal(typeof list.tasks[0].age_ms, 'number');
    } finally { fx.cleanup(); }
  });

  it('the flag works from any position, same as --wake', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', '--task', 'do the thing'], fx.env, {
        cwd: join(fx.workRoot, 'alpha'),
      });
      assert.equal(sent.status, 0, sent.stderr);
      const list = json(runMcCli(['task', 'list', 'pm', '--json'], fx.env));
      assert.equal(list.tasks.length, 1);
      assert.equal(list.tasks[0].text, 'do the thing');
    } finally { fx.cleanup(); }
  });

  it('the task log lives under mc\'s home, never inside the work area', () => {
    const fx = fixture();
    try {
      runMcCli(['work', 'send', 'pm', 'a task', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.ok(existsSync(taskLogPath('pm', fx.mcHome)));
      const insideArea = readdirSync(join(fx.workRoot, 'pm')).filter((name) => name !== 'inbox');
      assert.deepEqual(insideArea, []);
      assert.deepEqual(readdirSync(fx.mcHome).sort(), ['tasks']);
    } finally { fx.cleanup(); }
  });

  it('a task never outlives the order: an area that does not exist gets neither', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'nowhere', 'a task', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      assert.equal(sent.status, 1);
      assert.equal(existsSync(taskLogPath('nowhere', fx.mcHome)), false);
    } finally { fx.cleanup(); }
  });
});

describe('mc task', () => {
  it('is asked for what it needs: which task, what for', () => {
    const fx = fixture();
    try {
      const noId = runMcCli(['task', 'done'], fx.env);
      assert.equal(noId.status, 2);
      assert.match(noId.stderr, /which task\?/u);

      const noReason = runMcCli(['task', 'block', 'anything'], fx.env);
      assert.equal(noReason.status, 2);
      assert.match(noReason.stderr, /what is it blocked on\?/u);
    } finally { fx.cleanup(); }
  });

  it('lists open tasks oldest-moved first, with age', async () => {
    const fx = fixture();
    try {
      runMcCli(['work', 'send', 'pm', 'first', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      await new Promise((resolve) => { setTimeout(resolve, 1100); });
      runMcCli(['work', 'send', 'pm', 'second', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });

      const list = json(runMcCli(['task', 'list', 'pm', '--json'], fx.env));
      assert.equal(list.tasks.length, 2);
      assert.equal(list.tasks[0].text, 'first');
      assert.equal(list.tasks[1].text, 'second');
      assert.ok(list.tasks[0].age_ms >= list.tasks[1].age_ms);

      const page = runMcCli(['task', 'list', 'pm'], fx.env).stdout;
      assert.match(page, /first/u);
      assert.match(page, /second/u);
      assert.ok(page.indexOf('first') < page.indexOf('second'));
    } finally { fx.cleanup(); }
  });

  it('mc task list with no session lists across every session', () => {
    const fx = fixture();
    try {
      runMcCli(['work', 'send', 'pm', 'for pm', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      runMcCli(['work', 'send', 'alpha', 'for alpha', '--task'], fx.env, { cwd: fx.root });

      const list = json(runMcCli(['task', 'list', '--json'], fx.env));
      const sessions = list.tasks.map((task) => task.session).sort();
      assert.deepEqual(sessions, ['alpha', 'pm']);

      const page = runMcCli(['task', 'list'], fx.env).stdout;
      assert.match(page, /pm\s+[0-9a-f]{8}/u);
      assert.match(page, /alpha\s+[0-9a-f]{8}/u);
    } finally { fx.cleanup(); }
  });

  it('an empty list says so, for a session and for everywhere', () => {
    const fx = fixture();
    try {
      assert.match(runMcCli(['task', 'list', 'pm'], fx.env).stdout, /no open tasks for pm/u);
      assert.match(runMcCli(['task', 'list'], fx.env).stdout, /no open tasks anywhere/u);
    } finally { fx.cleanup(); }
  });

  it('done marks it, and it drops off the open list', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'finish this', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      const id = /task ([0-9a-f]{8}) opened/u.exec(sent.stdout)[1];

      const done = runMcCli(['task', 'done', id], fx.env);
      assert.equal(done.status, 0, done.stderr);
      assert.match(done.stdout, new RegExp(`${id} done — pm`, 'u'));

      const list = json(runMcCli(['task', 'list', 'pm', '--json'], fx.env));
      assert.deepEqual(list.tasks, []);

      // Marking it done again is the same fact, not an error.
      const again = runMcCli(['task', 'done', id], fx.env);
      assert.equal(again.status, 0);
      assert.match(again.stdout, /was already done/u);
    } finally { fx.cleanup(); }
  });

  it('block keeps it open, with the reason readable in the listing', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'ship it', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      const id = /task ([0-9a-f]{8}) opened/u.exec(sent.stdout)[1];

      const blocked = runMcCli(['task', 'block', id, 'waiting on review'], fx.env);
      assert.equal(blocked.status, 0, blocked.stderr);
      assert.match(blocked.stdout, new RegExp(`${id} blocked — pm — waiting on review`, 'u'));

      const list = json(runMcCli(['task', 'list', 'pm', '--json'], fx.env));
      assert.equal(list.tasks.length, 1);
      assert.equal(list.tasks[0].state, 'blocked');
      assert.equal(list.tasks[0].reason, 'waiting on review');

      const page = runMcCli(['task', 'list', 'pm'], fx.env).stdout;
      assert.match(page, /waiting on review/u);

      // Blocked still ends at done — the only way out.
      const done = runMcCli(['task', 'done', id], fx.env);
      assert.equal(done.status, 0, done.stderr);
      assert.deepEqual(json(runMcCli(['task', 'list', 'pm', '--json'], fx.env)).tasks, []);
    } finally { fx.cleanup(); }
  });

  it('blocking an already-done task is refused', () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'done already', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      const id = /task ([0-9a-f]{8}) opened/u.exec(sent.stdout)[1];
      runMcCli(['task', 'done', id], fx.env);

      const blocked = runMcCli(['task', 'block', id, 'too late'], fx.env);
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /is already done/u);
    } finally { fx.cleanup(); }
  });

  it('an id that names nothing, or names more than one thing, is reported plainly', () => {
    const fx = fixture();
    try {
      const missing = runMcCli(['task', 'done', 'deadbeef'], fx.env);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /no task called "deadbeef"/u);

      // A prefix is enough when it names exactly one task.
      const sent = runMcCli(['work', 'send', 'pm', 'one task', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      const id = /task ([0-9a-f]{8}) opened/u.exec(sent.stdout)[1];
      const done = runMcCli(['task', 'done', id.slice(0, 4)], fx.env);
      assert.equal(done.status, 0, done.stderr);
    } finally { fx.cleanup(); }
  });
});

describe('the work model and tasks', () => {
  it('counts the open tasks per area', async () => {
    const fx = fixture();
    try {
      const before = await workModel(fx.env);
      assert.equal(before.areas.find((area) => area.name === 'pm').open_tasks, 0);

      runMcCli(['work', 'send', 'pm', 'one', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      runMcCli(['work', 'send', 'pm', 'two', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });

      const board = await workModel(fx.env);
      const pm = board.areas.find((area) => area.name === 'pm');
      assert.equal(pm.open_tasks, 2);
      const alpha = board.areas.find((area) => area.name === 'alpha');
      assert.equal(alpha.open_tasks, 0);
    } finally { fx.cleanup(); }
  });

  it('a done task drops the count back down', async () => {
    const fx = fixture();
    try {
      const sent = runMcCli(['work', 'send', 'pm', 'one', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      const id = /task ([0-9a-f]{8}) opened/u.exec(sent.stdout)[1];
      runMcCli(['task', 'done', id], fx.env);

      const board = await workModel(fx.env);
      assert.equal(board.areas.find((area) => area.name === 'pm').open_tasks, 0);
    } finally { fx.cleanup(); }
  });

  it('nothing else about the model changes shape — the field only grows it', async () => {
    const fx = fixture();
    try {
      const before = await workModel(fx.env);
      runMcCli(['work', 'send', 'pm', 'one', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      const after = await workModel(fx.env);
      const names = (page) => page.areas.map((area) => area.name).sort();
      assert.deepEqual(names(after), names(before));
    } finally { fx.cleanup(); }
  });
});

/** Exercised only to be sure the fixture's own helper stays honest. */
describe('fixture sanity', () => {
  it('reads what it writes', () => {
    const fx = fixture();
    try {
      runMcCli(['work', 'send', 'pm', 'a message', '--task'], fx.env, { cwd: join(fx.workRoot, 'alpha') });
      const raw = readFileSync(taskLogPath('pm', fx.mcHome), 'utf8').trim();
      assert.equal(raw.split('\n').length, 1);
    } finally { fx.cleanup(); }
  });
});

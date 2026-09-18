import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run } from '../../../src/mc/commands/step.js';
import { parseEntry, registerPath } from '../../../src/mc/register.js';

const ROOT = '/work';

function fixture() {
  const files = {
    [registerPath(ROOT, 'p')]: JSON.stringify({ project: 'p', repo: 'memoro', steps: [{ key: 'A', status: 'done', pr: 3 }, { key: 'B', status: 'running', session: { pid: 1 } }] }),
  };
  const out = []; const err = [];
  const deps = {
    root: ROOT, env: { MC_STEP: 'p:1' }, now: () => new Date('2026-09-18T10:00:00Z'),
    stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) },
    read: (path) => files[path] ?? null,
    write: (path, value) => { files[path] = JSON.stringify(value); },
    lock: (_root, fn) => fn(),
    projects: () => ['p', 'sql-w1-universe-closure'],
  };
  return { deps, out, err, step: (i) => parseEntry(files[registerPath(ROOT, 'p')]).steps[i] };
}

test('blocked --on names a decision, --on-project a project that has a plan on main', async () => {
  const a = fixture();
  assert.equal(await run(['blocked', '--on', 'sql-7', '--reason', 'the contract is wrong'], a.deps), 0);
  assert.deepEqual(a.step(1).blocked_by, { kind: 'decision', name: 'sql-7' });

  const b = fixture();
  assert.equal(await run(['blocked', '--on-project', 'sql-w1-universe-closure'], b.deps), 0);
  assert.deepEqual(b.step(1).blocked_by, { kind: 'project', name: 'sql-w1-universe-closure' });

  const c = fixture();
  assert.equal(await run(['blocked', '--on-project', 'no-such-project'], c.deps), 1);
  assert.match(c.err.join(''), /no project no-such-project has a plan on main/u);
  assert.equal(c.step(1).status, 'running');
});

test('blocked refuses a name the plan schema would refuse — 2026-09-18, `project:sql-w1-universe-closure` unparsed a whole plan', async () => {
  const f = fixture();
  assert.equal(await run(['blocked', '--on', 'project:sql-w1-universe-closure'], f.deps), 2);
  assert.match(f.err.join(''), /is not a name/u);
  assert.equal(f.step(1).status, 'running');
  assert.equal(await run(['blocked', '--on', 'a', '--on-project', 'p'], f.deps), 2);
});

test('note appends a paragraph to the step and moves nothing else', async () => {
  const f = fixture();
  assert.equal(await run(['note', '14 admissions still to write; the list is in the pull request'], f.deps), 0);
  assert.deepEqual(f.step(1).comments, ['14 admissions still to write; the list is in the pull request']);
  assert.equal(f.step(1).status, 'running');
  assert.equal(f.step(1).session.pid, 1);
  assert.equal(await run(['note', 'p', '1', 'landed by hand'], f.deps), 0);
  assert.deepEqual(f.step(0).comments, ['landed by hand']);
  assert.equal(await run(['note'], f.deps), 2);
});

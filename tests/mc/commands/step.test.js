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

test('mc step <project> prints an interrupted ready step\'s record', async () => {
  const f = fixture();
  f.deps.write(registerPath(ROOT, 'p'), {
    project: 'p', repo: 'memoro',
    steps: [{ key: 'A', status: 'ready', interrupted: { at: '2026-09-18T09:30:00Z', session_id: 'c1a2b3c4-dead', tool: 'claude', last_activity: '2026-09-18T09:20:00Z', context_tokens: 5320, count: 1 } }],
  });
  assert.equal(await run(['p'], f.deps), 0);
  assert.match(f.out.join(''), /ready +interrupted 2026-09-18T09:30:00Z · claude session c1a2b3c4 · last activity 40m ago · 5320 tokens/u);
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

/** A three-step memoro project, step 3 (index 2) the one being blocked. */
function waiting(repo = 'memoro') {
  const f = fixture();
  f.deps.write(registerPath(ROOT, 'p'), {
    project: 'p', repo,
    steps: [{ key: 'A', status: 'done' }, { key: 'B', status: 'done', landed: { sha: 'abc1234' } }, { key: 'C', status: 'running' }],
  });
  f.deps.env = { MC_STEP: 'p:2' };
  return f;
}

test('blocked --until and --after-deploy make the blocker and its name from the fields', async () => {
  const a = waiting();
  assert.equal(await run(['blocked', '--until', '2026-10-14T08:00Z'], a.deps), 0);
  assert.deepEqual(a.step(2).blocked_by, { kind: 'time', name: 'until-20261014-0800', at: '2026-10-14T08:00:00Z' });

  const b = waiting();
  assert.equal(await run(['blocked', '--after-deploy', '--hours', '24'], b.deps), 0);
  assert.deepEqual(b.step(2).blocked_by, { kind: 'deploy', name: 'deploy-step-2-24h', step: 2, hours: 24 });

  const c = waiting();
  assert.equal(await run(['blocked', 'p', '3', '--after-deploy', '1', '--reason', 'needs the migration live'], c.deps), 0);
  assert.deepEqual(c.step(2).blocked_by, { kind: 'deploy', name: 'deploy-step-1', step: 1, hours: 0 });
  assert.equal(c.step(2).reason, 'needs the migration live');
});

test('blocked refuses a past --until, --after-deploy outside memoro, on itself or a later step, and two waits at once', async () => {
  const past = waiting();
  assert.equal(await run(['blocked', '--until', '2026-09-01T00:00Z'], past.deps), 2);
  assert.match(past.err.join(''), /has passed/u);
  assert.equal(await run(['blocked', '--until', 'tomorrow'], past.deps), 2);
  assert.match(past.err.join(''), /is not a time/u);

  const cli = waiting('memoro-cli');
  assert.equal(await run(['blocked', '--after-deploy'], cli.deps), 2);
  assert.match(cli.err.join(''), /mc: memoro-cli has no deploy — mc deploy deploys memoro/u);

  const self = waiting();
  assert.equal(await run(['blocked', '--after-deploy', '3'], self.deps), 2);
  assert.match(self.err.join(''), /a step before this one/u);
  assert.equal(await run(['blocked', 'p', '2', '--after-deploy', '3'], self.deps), 2);
  assert.equal(await run(['blocked', '--after-deploy', '--hours', '-1'], self.deps), 2);
  assert.equal(await run(['blocked', '--until', '2026-10-14T08:00Z', '--on', 'x'], self.deps), 2);
  assert.equal(self.step(2).status, 'running');
});

test('mc step <project> prints how long a time or deploy wait has left', async () => {
  const f = fixture();
  f.deps.now = () => new Date('2026-10-11T08:00:00Z');
  f.deps.write(registerPath(ROOT, 'p'), {
    project: 'p', repo: 'memoro',
    steps: [
      { key: 'A', status: 'done' },
      { key: 'B', status: 'blocked', blocked_by: { kind: 'time', name: 'until-20261014-0800', at: '2026-10-14T08:00:00Z' } },
      { key: 'C', status: 'done', landed: { sha: 'abc1234' } },
      { key: 'D', status: 'blocked', blocked_by: { kind: 'deploy', name: 'deploy-step-3-24h', step: 3, hours: 24 } },
      { key: 'E', status: 'blocked', blocked_by: { kind: 'deploy', name: 'deploy-step-1', step: 1, hours: 0 } },
      { key: 'F', status: 'blocked', blocked_by: { kind: 'decision', name: 'q-1' } },
    ],
  });
  f.deps.deploys = () => [{ sha: 'fff9999', ended: '2026-10-10T15:40:00Z', outcome: 'deployed' }];
  f.deps.contains = (sha, rowSha) => sha === 'abc1234' && rowSha === 'fff9999';
  assert.equal(await run(['p'], f.deps), 0);
  const out = f.out.join('');
  assert.match(out, /until 2026-10-14 08:00Z — 3d left/u);
  assert.match(out, /on deploy of step 3 \+ 24h — 7h40m left/u);
  assert.match(out, /on deploy of step 1 — step 1 not landed/u);
  assert.match(out, /on decision q-1/u);

  f.out.length = 0;
  f.deps.deploys = () => [];
  assert.equal(await run(['p'], f.deps), 0);
  assert.match(f.out.join(''), /on deploy of step 3 \+ 24h — not deployed yet/u);
});

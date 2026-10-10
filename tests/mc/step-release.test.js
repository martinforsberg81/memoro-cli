import assert from 'node:assert/strict';
import { test } from 'node:test';

import { overlayPlans, registerPath } from '../../src/mc/register.js';
import { planSummary } from '../../src/mc/plan-schema.js';
import { ago, blockerDue, describeWait, left, releaseDue } from '../../src/mc/step-release.js';

const NOW = new Date('2026-10-11T17:00:00Z');
const SHA = 'aaaaaaa1111111111111111111111111111111111';

const blocked = (blocked_by) => ({ status: 'blocked', blocked_by });
const deployed = (sha, ended, outcome = 'deployed') => ({ started: ended, ended, sha, outcome });
/** Step 3 of a plan landed as `SHA`; every row whose sha starts with `ccc` contains it. */
const context = (over = {}) => ({
  now: NOW,
  plans: [],
  stepsOf: () => [{ status: 'done' }, { status: 'done' }, { status: 'done', landed: { sha: SHA } }, { status: 'blocked' }],
  deploys: [],
  contains: (sha, rowSha) => sha === SHA && rowSha.startsWith('ccc'),
  ...over,
});

test('time: not due before `at`, due from it, and the wait says what is left', () => {
  const step = blocked({ kind: 'time', name: 'until-20261014-0800', at: '2026-10-14T08:00:00Z' });
  assert.deepEqual(blockerDue(step, context()), { due: false });
  assert.deepEqual(blockerDue(step, context({ now: new Date('2026-10-14T08:00:00Z') })), { due: true, why: 'time 2026-10-14T08:00Z passed' });
  assert.equal(describeWait(step, context({ now: new Date('2026-10-11T08:00:00Z') })), 'until 2026-10-14 08:00Z — 3d left');
});

test('deploy: not landed, no deployed row, a row without the sha, one too young, one old enough', () => {
  const step = blocked({ kind: 'deploy', name: 'deploy-step-3-24h', step: 3, hours: 24 });
  const notLanded = context({ stepsOf: () => [{}, {}, { status: 'landing', pr: 9 }, {}] });
  assert.deepEqual(blockerDue(step, notLanded), { due: false });
  assert.equal(describeWait(step, notLanded), 'on deploy of step 3 + 24h — step 3 not landed');

  assert.deepEqual(blockerDue(step, context()), { due: false });
  assert.equal(describeWait(step, context()), 'on deploy of step 3 + 24h — not deployed yet');

  const failed = context({ deploys: [deployed('ccc0001', '2026-10-01T00:00:00Z', 'failed')] });
  assert.deepEqual(blockerDue(step, failed), { due: false }, 'a failed deploy is not one');

  const without = context({ deploys: [deployed('bbb0001', '2026-10-01T00:00:00Z')] });
  assert.deepEqual(blockerDue(step, without), { due: false });
  assert.equal(describeWait(step, without), 'on deploy of step 3 + 24h — not deployed yet');

  // The earliest row that contains it counts, not the latest.
  const young = context({ deploys: [deployed('ccc0002', '2026-10-11T12:00:00Z'), deployed('ccc0001', '2026-10-11T00:40:00Z')] });
  assert.deepEqual(blockerDue(step, young), { due: false });
  assert.equal(describeWait(step, young), 'on deploy of step 3 + 24h — 7h40m left');

  const old = context({ deploys: [deployed('4f2a1c9eeee', '2026-10-10T09:12:00Z')], contains: () => true });
  assert.deepEqual(blockerDue(step, old), { due: true, why: 'deploy 4f2a1c9 ended 2026-10-10T09:12Z, + 24h' });
});

test('deploy with no hours is due when the deploy has ended, and says so without a delay', () => {
  const step = blocked({ kind: 'deploy', name: 'deploy-step-3', step: 3 });
  assert.equal(describeWait(step, context()), 'on deploy of step 3 — not deployed yet');
  assert.deepEqual(blockerDue(step, context({ deploys: [deployed('ccc0001', '2026-10-11T16:59:00Z')] })), { due: true, why: 'deploy ccc0001 ended 2026-10-11T16:59Z' });
});

test('project: due when its plan on main is done; not when it is not done, nor when it is not on main', () => {
  const step = blocked({ kind: 'project', name: 'y' });
  const done = context({ plans: [{ project: 'y', status: 'done' }] });
  assert.deepEqual(blockerDue(step, done), { due: true, why: 'project y is done' });
  const open = context({ plans: [{ project: 'y', status: 'ready' }] });
  assert.deepEqual(blockerDue(step, open), { due: false });
  assert.equal(describeWait(step, open), 'on project y — not done');
  assert.deepEqual(blockerDue(step, context()), { due: false });
  assert.equal(describeWait(step, context()), 'on project y — not on main');
});

test('decision and workarea are a person\'s: never due', () => {
  for (const kind of ['decision', 'workarea']) {
    assert.deepEqual(blockerDue(blocked({ kind, name: 'x' }), context()), { due: false });
    assert.equal(describeWait(blocked({ kind, name: 'x' }), context()), `on ${kind} x`);
  }
});

test('ago and left share their units', () => {
  const now = Date.parse('2026-10-11T17:00:00Z');
  assert.equal(ago('2026-10-11T16:20:00Z', now), '40m ago');
  assert.equal(ago('2026-10-08T17:00:00Z', now), '3d ago');
  assert.equal(left(40 * 60_000), '40m');
  assert.equal(left(7 * 3600_000), '7h');
  assert.equal(left(72 * 3600_000), '3d');
});

/* ------------------------------------------------------------ releaseDue */

const ROOT = '/w';

/** A plan record as `listPlans` builds it: two steps, the first done, the second as given. */
function record(project, second, repo = 'memoro') {
  const plan = {
    schema: 'mc-plan',
    version: 1,
    goal: ['g'],
    contract: ['c'],
    out_of_scope: ['o'],
    success_criteria: [{ met: false, criterion: 'x', check: 'y' }],
    documents: [],
    steps: [
      { title: 'S1 — one', status: 'done', done_when: 'one', instruction: [], pr: null, blocked_by: null },
      { title: 'S2 — two', done_when: 'two', instruction: ['Do it.'], pr: null, blocked_by: null, ...second },
    ],
  };
  return { repo, programme: 'p', project, path: `docs/project/p/${project}/PLAN.json`, plan, ...planSummary(plan) };
}

/** The register in memory, seeded the way `queue()` seeds it, and the records laid over it. */
function world(records) {
  const files = {};
  const read = (path) => files[path] ?? null;
  const write = (path, value) => { files[path] = `${JSON.stringify(value, null, 2)}\n`; };
  const plans = overlayPlans(records, { root: ROOT, read, write, now: '2026-10-11T00:00:00Z' });
  const said = [];
  const entry = (project) => JSON.parse(files[registerPath(ROOT, project)]);
  return { files, read, write, plans, said, say: (line) => said.push(line), entry };
}

const onTime = (at) => ({ status: 'blocked', blocked_by: { kind: 'time', name: 'until-x', at } });

test('releaseDue: a due time step is written ready with the comment and comes back ready; one not due is untouched', () => {
  const w = world([record('due', onTime('2026-10-11T16:00:00Z')), record('later', onTime('2026-10-12T16:00:00Z'))]);
  const out = releaseDue(w.plans, { root: ROOT, now: NOW, read: w.read, write: w.write, say: w.say });

  const due = out.find((r) => r.project === 'due');
  assert.equal(due.status, 'ready', 'the picker sees ready in the same pass');
  assert.equal(due.plan.steps[1].status, 'ready');
  assert.equal(due.plan.steps[1].blocked_by, null);
  const written = w.entry('due').steps[1];
  assert.equal(written.status, 'ready');
  assert.equal(written.blocked_by, null);
  assert.deepEqual(written.comments, ['Released 2026-10-11T17:00:00Z: time 2026-10-11T16:00Z passed']);
  assert.deepEqual(w.said, ['due step 2: released — time 2026-10-11T16:00Z passed']);

  const later = out.find((r) => r.project === 'later');
  assert.equal(later, w.plans.find((r) => r.project === 'later'), 'not due: the record as it was');
  assert.equal(w.entry('later').steps[1].status, 'blocked');
});

test('releaseDue: a project blocker on a project in the other repository is released', () => {
  const finished = record('y', { status: 'done' }, 'memoro-cli');
  const w = world([record('x', { status: 'blocked', blocked_by: { kind: 'project', name: 'y' } }), finished]);
  const out = releaseDue(w.plans, { root: ROOT, now: NOW, read: w.read, write: w.write, say: w.say });
  assert.equal(out.find((r) => r.project === 'x').status, 'ready');
  assert.deepEqual(w.entry('x').steps[1].comments, ['Released 2026-10-11T17:00:00Z: project y is done']);
});

test('releaseDue: a deploy blocker is released once the landed step is deployed and the hours have passed', () => {
  const step = () => ({ status: 'blocked', blocked_by: { kind: 'deploy', name: 'deploy-step-1', step: 1, hours: 2 } });
  const w = world([record('d', step())]);
  const entry = w.entry('d');
  entry.steps[0].landed = { sha: SHA, at: '2026-10-11T10:00:00Z' };
  w.write(registerPath(ROOT, 'd'), entry);
  const young = releaseDue(w.plans, { root: ROOT, now: NOW, read: w.read, write: w.write, say: w.say, deploys: [deployed('ccc1', '2026-10-11T16:00:00Z')], contains: (sha, row) => sha === SHA && row === 'ccc1' });
  assert.equal(young[0].status, 'blocked');
  const old = releaseDue(w.plans, { root: ROOT, now: NOW, read: w.read, write: w.write, say: w.say, deploys: [deployed('ccc1', '2026-10-11T14:00:00Z')], contains: (sha, row) => sha === SHA && row === 'ccc1' });
  assert.equal(old[0].status, 'ready');
  assert.deepEqual(w.entry('d').steps[1].comments, ['Released 2026-10-11T17:00:00Z: deploy ccc1 ended 2026-10-11T14:00Z, + 2h']);
});

test('releaseDue: one record that throws is said and left; the others are released', () => {
  const w = world([record('bad', onTime('2026-10-11T16:00:00Z')), record('good', onTime('2026-10-11T16:00:00Z'))]);
  const update = (project, index, patch) => {
    if (project === 'bad') throw new Error('the register refused it');
    w.files[registerPath(ROOT, project)] = JSON.stringify({ ...w.entry(project), steps: w.entry(project).steps.map((s, i) => (i === index ? { ...s, status: patch.status, comments: [patch.comment] } : s)) });
  };
  const out = releaseDue(w.plans, { root: ROOT, now: NOW, read: w.read, say: w.say, update });
  assert.equal(out.find((r) => r.project === 'bad').status, 'blocked');
  assert.equal(out.find((r) => r.project === 'good').status, 'ready');
  assert.deepEqual(w.said, [
    'bad step 2: not released — the register refused it',
    'good step 2: released — time 2026-10-11T16:00Z passed',
  ]);
});

test('releaseDue: a blocked step behind another stopped step is not reached, and a decision is never released', () => {
  const behind = record('behind', onTime('2026-10-11T16:00:00Z'));
  behind.plan.steps[0] = { ...behind.plan.steps[0], status: 'blocked', blocked_by: { kind: 'decision', name: 'q' } };
  Object.assign(behind, planSummary(behind.plan));
  const w = world([behind]);
  const out = releaseDue(w.plans, { root: ROOT, now: NOW, read: w.read, write: w.write, say: w.say });
  assert.equal(out[0], w.plans[0]);
  assert.deepEqual(w.said, []);
  assert.equal(w.entry('behind').steps[1].status, 'blocked');
});

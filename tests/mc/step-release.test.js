import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ago, blockerDue, describeWait, left } from '../../src/mc/step-release.js';

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

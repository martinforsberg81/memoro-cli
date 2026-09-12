import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STEP_STATES, applyEntry, currentIndex, overlayPlans, parseEntry, parseStepEnv, patchStep, reconcileEntry,
  registerPath, seedEntry, updateStep,
} from '../../src/mc/register.js';
import { PLAN_SCHEMA, PLAN_VERSION, deliverableStep, validatePlan } from '../../src/mc/plan-schema.js';

const step = (over = {}) => ({
  title: 't', status: 'ready', done_when: 'd', instruction: ['i'], comments: [], pr: null, blocked_by: null, ...over,
});
const plan = (steps) => ({
  schema: PLAN_SCHEMA, version: PLAN_VERSION, goal: ['g'], contract: ['c'], out_of_scope: ['o'],
  success_criteria: [{ met: false, criterion: 'x', check: 'y' }], documents: [], steps,
});
const record = (steps, over = {}) => ({ repo: 'memoro', programme: 'prog', project: 'p', path: 'docs/project/prog/p/PLAN.json', legacy: false, plan: plan(steps), problems: [], ...over });

/** An in-memory register: `files` is the disk, and the lock is nobody's. */
function disk(initial = {}) {
  const files = { ...initial };
  return {
    files,
    io: {
      read: (path) => files[path] ?? null,
      write: (path, value) => { files[path] = `${JSON.stringify(value, null, 2)}\n`; },
      lock: (_root, fn) => fn(),
    },
  };
}

test('seedEntry reads a plan file\'s own state once: done with its pr, blocked with its blocker, ready otherwise', () => {
  const entry = seedEntry(record([
    step({ status: 'done', pr: 7, comments: ['landed'] }),
    step({ status: 'blocked', blocked_by: { kind: 'decision', name: 'q-1' } }),
    step(),
  ]), '2026-09-12T10:00:00Z');
  assert.equal(entry.project, 'p');
  assert.equal(entry.plan, 'docs/project/prog/p/PLAN.json');
  assert.deepEqual(entry.steps.map((s) => s.status), ['done', 'blocked', 'ready']);
  assert.equal(entry.steps[0].pr, 7);
  assert.deepEqual(entry.steps[0].comments, ['landed']);
  assert.deepEqual(entry.steps[1].blocked_by, { kind: 'decision', name: 'q-1' });
  assert.equal(entry.steps[2].updated, '2026-09-12T10:00:00Z');
});

test('applyEntry lays the register over the file, and the summary is recomputed from it', () => {
  const rec = record([step({ status: 'done', pr: 1 }), step(), step()]);
  const entry = patchStep(seedEntry(rec), 1, { status: 'failed', reason: 'the gate was red', pr: 9 }, 'now');
  const out = applyEntry(rec, entry);
  assert.equal(out.plan.steps[1].status, 'failed');
  assert.equal(out.plan.steps[1].pr, 9);
  assert.equal(out.status, 'failed', 'planSummary reads the overlaid steps');
  assert.match(out.next, /step 2 failed — #9 is open; mc step ready/u);
  // The file's own step is untouched: the record is a new object.
  assert.equal(rec.plan.steps[1].status, 'ready');
  // And the overlaid plan still validates: running and failed are schema words now.
  assert.equal(validatePlan(out.plan).ok, true);
  assert.equal(deliverableStep(out.plan).step, null, 'a failed step is never handed out');
});

test('patchStep refuses what it cannot record: an unknown status, blocked without a blocker, failed without a reason', () => {
  const entry = seedEntry(record([step()]));
  assert.throws(() => patchStep(entry, 0, { status: 'parked' }), /status must be one of ready, running, done, failed, blocked/u);
  assert.throws(() => patchStep(entry, 0, { status: 'blocked' }), /names what it waits for/u);
  assert.throws(() => patchStep(entry, 0, { status: 'failed' }), /says why/u);
  assert.throws(() => patchStep(entry, 3, { status: 'done' }), /no step 4 — the plan has 1/u);
  assert.deepEqual(STEP_STATES, ['ready', 'running', 'done', 'failed', 'blocked']);
});

test('patchStep clears what the new status makes meaningless, and appends a comment when asked', () => {
  let entry = seedEntry(record([step()]));
  entry = patchStep(entry, 0, { status: 'running', session: { pid: 42, started: 't0' } }, 't0');
  assert.equal(entry.steps[0].session.pid, 42);
  entry = patchStep(entry, 0, { status: 'blocked', blocked_by: { kind: 'workarea', name: 'dirty-worktree' }, comment: 'Blocked: x' }, 't1');
  assert.equal(entry.steps[0].session, null, 'a step that is not running has no session');
  assert.deepEqual(entry.steps[0].comments, ['Blocked: x']);
  entry = patchStep(entry, 0, { status: 'ready' }, 't2');
  assert.equal(entry.steps[0].blocked_by, null, 'a step that is not blocked waits on nothing');
  assert.equal(entry.updated, 't2');
});

test('reconcileEntry follows the plan: a step added at the end is seeded, one removed is dropped, nothing else moves', () => {
  const entry = patchStep(seedEntry(record([step(), step()])), 0, { status: 'done', pr: 3 });
  const grown = reconcileEntry(entry, record([step(), step(), step({ status: 'blocked', blocked_by: { kind: 'project', name: 'other' } })]), 'now');
  assert.equal(grown.changed, true);
  assert.deepEqual(grown.entry.steps.map((s) => s.status), ['done', 'ready', 'blocked']);
  assert.equal(grown.entry.steps[0].pr, 3, 'the register\'s word on a step it already had');
  const shrunk = reconcileEntry(grown.entry, record([step()]));
  assert.equal(shrunk.entry.steps.length, 1);
  const same = reconcileEntry(shrunk.entry, record([step()]));
  assert.equal(same.changed, false);
});

test('overlayPlans seeds a plan the register has never seen, writes it, and reads the register from then on', () => {
  const { files, io } = disk();
  const rec = record([step(), step()]);
  const [first] = overlayPlans([rec], { root: '/w', ...io, now: 't0' });
  assert.equal(first.plan.steps[0].status, 'ready');
  const path = registerPath('/w', 'p');
  assert.ok(files[path], 'seeded on first sight');
  // The register moves; the file on main does not. The reader sees the register.
  updateStep({ root: '/w', project: 'p', index: 0, patch: { status: 'failed', reason: 'red', pr: 5 }, ...io, now: 't1' });
  const [second] = overlayPlans([rec], { root: '/w', ...io, now: 't2' });
  assert.equal(second.plan.steps[0].status, 'failed');
  assert.equal(second.plan.steps[0].pr, 5);
  assert.equal(second.status, 'failed');
  // No root, no register: the fixtures that hand readers plans without a work root get the file's word.
  const [bare] = overlayPlans([rec], { root: null, ...io });
  assert.equal(bare.plan.steps[0].status, 'ready');
  // A legacy or unreadable record passes through untouched.
  const legacy = { ...rec, legacy: true, plan: null };
  assert.equal(overlayPlans([legacy], { root: '/w', ...io })[0], legacy);
});

test('updateStep refuses a project the register has never seen — a reader seeds it first', () => {
  const { io } = disk();
  assert.throws(() => updateStep({ root: '/w', project: 'ghost', index: 0, patch: { status: 'done' }, ...io }), /ghost: not in the register/u);
});

test('parseEntry tolerates an older or hand-edited file, and refuses what is not an entry', () => {
  const entry = parseEntry(JSON.stringify({ project: 'p', steps: [{ status: 'nonsense', pr: '12', comments: ['a', 3] }, null] }));
  assert.equal(entry.steps[0].status, 'ready');
  assert.equal(entry.steps[0].pr, 12);
  assert.deepEqual(entry.steps[0].comments, ['a']);
  assert.equal(entry.steps[1].status, 'ready');
  assert.equal(parseEntry('not json'), null);
  assert.equal(parseEntry(JSON.stringify({ steps: [] })), null, 'no project, no entry');
});

test('currentIndex is the running step, else the first not done; parseStepEnv reads MC_STEP', () => {
  const entry = seedEntry(record([step({ status: 'done' }), step(), step()]));
  assert.equal(currentIndex(entry), 1);
  assert.equal(currentIndex(patchStep(entry, 2, { status: 'running' })), 2);
  assert.equal(currentIndex(seedEntry(record([step({ status: 'done' })]))), -1);
  assert.deepEqual(parseStepEnv('items-sweep:3'), { project: 'items-sweep', index: 3 });
  assert.equal(parseStepEnv('nope'), null);
  assert.equal(parseStepEnv(undefined), null);
});

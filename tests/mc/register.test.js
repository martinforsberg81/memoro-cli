import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  STEP_STATES, applyEntry, criteriaFromPlan, currentIndex, dropCriterion, keyOf, listEntries, markCriterion, normaliseEntry, overlayPlans, parseEntry, parseStepEnv,
  patchStep, readEntry, realLock, reconcileEntry, registerDir, registerLogPath, registerPath, seedEntry, stepKey, updateCriterion, updateStep, whoAmI,
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

/** An in-memory register: `files` is the disk, and the lock and the log are nobody's. */
function disk(initial = {}) {
  const files = { ...initial };
  return {
    files,
    io: {
      read: (path) => files[path] ?? null,
      write: (path, value) => { files[path] = `${JSON.stringify(value, null, 2)}\n`; },
      lock: (_root, fn) => fn(),
      append: () => {},
      by: () => ({}),
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

test('patchStep keeps an interrupted record while the step is ready or running, and clears it on any other status', () => {
  const rec = record([step(), step()]);
  const record1 = { at: 'now', session_id: 's-1', tool: 'claude', count: 1 };
  let entry = patchStep(seedEntry(rec), 0, { status: 'ready', interrupted: record1 }, 'now');
  assert.deepEqual(entry.steps[0].interrupted, record1);
  assert.equal(parseEntry(JSON.stringify(entry)).steps[0].interrupted.session_id, 's-1', 'the register file keeps it');
  assert.equal(parseEntry(JSON.stringify(entry)).steps[1].interrupted, null);
  entry = patchStep(entry, 0, { status: 'running', session: { pid: 4 } }, 'now');
  assert.deepEqual(entry.steps[0].interrupted, record1, 'kept while the next session runs');
  for (const [status, extra] of [['landing', {}], ['done', {}], ['failed', { reason: 'r' }], ['blocked', { blocked_by: { kind: 'decision', name: 'q-1' } }]]) {
    assert.equal(patchStep(entry, 0, { status, ...extra }, 'now').steps[0].interrupted, null, status);
  }
});

test('patchStep keeps the answer to a parked step while it is ready or running, and clears it once a session has had it', () => {
  const rec = record([step(), step()]);
  const answered = { name: 'q-1', answer: 'No.', at: 'now' };
  let entry = patchStep(seedEntry(rec), 0, { status: 'ready', pr: 9, answered }, 'now');
  assert.deepEqual(parseEntry(JSON.stringify(entry)).steps[0].answered, answered, 'the register file keeps it');
  assert.equal(parseEntry(JSON.stringify(entry)).steps[1].answered, null);
  entry = patchStep(entry, 0, { status: 'running', session: { pid: 4 } }, 'now');
  assert.deepEqual(entry.steps[0].answered, answered, 'kept while the session runs');
  for (const [status, extra] of [['landing', {}], ['done', {}], ['failed', { reason: 'r' }], ['blocked', { blocked_by: { kind: 'decision', name: 'q-2' } }]]) {
    assert.equal(patchStep(entry, 0, { status, ...extra }, 'now').steps[0].answered, null, status);
  }
});

test('applyEntry lays the register over the file, and the summary is recomputed from it', () => {
  const rec = record([step({ status: 'done', pr: 1 }), step(), step()]);
  const entry = patchStep(seedEntry(rec), 1, { status: 'failed', reason: 'the gate was red', pr: 9 }, 'now');
  const out = applyEntry(rec, entry);
  assert.equal(out.plan.steps[1].status, 'failed');
  assert.equal(out.plan.steps[1].pr, 9);
  assert.equal(out.plan.steps[1].reason, 'the gate was red', 'the register\'s reason reaches the plan step');
  assert.equal(out.status, 'failed', 'planSummary reads the overlaid steps');
  assert.equal(out.next, 'step 2 failed: the gate was red — #9 is open; mc step ready starts it again');
  // The file's own step is untouched: the record is a new object.
  assert.equal(rec.plan.steps[1].status, 'ready');
  // And the overlaid plan still validates: running and failed are schema words now.
  assert.equal(validatePlan(out.plan).ok, true);
  assert.equal(deliverableStep(out.plan).step, null, 'a failed step is never handed out');
});

test('patchStep refuses what it cannot record: an unknown status, blocked without a blocker, failed without a reason', () => {
  const entry = seedEntry(record([step()]));
  assert.throws(() => patchStep(entry, 0, { status: 'parked' }), /status must be one of ready, running, landing, done, failed, blocked/u);
  assert.throws(() => patchStep(entry, 0, { status: 'blocked' }), /names what it waits for/u);
  assert.throws(() => patchStep(entry, 0, { status: 'failed' }), /says why/u);
  assert.throws(() => patchStep(entry, 3, { status: 'done' }), /no step 4 — the plan has 1/u);
  assert.deepEqual(STEP_STATES, ['ready', 'running', 'landing', 'done', 'failed', 'blocked']);
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

test('stepKey is the label a title opens with, or the whole title', () => {
  assert.equal(stepKey({ title: 'W4.1.2 — actions: the W4 scope in W1\'s action modules' }), 'W4.1.2');
  assert.equal(stepKey({ title: 'The hero object' }), 'The hero object');
  assert.equal(stepKey({ title: 'sql-readiness closes' }), 'sql-readiness closes');
  assert.equal(stepKey({}), null);
  assert.equal(stepKey({ title: '8. The close' }), 'The close');
  assert.equal(stepKey({ title: '5) The close' }), 'The close');
  assert.equal(stepKey({ title: 'Step 3: Wire it — the rest' }), 'Wire it');
  assert.equal(stepKey({ title: '1.2 thing' }), '1.2 thing');
  assert.equal(keyOf('5. The close'), 'The close');
});

test('a renumbered close keeps its state and the steps inserted before it start fresh (photo-viewer, #13580)', () => {
  const t = (s) => step({ title: s });
  let entry = seedEntry(record([t('1. A'), t('2. B'), t('3. C'), t('4. D'), t('5. The close')]), 't0');
  for (const index of [0, 1, 2, 3]) entry = patchStep(entry, index, { status: 'done', pr: index + 1 }, 't1');
  entry = patchStep(entry, 4, {
    status: 'blocked',
    blocked_by: { kind: 'decision', name: 'martin-phone-fling-check' },
    branch: 'photo-viewer-8',
    stacked_on: { index: 3, pr: 13527, sha: 'abc' },
    comment: 'mc merge memoro 13528',
  }, 't1');
  const renumbered = reconcileEntry(entry, record([t('1. A'), t('2. B'), t('3. C'), t('4. D'), t('5. The reserve shrinks'), t('6. E'), t('7. F'), t('8. The close')]), 't2');
  assert.deepEqual(renumbered.entry.steps.map((s) => [s.key, s.status]), [
    ['A', 'done'], ['B', 'done'], ['C', 'done'], ['D', 'done'], ['The reserve shrinks', 'ready'], ['E', 'ready'], ['F', 'ready'], ['The close', 'blocked'],
  ]);
  assert.equal(renumbered.entry.steps[7].branch, 'photo-viewer-8', 'the close keeps its branch');
  for (const index of [4, 5, 6]) {
    assert.equal(renumbered.entry.steps[index].branch, null, `step ${index + 1} starts fresh`);
    assert.deepEqual(renumbered.entry.steps[index].comments, []);
  }
  assert.deepEqual(renumbered.carried, []);
});

test('a slot carried by position keeps its status and loses the replaced step\'s pull request fields', () => {
  const titled = (label, over = {}) => step({ title: `${label} — what it does`, ...over });
  let entry = seedEntry(record([titled('A'), titled('B')]), 't0');
  entry = patchStep(entry, 1, { status: 'failed', reason: 'red', pr: 9, branch: 'p-3', attempts: 2 }, 't1');
  const carried = reconcileEntry(entry, record([titled('A'), titled('Z')]), 't2');
  const slot = carried.entry.steps[1];
  assert.equal(slot.key, 'Z');
  assert.equal(slot.status, 'failed', 'the slot keeps its status');
  assert.equal(slot.reason, 'red');
  assert.equal(slot.pr, null);
  assert.equal(slot.branch, null);
  assert.equal(slot.attempts, 0);
  assert.match(slot.comments.at(-1), /^Carried by position on t2 from 'B'/u);
  assert.deepEqual(carried.carried, [{ index: 1, from: 'B', to: 'Z' }]);
});

test('an entry written with numbered keys is read through keyOf and written once', () => {
  const old = parseEntry(JSON.stringify({ project: 'p', steps: [{ key: '1. A', status: 'done', pr: 3 }, { key: '2. B', status: 'ready' }] }));
  const plan = record([step({ title: '1. A — x' }), step({ title: '2. B — x' })]);
  const once = reconcileEntry(old, plan, 't1');
  assert.deepEqual(once.entry.steps.map((s) => s.key), ['A', 'B']);
  assert.deepEqual(once.entry.steps.map((s) => s.status), ['done', 'ready']);
  assert.equal(once.changed, true);
  assert.deepEqual(once.carried, []);
  assert.equal(reconcileEntry(once.entry, plan, 't2').changed, false, 'the second read writes nothing');
});

test('reconcileEntry matches by key: a moved step keeps its state, an inserted one is seeded, a retitled one stays', () => {
  const titled = (label, over = {}) => step({ title: `${label} — what it does`, ...over });
  let entry = seedEntry(record([titled('A'), titled('B'), titled('C')]), 't0');
  entry = patchStep(entry, 0, { status: 'done', pr: 7 }, 't1');
  entry = patchStep(entry, 1, { status: 'failed', reason: 'red', branch: 'p' }, 't1');

  // B moves behind C, and X is inserted in front: 2026-09-18, W4.1.2 behind W4.1.8.
  const moved = reconcileEntry(entry, record([titled('X'), titled('A'), titled('C'), titled('B')]), 't2');
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.entry.steps.map((s) => [s.key, s.status]), [['X', 'ready'], ['A', 'done'], ['C', 'ready'], ['B', 'failed']]);
  assert.equal(moved.entry.steps[3].reason, 'red');

  // A label nobody knows, in the slot of one the plan no longer has: the same step, retitled.
  const renamed = reconcileEntry(entry, record([titled('A1'), titled('B'), titled('C')]), 't2');
  assert.deepEqual(renamed.entry.steps.map((s) => [s.key, s.status]), [['A1', 'done'], ['B', 'failed'], ['C', 'ready']]);
  assert.equal(renamed.entry.steps[0].pr, 7, 'a done step carried by position keeps its pull request');

  // Nothing moved, nothing written.
  assert.equal(reconcileEntry(entry, record([titled('A'), titled('B'), titled('C')]), 't2').changed, false);
});

test('reconcileEntry gives an entry written before keys its keys by index, and leaves a running step where its session knows it', () => {
  const titled = (label) => step({ title: `${label} — x` });
  const old = parseEntry(JSON.stringify({ project: 'p', steps: [{ status: 'done', pr: 3 }, { status: 'ready' }] }));
  const keyed = reconcileEntry(old, record([titled('A'), titled('B')]), 't1');
  assert.equal(keyed.changed, true);
  assert.deepEqual(keyed.entry.steps.map((s) => [s.key, s.status]), [['A', 'done'], ['B', 'ready']]);

  const running = patchStep(keyed.entry, 1, { status: 'running', session: { pid: 1 } }, 't2');
  const held = reconcileEntry(running, record([titled('B'), titled('A')]), 't3');
  assert.equal(held.changed, false, 'MC_STEP names an index; the move waits for the session to end');
  assert.equal(held.entry, running);
});

test('patchStep refuses a blocker whose name is a sentence or whose kind the plan schema does not know', () => {
  const entry = seedEntry(record([step()]), 't0');
  assert.throws(() => patchStep(entry, 0, { status: 'blocked', blocked_by: { kind: 'decision', name: 'project:sql-w1-universe-closure' } }), /a name, not a sentence/u);
  assert.throws(() => patchStep(entry, 0, { status: 'blocked', blocked_by: { kind: 'whim', name: 'q-1' } }), /kind/u);
  assert.equal(patchStep(entry, 0, { status: 'blocked', blocked_by: { kind: 'project', name: 'sql-w1-universe-closure' } }).steps[0].status, 'blocked');
});

test('a time or deploy blocker keeps its fields through normaliseEntry and patchStep, and a non-blocked patch clears them', () => {
  const entry = seedEntry(record([step(), step(), step()]), 't0');
  const time = { kind: 'time', name: 'until-20261014-0800', at: '2026-10-14T08:00:00Z' };
  const deploy = { kind: 'deploy', name: 'deploy-step-1-24h', step: 1, hours: 24 };
  let next = patchStep(entry, 1, { status: 'blocked', blocked_by: time }, 't1');
  next = patchStep(next, 2, { status: 'blocked', blocked_by: deploy }, 't1');
  const read = parseEntry(JSON.stringify(next));
  assert.deepEqual(read.steps[1].blocked_by, time);
  assert.deepEqual(read.steps[2].blocked_by, deploy);
  // What is not of the field's type is dropped, not kept as it was.
  const odd = parseEntry(JSON.stringify({ project: 'p', steps: [{ status: 'blocked', blocked_by: { kind: 'deploy', name: 'd', step: '1', hours: 'x', at: 3 } }] }));
  assert.deepEqual(odd.steps[0].blocked_by, { kind: 'deploy', name: 'd' });
  // A seeded plan keeps them too, and applyEntry lays them over the file.
  const seeded = seedEntry(record([step(), step({ status: 'blocked', blocked_by: deploy })]), 't0');
  assert.deepEqual(seeded.steps[1].blocked_by, deploy);
  assert.deepEqual(applyEntry(record([step(), step()]), seeded).plan.steps[1].blocked_by, deploy);
  assert.equal(patchStep(read, 2, { status: 'ready' }, 't2').steps[2].blocked_by, null);
});

test('patchStep refuses a time or deploy blocker the plan schema would refuse', () => {
  const entry = seedEntry(record([step(), step(), step()]), 't0');
  assert.throws(() => patchStep(entry, 1, { status: 'blocked', blocked_by: { kind: 'time', name: 'until-x', at: 'soon' } }), /blocked_by\.at/u);
  assert.throws(() => patchStep(entry, 1, { status: 'blocked', blocked_by: { kind: 'deploy', name: 'deploy-step-2', step: 2 } }), /blocked_by\.step/u);
  assert.throws(() => patchStep(entry, 2, { status: 'blocked', blocked_by: { kind: 'deploy', name: 'deploy-step-1', step: 1, hours: -2 } }), /blocked_by\.hours/u);
  assert.throws(() => patchStep(entry, 1, { status: 'blocked', blocked_by: { kind: 'project', name: 'y', at: '2026-10-14T08:00:00Z' } }), /only a time blocker/u);
});

test('updateStep appends one line naming the process', () => {
  const { io } = disk();
  const lines = [];
  const append = (path, line) => lines.push([path, line]);
  const by = () => ({ pid: 7, ppid: 6, parent: 'zsh', run: 'run_x', argv: { verb: 'step', sub: 'ready' }, cwd: '/home/m/memoro', mc_step: null });
  overlayPlans([record([step(), step()])], { root: '/w', ...io, append, by });
  updateStep({ root: '/w', project: 'p', index: 0, patch: { status: 'done', pr: 3 }, ...io, append, by });
  updateStep({ root: '/w', project: 'p', index: 0, patch: { status: 'ready' }, ...io, append, by });
  assert.equal(lines.length, 3, 'the seed, then one line per write');
  assert.ok(lines.every(([path]) => path === registerLogPath('/w')));
  const parsed = lines.map(([, line]) => JSON.parse(line));
  assert.equal(parsed[0].event, 'seed');
  assert.deepEqual(parsed[0].statuses, ['ready', 'ready']);
  const last = parsed.at(-1);
  assert.equal(last.event, 'step');
  assert.equal(last.project, 'p');
  assert.equal(last.index, 0);
  assert.equal(last.from, 'done');
  assert.equal(last.to, 'ready');
  assert.deepEqual(last.fields, ['status']);
  assert.equal(last.by.parent, 'zsh');
  assert.equal(last.by.argv.sub, 'ready');
});

test('a log that cannot be written never fails the write', () => {
  const { files, io } = disk();
  const broken = () => { throw new Error('disk full'); };
  const [seeded] = overlayPlans([record([step()])], { root: '/w', ...io, append: broken });
  assert.equal(seeded.plan.steps[0].status, 'ready', 'the seed is written and read');
  const entry = updateStep({ root: '/w', project: 'p', index: 0, patch: { status: 'done' }, ...io, append: broken });
  assert.equal(entry.steps[0].status, 'done');
  assert.equal(parseEntry(files[registerPath('/w', 'p')]).steps[0].status, 'done');
});

test('whoAmI names this process', () => {
  const who = whoAmI();
  assert.equal(who.pid, process.pid);
  assert.equal(who.ppid, process.ppid);
  assert.match(who.run, /^run_/u);
  assert.ok(who.argv && typeof who.argv === 'object');
});

test('a re-plan that carries a slot is logged with what it carried', () => {
  const { io } = disk();
  const titled = (label) => step({ title: `${label} — what it does` });
  const lines = [];
  const append = (path, line) => lines.push(JSON.parse(line));
  overlayPlans([record([titled('A'), titled('B')])], { root: '/w', ...io, now: 't0' });
  overlayPlans([record([titled('A'), titled('Z')])], { root: '/w', ...io, append, now: 't2' });
  const last = lines.at(-1);
  assert.equal(last.event, 'reconcile');
  assert.deepEqual(last.carried, [{ index: 1, from: 'B', to: 'Z' }]);
});

const criterion = (text, met) => ({ criterion: text, check: 'c', met });
/** A record whose one step is titled `A`, with the given success criteria. */
const withCriteria = (list, steps = [step({ title: 'A — x' })]) => {
  const rec = record(steps);
  rec.plan.success_criteria = list;
  return rec;
};

test('normaliseEntry keeps the criteria the register holds, and reads an entry without them as never seeded', () => {
  const entry = normaliseEntry({
    project: 'p', criteria: [{ criterion: 'x', met: true, at: '2026-10-19T08:00:00Z' }, { criterion: 'y', met: 'yes', at: 3 }, null],
  });
  assert.deepEqual(entry.criteria, [{ criterion: 'x', met: true, at: '2026-10-19T08:00:00Z' }, { criterion: 'y', met: false, at: null }]);
  assert.equal(normaliseEntry({ project: 'p' }).criteria, null);
  assert.deepEqual(criteriaFromPlan(withCriteria([criterion('x', true)]).plan), [{ criterion: 'x', met: false, at: null }]);
  assert.deepEqual(criteriaFromPlan({}), []);
});

test('seedEntry seeds the criteria from the plan, and reads the file\'s met as not met', () => {
  const entry = seedEntry(withCriteria([criterion('x', true), criterion('y', false)]), 't0');
  assert.deepEqual(entry.criteria, [{ criterion: 'x', met: false, at: null }, { criterion: 'y', met: false, at: null }]);
});

test('a plan file\'s met is not read: a criterion the register has not seen is not met, and a held met survives', () => {
  const seeded = seedEntry(withCriteria([criterion('x', true)]), 't0');
  assert.deepEqual(seeded.criteria, [{ criterion: 'x', met: false, at: null }], 'seeded from a file that says met: true');

  const added = reconcileEntry(seeded, withCriteria([criterion('x', false), criterion('y', true)]), 't1');
  assert.equal(added.changed, true);
  assert.deepEqual(added.entry.criteria, [{ criterion: 'x', met: false, at: null }, { criterion: 'y', met: false, at: null }], 'a new text with met: true is added not met');

  const held = markCriterion(seeded, 1, true, 't2');
  const kept = reconcileEntry(held, withCriteria([criterion('x', false)]), 't3');
  assert.equal(kept.changed, false);
  assert.deepEqual(kept.entry.criteria, [{ criterion: 'x', met: true, at: 't2' }], 'the held met is unchanged');
});

test('reconcileEntry seeds criteria on an entry that has none, keeps a held met, lists a new text as not met, drops a removed one', () => {
  const rec = withCriteria([criterion('x', false), criterion('y', false)]);
  const old = { ...seedEntry(rec, 't0'), criteria: null };
  const seeded = reconcileEntry(old, rec, 't1');
  assert.equal(seeded.changed, true);
  assert.deepEqual(seeded.entry.criteria, [{ criterion: 'x', met: false, at: null }, { criterion: 'y', met: false, at: null }]);

  const marked = markCriterion(seeded.entry, 1, true, 't2');
  const kept = reconcileEntry(marked, withCriteria([criterion('x', false), criterion('y', false)]), 't3');
  assert.equal(kept.changed, false, 'a met the register holds is not overwritten by the file');
  assert.equal(kept.entry.criteria[0].met, true);

  const moved = reconcileEntry(marked, withCriteria([criterion('x', false), criterion('z', true)]), 't3');
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.entry.criteria, [{ criterion: 'x', met: true, at: 't2' }, { criterion: 'z', met: false, at: null }]);
});

test('applyEntry lays the held met over the file\'s criteria by text, so a plan whose steps are done is done', () => {
  const rec = withCriteria([criterion('x', false), criterion('y', false)], [step({ title: 'A — x', status: 'done' })]);
  const entry = seedEntry(rec, 't0');
  assert.equal(applyEntry(rec, entry).status, 'unmet');
  const held = markCriterion(markCriterion(entry, 1, true, 't1'), 2, true, 't1');
  const out = applyEntry(rec, held);
  assert.deepEqual(out.plan.success_criteria.map((c) => c.met), [true, true]);
  assert.equal(out.status, 'done');
  assert.equal(rec.plan.success_criteria[0].met, false, 'the file\'s own criteria are untouched');

  const partial = applyEntry(rec, { ...entry, criteria: [{ criterion: 'x', met: true, at: null }] });
  assert.deepEqual(partial.plan.success_criteria.map((c) => c.met), [true, false], 'a criterion it holds no text for stays as the file says');
  assert.equal(partial.status, 'unmet');
});

test('markCriterion sets one criterion\'s met and when, and refuses a number the register does not hold', () => {
  const entry = seedEntry(withCriteria([criterion('x', false), criterion('y', false)]), 't0');
  const marked = markCriterion(entry, 2, true, 't1');
  assert.deepEqual(marked.criteria, [{ criterion: 'x', met: false, at: null }, { criterion: 'y', met: true, at: 't1' }]);
  assert.equal(marked.updated, 't1');
  assert.equal(entry.criteria[1].met, false, 'the entry it was given is not changed');
  assert.throws(() => markCriterion(entry, 0, true), /no success criterion 0 — the register holds 2/u);
  assert.throws(() => markCriterion(entry, 3, true), /no success criterion 3 — the register holds 2/u);
  assert.throws(() => markCriterion({ ...entry, criteria: null }, 1, true), /no success criterion 1 — the register holds 0/u);
});

test('updateCriterion writes the criterion and appends one criterion line naming the change', () => {
  const { files, io } = disk();
  overlayPlans([withCriteria([criterion('x', false), criterion('y', false)])], { root: '/w', ...io, now: 't0' });
  const lines = [];
  const append = (path, line) => lines.push(JSON.parse(line));
  const next = updateCriterion({ root: '/w', project: 'p', number: 2, met: true, ...io, append, now: 't1' });
  assert.equal(next.criteria[1].met, true);
  assert.equal(parseEntry(files[registerPath('/w', 'p')]).criteria[1].met, true, 'written');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'criterion');
  assert.equal(lines[0].project, 'p');
  assert.equal(lines[0].number, 2);
  assert.equal(lines[0].from, false);
  assert.equal(lines[0].to, true);
  assert.throws(() => updateCriterion({ root: '/w', project: 'ghost', number: 1, met: true, ...io }), /ghost: not in the register/u);
});

test('dropCriterion removes the first held criterion of the text, logs the reason, and a text it does not hold changes nothing', () => {
  const { files, io } = disk();
  overlayPlans([withCriteria([criterion('x', false), criterion('y', true), criterion('x', true)])], { root: '/w', ...io, now: 't0' });
  const lines = [];
  const append = (path, line) => lines.push(JSON.parse(line));
  const next = dropCriterion({ root: '/w', project: 'p', text: 'x', reason: 'Nobody can measure it.', ...io, append, now: 't1' });
  assert.deepEqual(next.criteria, [{ criterion: 'y', met: false, at: null }, { criterion: 'x', met: false, at: null }]);
  assert.deepEqual(parseEntry(files[registerPath('/w', 'p')]).criteria, next.criteria, 'written');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'criterion-drop');
  assert.equal(lines[0].project, 'p');
  assert.equal(lines[0].criterion, 'x');
  assert.equal(lines[0].reason, 'Nobody can measure it.');

  const before = files[registerPath('/w', 'p')];
  const same = dropCriterion({ root: '/w', project: 'p', text: 'z', reason: 'Nobody can measure it.', ...io, append, now: 't2' });
  assert.deepEqual(same.criteria, next.criteria);
  assert.equal(files[registerPath('/w', 'p')], before, 'a text it does not hold writes nothing');
  assert.equal(lines.length, 1, 'and logs nothing');
  assert.throws(() => dropCriterion({ root: '/w', project: 'ghost', text: 'x', reason: 'no', ...io }), /ghost: not in the register/u);
});

/**
 * A temporary work root in layout 2 (ruling 51): `programs/a/x/PLAN.json`, and
 * `programs/a/y/` archived with its `CLOSEOUT.json` beside its plan.
 */
function layout2Root() {
  const root = mkdtempSync(join(tmpdir(), 'mc-register-'));
  const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
  put(join(root, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }));
  put(join(root, 'programs', 'a', 'x', 'PLAN.json'), JSON.stringify(plan([step(), step()])));
  put(join(root, 'programs', 'a', 'y', 'PLAN.json'), JSON.stringify(plan([step({ status: 'done', pr: 4 })])));
  put(join(root, 'programs', 'a', 'y', 'CLOSEOUT.json'), '{}');
  return { root, put, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const quiet = { append: () => {}, by: () => ({}) };
const at = (root, project) => record([step(), step()], { repo: 'memoro-cli', programme: 'a', project, path: join(root, 'programs', 'a', project, 'PLAN.json') });

test('layout 2: a project\'s register is STATE.json beside its plan, and a project with none has nowhere to be', () => {
  const { root, cleanup } = layout2Root();
  try {
    assert.equal(registerPath(root, 'x'), join(root, 'programs', 'a', 'x', 'STATE.json'));
    assert.equal(registerPath(root, 'y'), join(root, 'programs', 'a', 'y', 'STATE.json'), 'archived: still beside its plan');
    assert.equal(registerPath(root, 'nope'), null);
    assert.equal(registerDir(root), null, 'no register directory in layout 2');
    assert.equal(readEntry(root, 'nope'), null);
    assert.throws(() => updateStep({ root, project: 'nope', index: 0, patch: { status: 'done' }, ...quiet }),
      { message: 'no project nope under ~/mc/programs — its register has nowhere to be' });
    assert.throws(() => updateCriterion({ root, project: 'nope', number: 1, met: true, ...quiet }), /no project nope under ~\/mc\/programs/u);
  } finally { cleanup(); }
});

test('layout 2: updateStep writes STATE.json and nothing under runner/projects/, and listEntries reads every programme\'s, archived included', () => {
  const { root, cleanup } = layout2Root();
  try {
    overlayPlans([at(root, 'x'), at(root, 'y')], { root, ...quiet, now: 't0' });
    updateStep({ root, project: 'x', index: 0, patch: { status: 'done', pr: 9 }, ...quiet, now: 't1' });
    const state = parseEntry(readFileSync(join(root, 'programs', 'a', 'x', 'STATE.json'), 'utf8'));
    assert.equal(state.steps[0].status, 'done');
    assert.equal(state.steps[0].pr, 9);
    assert.equal(readEntry(root, 'x').steps[0].pr, 9);
    assert.equal(existsSync(join(root, 'runner', 'projects')), false, 'nothing under runner/projects/');
    assert.deepEqual(listEntries(root).map((entry) => entry.project), ['x', 'y']);
  } finally { cleanup(); }
});

test('realLock holds runner/register.lock in layout 2 and runner/projects/.lock in layout 1, and removes it after', () => {
  const { root, cleanup } = layout2Root();
  try {
    const two = join(root, 'runner', 'register.lock');
    assert.equal(realLock(root, () => existsSync(two)), true, 'held while fn runs');
    assert.equal(existsSync(two), false, 'removed after');
    assert.equal(existsSync(join(root, 'runner', 'projects')), false, 'layout 2 makes no register directory');
    rmSync(join(root, 'runner'), { recursive: true });
    const one = join(root, 'runner', 'projects', '.lock');
    assert.equal(realLock(root, () => existsSync(one)), true, 'layout 1: today\'s file');
    assert.equal(existsSync(one), false);
  } finally { cleanup(); }
});

test('overlayPlans seeds STATE.json for a plan with no entry under the lock it is given, and takes none when nothing moves', () => {
  const { root, cleanup } = layout2Root();
  try {
    const held = [];
    const lock = (lockRoot, fn) => { held.push(lockRoot); return fn(); };
    const [seeded] = overlayPlans([at(root, 'x')], { root, ...quiet, lock, now: 't0' });
    assert.deepEqual(held, [root], 'the seed is written under the lock');
    assert.equal(seeded.plan.steps[0].status, 'ready');
    assert.equal(parseEntry(readFileSync(join(root, 'programs', 'a', 'x', 'STATE.json'), 'utf8')).steps.length, 2);
    overlayPlans([at(root, 'x')], { root, ...quiet, lock, now: 't1' });
    assert.deepEqual(held, [root], 'a plan the register agrees with takes no lock');
    // A plan with no project directory has nowhere to keep a register: the file's own state, nothing written.
    const [elsewhere] = overlayPlans([record([step()], { project: 'nope' })], { root, ...quiet, lock });
    assert.equal(elsewhere.project, 'nope');
    assert.deepEqual(held, [root]);
  } finally { cleanup(); }
});

test('overlayPlans reads the entry again inside the lock, so a step written meanwhile is not overwritten', () => {
  const { files, io } = disk();
  overlayPlans([record([step(), step()])], { root: '/w', ...io, now: 't0' });
  const grown = record([step(), step(), step({ title: 'u' })]);
  const lock = (_root, fn) => {
    // Another writer gets in between this reader's first read and its write.
    updateStep({ root: '/w', project: 'p', index: 0, patch: { status: 'done', pr: 8 }, ...io, now: 't1' });
    return fn();
  };
  const [out] = overlayPlans([grown], { root: '/w', ...io, lock, now: 't2' });
  const written = parseEntry(files[registerPath('/w', 'p')]);
  assert.equal(written.steps.length, 3, 'the reconcile is written');
  assert.equal(written.steps[0].status, 'done', 'over the entry as it stood inside the lock');
  assert.equal(out.plan.steps[0].pr, 8);
});

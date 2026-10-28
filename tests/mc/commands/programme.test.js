import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import test from 'node:test';
import { run } from '../../../src/mc/commands/programme.js';
import { autonomousPaths, readProgrammeState, reserveProgrammeRun } from '../../../src/mc/autonomous-state.js';
import { realLock, lockPath } from '../../../src/mc/register.js';
import { withPlanLock } from '../../../src/mc/plan-write.js';
import { stateFixture, foreground, planner, builder, reviewer } from '../autonomous-state-fixture.js';

const invoke = (f, operation, revision, input, deps = {}) => run([operation, f.programme,
  '--expected-revision', String(revision), '--input-file', f.file(input)], { ...f.deps, ...deps });

test('programme commands keep approved revisions immutable and separate from replacement drafts', async () => {
  const f = stateFixture();
  try {
    assert.equal(await invoke(f, 'draft', 1, f.draft), 0, f.err.join(''));
    assert.equal(await invoke(f, 'approve', 2, { by: 'Martin', at: '2026-10-28T12:00:00Z' }), 0, f.err.join(''));
    const first = f.json(f.paths.programme).approved[0];
    const second = { ...f.draft, revision: 2, based_on: 1, goal: ['A new agreed goal.'] };
    assert.equal(await invoke(f, 'draft', 3, second), 0, f.err.join(''));
    let state = readProgrammeState(f.root, f.programme);
    assert.deepEqual(state.approved, [first]); assert.deepEqual(state.draft, second);
    assert.equal(state.execution_enabled, false);
    assert.equal(await invoke(f, 'draft', 4, { ...second, goal: ['An edited draft.'] }), 0);
    assert.equal(await invoke(f, 'approve', 5, { by: 'Martin', at: '2026-10-28T13:00:00Z' }), 0);
    state = readProgrammeState(f.root, f.programme);
    assert.deepEqual(state.approved[0], first); assert.equal(state.approved[1].revision, 2); assert.equal(state.draft, null);
    assert.equal(await run(['show', f.programme], f.deps), 0);
  } finally { f.cleanup(); }
});

test('programme mutations deny stale writers, unowned runs and non-foreground roles without writing', async () => {
  const f = stateFixture();
  try {
    const before = readFileSync(f.paths.programme, 'utf8');
    for (const actor of [planner, builder, reviewer, { ...foreground, run_id: 'another-run' }, undefined]) {
      assert.equal(await invoke(f, 'draft', 1, f.draft, { actor }), 1);
      assert.equal(readFileSync(f.paths.programme, 'utf8'), before);
    }
    assert.equal(await invoke(f, 'draft', 0, f.draft), 1);
    assert.equal(await invoke(f, 'draft', 1, { ...f.draft, revision: 2, based_on: 1 }), 1);
    assert.equal(await invoke(f, 'draft', 1, { ...f.draft, id: 'other-programme' }), 1);
    assert.equal(readFileSync(f.paths.programme, 'utf8'), before);
    assert.equal(await invoke(f, 'draft', 1, f.draft), 0);
    assert.equal(await invoke(f, 'approve', 1, { by: 'Martin', at: '2026-10-28T12:00:00Z' }), 1);
    assert.match(f.err.join(''), /stale state revision/);
    assert.equal(f.json(f.paths.programme).approved.length, 0);
  } finally { f.cleanup(); }
});

test('programme write failure is whole-or-not-at-all and checks occur inside both locks', async () => {
  const f = stateFixture();
  try {
    const before = readFileSync(f.paths.programme, 'utf8'); let held = 0;
    const planLock = (dir, fn) => withPlanLock(dir, () => { held++; try { return fn(); } finally { held--; } });
    const lock = (root, fn) => realLock(root, () => { assert.equal(held, 1); assert.ok(existsSync(lockPath(root))); return fn(); }, { strict: true });
    assert.equal(await invoke(f, 'draft', 1, f.draft, { planLock, lock, write: () => { throw new Error('disk full before atomic replacement'); } }), 1);
    assert.equal(readFileSync(f.paths.programme, 'utf8'), before);
    const staleInsideLock = (root, fn) => realLock(root, () => {
      const state = f.json(f.paths.programme); state.revision++;
      writeFileSync(f.paths.programme, JSON.stringify(state)); return fn();
    }, { strict: true });
    assert.equal(await invoke(f, 'draft', 1, f.draft, { lock: staleInsideLock }), 1);
    assert.equal(f.json(f.paths.programme).draft, null);
    assert.equal(await invoke(f, 'draft', 2, f.draft, { planLock, lock }), 0);
  } finally { f.cleanup(); }
});

test('concurrent processes with the same expected revision cannot overwrite one another', async () => {
  const f = stateFixture();
  try {
    const module = new URL('../../../src/mc/autonomous-state.js', import.meta.url).href;
    const code = `import { mutateProgramme } from ${JSON.stringify(module)};
      try { mutateProgramme(process.argv[1], 'test-programme', 'draft', JSON.parse(process.argv[2]), { actor: ${JSON.stringify(foreground)}, revision: 1 }); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const writer = draft => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.root, JSON.stringify(draft)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = ''; child.stderr.on('data', data => { err += data; }); child.on('error', reject); child.on('close', status => resolve({ status, err }));
    });
    const results = await Promise.all([writer(f.draft), writer({ ...f.draft, goal: ['Other writer.'] })]);
    assert.deepEqual(results.map(result => result.status).sort(), [0, 1]);
    assert.match(results.find(result => result.status === 1).err, /stale state revision/);
    assert.equal(f.json(f.paths.programme).revision, 2);
  } finally { f.cleanup(); }
});

test('programme input grammar, malformed state and held locks fail closed', async () => {
  const f = stateFixture();
  try {
    for (const argv of [['draft', f.programme], ['show', f.programme, '--input-file', f.input], ['start', f.programme], ['show', '../escape'], ['draft', f.programme, '--expected-revision', '-1', '--input-file', f.input]]) {
      assert.notEqual(await run(argv, f.deps), 0);
    }
    assert.throws(() => reserveProgrammeRun(f.root, f.programme, planner, 1), /already has an active run/);
    const path = lockPath(f.root);
    writeFileSync(path, String(process.pid));
    assert.equal(await invoke(f, 'draft', 1, f.draft, { lock: (root, fn) => realLock(root, fn, { strict: true, waitMs: -1 }) }), 1);
    assert.equal(readFileSync(path, 'utf8'), String(process.pid));
    rmSync(path);
    writeFileSync(f.paths.programme, '{');
    assert.equal(await run(['show', f.programme], f.deps), 1);
    assert.throws(() => autonomousPaths(f.root, '../escape'), /stable/);
  } finally { f.cleanup(); }
});

test('active foreground ownership is checked after acquiring the write lock, not before', async () => {
  const f = stateFixture();
  try {
    const lock = (_root, fn) => {
      const state = f.json(f.paths.programme); state.active_run = { ...foreground, run_id: 'replacement-run' };
      writeFileSync(f.paths.programme, JSON.stringify(state)); return fn();
    };
    assert.equal(await invoke(f, 'draft', 1, f.draft, { lock }), 1);
    assert.match(f.err.join(''), /active run\/role ownership required/);
    assert.equal(f.json(f.paths.programme).draft, null);
  } finally { f.cleanup(); }
});

test('a retired programme criterion identity cannot be recycled by a later draft', async () => {
  const f = stateFixture();
  try {
    assert.equal(await invoke(f, 'draft', 1, f.draft), 0);
    const approval = { by: 'Martin', at: '2026-10-28T12:00:00Z' };
    assert.equal(await invoke(f, 'approve', 2, approval), 0);
    const second = { ...f.draft, revision: 2, based_on: 1, success_criteria: [{ ...f.draft.success_criteria[0], id: 'new-contracts' }] };
    assert.equal(await invoke(f, 'draft', 3, second), 0);
    assert.equal(await invoke(f, 'approve', 4, approval), 0);
    const before = f.json(f.paths.programme);
    assert.equal(await invoke(f, 'draft', 5, { ...f.draft, revision: 3, based_on: 2 }), 1);
    assert.match(f.err.join(''), /retired criterion IDs cannot be reused/);
    assert.deepEqual(f.json(f.paths.programme), before);
  } finally { f.cleanup(); }
});

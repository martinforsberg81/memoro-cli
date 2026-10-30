import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import test from 'node:test';
import { run } from '../../../src/mc/commands/programme.js';
import { autonomousPaths, readProgrammeState, reserveProgrammeRun, releaseProgrammeRun } from '../../../src/mc/autonomous-state.js';
import { realLock, lockPath } from '../../../src/mc/register.js';
import { withPlanLock } from '../../../src/mc/plan-write.js';
import { stateFixture, foreground, planner, builder, reviewer } from '../autonomous-state-fixture.js';

const invoke = (f, operation, revision, input, deps = {}) => run([operation, f.programme,
  '--expected-revision', String(revision), '--input-file', f.file(input)], { ...f.deps, ...deps });

function fixture(t) {
  const f = stateFixture(); t.after(f.cleanup);
  releaseProgrammeRun(f.root, f.programme, foreground, 1);
  f.deps.actor = undefined;
  f.revision = () => f.json(f.paths.programme).revision;
  return f;
}

test('programme metadata changes append history without an approval ceremony', async t => {
  const f = fixture(t);
  assert.equal(await invoke(f, 'metadata', 2, f.draft), 0, f.err.join(''));
  const second = { ...f.draft, brief: 'docs/project/new-context/' };
  assert.equal(await invoke(f, 'metadata', 3, second), 0);
  const state = readProgrammeState(f.root, f.programme);
  assert.deepEqual(state.metadata, second);
  assert.deepEqual(state.metadata_history.map(item => item.metadata), [f.draft, second]);
  assert.equal(state.active_run, null); assert.equal(state.execution_enabled, false);
  assert.equal('approved' in state, false); assert.equal('draft' in state, false);
  assert.equal(await run(['show', f.programme], f.deps), 0);
});

test('metadata denies stale writers, foreign ownership and non-planning roles without writing', async t => {
  const f = fixture(t); const before = readFileSync(f.paths.programme, 'utf8');
  for (const actor of [planner, builder, reviewer, foreground]) {
    assert.equal(await invoke(f, 'metadata', 2, f.draft, { actor }), 1);
    assert.equal(readFileSync(f.paths.programme, 'utf8'), before);
  }
  for (const input of [{ ...f.draft, id: 'other' }, { ...f.draft, revision: 2 }]) {
    assert.equal(await invoke(f, 'metadata', 2, input), 1);
  }
  assert.equal(await invoke(f, 'metadata', 1, f.draft), 1);
  assert.equal(readFileSync(f.paths.programme, 'utf8'), before);
  assert.equal(await invoke(f, 'metadata', 2, f.draft), 0);
});

test('metadata write failure is whole-or-not-at-all with CAS inside both locks', async t => {
  const f = fixture(t); const before = readFileSync(f.paths.programme, 'utf8'); let held = 0;
  const planLock = (dir, fn) => withPlanLock(dir, () => { held++; try { return fn(); } finally { held--; } });
  const lock = (root, fn) => realLock(root, () => { assert.equal(held, 1); assert.ok(existsSync(lockPath(root))); return fn(); }, { strict: true });
  assert.equal(await invoke(f, 'metadata', 2, f.draft, { planLock, lock, write: () => { throw new Error('disk full before atomic replacement'); } }), 1);
  assert.equal(readFileSync(f.paths.programme, 'utf8'), before);
  const staleInsideLock = (root, fn) => realLock(root, () => {
    const state = f.json(f.paths.programme); state.revision++;
    writeFileSync(f.paths.programme, JSON.stringify(state)); return fn();
  }, { strict: true });
  assert.equal(await invoke(f, 'metadata', 2, f.draft, { lock: staleInsideLock }), 1);
  assert.deepEqual(f.json(f.paths.programme).metadata, f.draft);
  assert.equal(await invoke(f, 'metadata', 3, f.draft, { planLock, lock }), 0);
});

test('concurrent processes with the same expected revision cannot overwrite one another', async t => {
  const f = fixture(t);
  const module = new URL('../../../src/mc/autonomous-state.js', import.meta.url).href;
  const code = `import { mutateProgramme } from ${JSON.stringify(module)};
    try { mutateProgramme(process.argv[1], 'test-programme', 'metadata', JSON.parse(process.argv[2]), { env: {}, revision: 2 }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const writer = metadata => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.root, JSON.stringify(metadata)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', data => { err += data; }); child.on('error', reject); child.on('close', status => resolve({ status, err }));
  });
  const results = await Promise.all([writer(f.draft), writer({ ...f.draft, brief: 'docs/project/other/' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [0, 1]);
  assert.match(results.find(result => result.status === 1).err, /stale state revision/);
  assert.equal(f.revision(), 3);
});

test('programme input grammar, malformed state and held locks fail closed', async t => {
  const f = fixture(t);
  for (const argv of [['metadata', f.programme], ['show', f.programme, '--input-file', f.input], ['start', f.programme], ['show', '../escape'], ['metadata', f.programme, '--expected-revision', '-1', '--input-file', f.input]]) {
    assert.notEqual(await run(argv, f.deps), 0);
  }
  const path = lockPath(f.root); writeFileSync(path, String(process.pid));
  assert.equal(await invoke(f, 'metadata', 2, f.draft, { lock: (root, fn) => realLock(root, fn, { strict: true, waitMs: -1 }) }), 1);
  assert.equal(readFileSync(path, 'utf8'), String(process.pid)); rmSync(path);
  writeFileSync(f.paths.programme, '{');
  assert.equal(await run(['show', f.programme], f.deps), 1);
  assert.throws(() => autonomousPaths(f.root, '../escape'), /stable/);
});

test('foreground ownership refusal is checked inside the write lock', async t => {
  const f = fixture(t);
  const lock = (_root, fn) => {
    const state = f.json(f.paths.programme); state.active_run = { ...foreground, run_id: 'replacement-run' };
    state.runs.push(state.active_run); writeFileSync(f.paths.programme, JSON.stringify(state)); return fn();
  };
  assert.equal(await invoke(f, 'metadata', 2, f.draft, { lock }), 1);
  assert.match(f.err.join(''), /already has an active run/);
  assert.equal(f.json(f.paths.programme).metadata_history, undefined);
});

test('obsolete planner envelope verbs are not public programme commands', async t => {
  const f = fixture(t); const before = readFileSync(f.paths.programme, 'utf8');
  for (const verb of ['draft', 'approve', 'decide', 'complete', 'cancel']) {
    assert.notEqual(await invoke(f, verb, 2, f.draft), 0);
    assert.match(f.err.join(''), /operation and target are required/u);
    assert.equal(readFileSync(f.paths.programme, 'utf8'), before);
  }
});

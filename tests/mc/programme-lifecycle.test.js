import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitWriter, backupStatus, beginBackup, installationId, programmeLifecycle, transitionBackup } from '../../src/mc/programme-lifecycle.js';
import { addPr, appendEntry, GOAL_FILE, LOG_FILE, setGoalState, updateGoal } from '../../src/mc/goals.js';
import { programsHome } from '../../src/mc/paths.js';
import { goalJson } from './_helpers/goal-file.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { MC_HOME: join(root, 'state'), MC_WORK_ROOT: root };
  mkdirSync(env.MC_HOME, { recursive: true });
  return { root, env };
}

test('programme lifecycle: one installation identity and a persistent all-member drain fence', (t) => {
  const { env } = fixture(t);
  const identity = installationId({ env });
  assert.equal(installationId({ env }), identity);
  const tx = beginBackup(['beta', 'alpha'], { env, id: '00000000-0000-4000-8000-000000000001' });
  assert.deepEqual(tx.selection, ['alpha', 'beta']);
  assert.equal(programmeLifecycle('alpha', { env }).state, 'draining');
  assert.equal(programmeLifecycle('beta', { env }).transaction_id, tx.id);
  assert.throws(() => admitWriter(['alpha'], { env }), /draining/u);
  assert.doesNotThrow(() => admitWriter(['unrelated'], { env }).release());
  assert.throws(() => beginBackup(['beta'], { env }), /already fenced/u);
});

test('programme lifecycle: an admitted writer drains, stale generations refuse, and held state survives reload', (t) => {
  const { env } = fixture(t);
  const writer = admitWriter(['alpha'], { env, name: 'test writer' });
  const tx = beginBackup(['alpha'], { env, id: '00000000-0000-4000-8000-000000000002' });
  assert.throws(() => admitWriter(['alpha'], { env }), /draining/u);
  assert.throws(() => transitionBackup(tx.id, tx.generation, 'held', { env }), /1 admitted writer/u);
  assert.equal(backupStatus(tx.id, { env }).pending_writers[0].id, writer.id);
  writer.release();
  assert.throws(() => transitionBackup(tx.id, 'stale', 'held', { env }), /stale lifecycle generation/u);
  assert.equal(transitionBackup(tx.id, tx.generation, 'held', { env }).state, 'held');
});

test('programme lifecycle: release requires held state and malformed transaction records fail closed', (t) => {
  const { env, root } = fixture(t);
  const tx = beginBackup(['alpha'], { env, id: '00000000-0000-4000-8000-000000000003' });
  assert.throws(() => transitionBackup(tx.id, tx.generation, 'released', { env }), /cannot release/u);
  assert.throws(() => beginBackup(['../alpha'], { env }), /invalid programme/u);
  const state = join(root, 'runner', 'programme-transfers', 'bad.json');
  writeFileSync(state, '{');
  assert.throws(() => admitWriter(['unrelated'], { env }), /unreadable lifecycle record/u);
});

test('programme lifecycle: the shared goal-log writer refuses selected work and still writes an unrelated programme', (t) => {
  const { env } = fixture(t);
  const home = programsHome(env);
  const selectedDir = join(home, 'selected', 'goals', 'one');
  const unrelatedDir = join(home, 'unrelated', 'goals', 'one');
  mkdirSync(selectedDir, { recursive: true });
  mkdirSync(unrelatedDir, { recursive: true });
  writeFileSync(join(selectedDir, LOG_FILE), '# selected\n');
  writeFileSync(join(unrelatedDir, LOG_FILE), '# unrelated\n');
  beginBackup(['selected'], { env, id: '00000000-0000-4000-8000-000000000004' });

  assert.throws(() => appendEntry({ dir: selectedDir, env, entry: { at: '2026-11-12T00:00Z', tool: 'test', status: 'ready', done: 'must not write' } }), /draining/u);
  appendEntry({ dir: unrelatedDir, env, entry: { at: '2026-11-12T00:00Z', tool: 'test', status: 'ready', done: 'unrelated continues' } });
  assert.equal(readFileSync(join(selectedDir, LOG_FILE), 'utf8'), '# selected\n');
  assert.match(readFileSync(join(unrelatedDir, LOG_FILE), 'utf8'), /unrelated continues/u);
});

test('programme lifecycle: goal metadata, state and PR-ownership writers refuse selected programme files', (t) => {
  const { env } = fixture(t);
  const goalDir = join(programsHome(env), 'selected', 'goals', 'one');
  mkdirSync(goalDir, { recursive: true });
  writeFileSync(join(goalDir, GOAL_FILE), goalJson());
  writeFileSync(join(goalDir, LOG_FILE), '# goal log\n');
  const goalBefore = readFileSync(join(goalDir, GOAL_FILE), 'utf8');
  const logBefore = readFileSync(join(goalDir, LOG_FILE), 'utf8');
  beginBackup(['selected'], { env, id: '00000000-0000-4000-8000-000000000006' });

  assert.throws(() => updateGoal({ dir: goalDir, env, change: (goal) => ({ ...goal, title: 'not written' }) }), /draining/u);
  assert.throws(() => setGoalState({ dir: goalDir, env, status: 'Martin', entry: { at: '2026-11-12T00:00Z', tool: 'test', done: 'not written' } }), /draining/u);
  assert.throws(() => addPr({ dir: goalDir, env, repo: 'memoro-cli', pr: 1234 }), /draining/u);
  assert.equal(readFileSync(join(goalDir, GOAL_FILE), 'utf8'), goalBefore);
  assert.equal(readFileSync(join(goalDir, LOG_FILE), 'utf8'), logBefore);
});

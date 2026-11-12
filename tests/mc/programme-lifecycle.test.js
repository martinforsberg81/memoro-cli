import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitWriter, backupStatus, beginBackup, installationId, programmeLifecycle, transitionBackup } from '../../src/mc/programme-lifecycle.js';

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

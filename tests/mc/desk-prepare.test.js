import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as codex from '../../src/adapters/codex.js';
import { prepareDeskItem, drainDeskPreparation } from '../../src/mc/desk-prepare.js';
import { deskBudget, deskRunsPath, setDeskCeiling } from '../../src/mc/desk-budget.js';
import { deskItemId, itemDirectory, readDeskItem, writeDeskItem } from '../../src/mc/desk-items.js';
import { readRunRows } from '../../src/mc/landed.js';
import { readCanonRole } from '../../src/mc/roles.js';
import { tsvHeader, tsvRow } from '../../src/mc/run-plan.js';
import { run as martin } from '../../src/mc/commands/martin.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-desk-prepare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { MC_WORK_ROOT: root, MC_HOME: join(root, 'home'), MC_ROLE: 'build-session:goal', MC_GOAL: 'example/parent', MC_PROGRAMME: 'example', MC_TOOL: 'claude', MC_REPO: 'memoro-cli' };
  const now = () => new Date('2026-11-14T10:00:00Z');
  const item = { id: deskItemId('goal', 'example/item', now().toISOString()), state: 'new', source_at: now().toISOString(), kind: 'goal', reference: 'example/item', sort: null };
  writeDeskItem(item, { env });
  const deps = { route: () => ({ ok: true, candidate: { tool: 'codex', model: 'gpt-6.1-terra', effort: 'high' } }),
    launch: () => ({ ok: true, id: 'codex', shortName: 'codex', spec: { bin: '/fake/codex' }, adapter: codex }),
    billingRoute: () => ({ billing: 'plan' }),
  };
  return { env, item, now, deps, call: extra => prepareDeskItem({ id: item.id, env, now, deps: { ...deps, ...extra } }) };
}
const result = { status: 0, stdout: '', stderr: '' };

test('failed turns are counted without losing the item and two failures produce only a mechanical preparation', async t => {
  const f = fixture(t);
  const first = await f.call({ session: () => result });
  assert.equal(first.started, true);
  let stored = readDeskItem(f.item.id, { env: f.env });
  assert.equal(stored.state, 'new');
  assert.deepEqual(stored.prepare_failures, [{ at: f.now().toISOString(), reason: 'turn exited 0 without preparing the item (success)' }]);
  await f.call({ session: () => { throw new Error('fake session stopped'); } });
  stored = readDeskItem(f.item.id, { env: f.env });
  assert.equal(stored.state, 'prepared'); assert.equal(stored.sort, 'mechanical');
  assert.deepEqual(stored.prepare_failures.map(row => row.reason), ['turn exited 0 without preparing the item (success)', 'turn exited 1 without preparing the item (failed): fake session stopped']);
  assert.equal(readFileSync(join(itemDirectory(f.item, f.env), 'prepared.md'), 'utf8'), `Preparation failed twice.\n\n${stored.prepare_failures.map(row => `${row.at}: ${row.reason}`).join('\n\n')}\n`);
  assert.deepEqual(readRunRows(readFileSync(deskRunsPath(f.env), 'utf8')).map(row => [row.kind, row.name]), [['desk-prepare', f.item.id], ['desk-prepare', f.item.id]]);
  assert.equal((await f.call({ session: () => assert.fail('prepared item launched again') })).started, false);
});

test('a live preparation excludes concurrent manual and drain turns and releases its claim', async t => {
  const f = fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  const first = f.call({ session: async call => {
    entered(); await new Promise(resolve => { finish = resolve; });
    assert.equal(call.bin, '/fake/codex');
    assert.equal(call.cwd, itemDirectory(f.item, f.env));
    assert.equal(call.timeoutMs, 900000); assert.equal(call.group, true);
    assert.equal(call.env.MC_MODEL, 'gpt-6.1-terra'); assert.equal(call.env.MC_TOOL, 'codex');
    assert.equal(call.env.MC_GOAL, undefined); assert.equal(call.env.MC_PROGRAMME, undefined); assert.equal(call.env.MC_REPO, undefined);
    assert.equal(call.env.MC_ROLE, 'desk-prepare'); assert.equal(call.env.MC_HEADLESS, '1');
    assert.ok(call.args.includes('-m')); assert.ok(call.args.includes('gpt-6.1-terra'));
    assert.ok(call.args.includes('model_reasoning_effort=high'));
    const instruction = call.args.find(arg => arg.startsWith('instructions='));
    assert.ok(JSON.parse(instruction.slice('instructions='.length)).includes(readCanonRole('desk-prepare').overlay));
    writeFileSync(join(call.cwd, 'prepared.md'), 'Evidence');
    assert.equal(await martin(['item', f.item.id, 'prepared', '--sort', 'technical'], { env: call.env }), 0);
    return result;
  } });
  await started;
  const duplicate = await f.call({ session: () => assert.fail('concurrent turn') });
  assert.equal(duplicate.started, false); assert.match(duplicate.reason, /already running/u);
  assert.deepEqual((await drainDeskPreparation({ ...f, deps: { ...f.deps, session: () => assert.fail('drain raced') } })).done, []);
  finish(); const ended = await first; assert.equal(ended.ok, true, ended.reason);
  assert.equal(readDeskItem(f.item.id, { env: f.env }).prepare_failures, undefined);
});

test('quota and timeout endings record failed attempts, and quota pauses the drain', async t => {
  const f = fixture(t), pauses = [];
  const out = await drainDeskPreparation({ env: f.env, now: f.now, deps: { ...f.deps,
    session: () => ({ status: 1, stdout: '', stderr: 'rate limit exceeded' }), quotaPause: reset => pauses.push(reset),
  } });
  assert.deepEqual(out.done, [f.item.id]); assert.deepEqual(pauses, [null]);
  assert.equal(readDeskItem(f.item.id, { env: f.env }).state, 'new');
  await f.call({ session: () => ({ ...result, status: 142, timedOut: true }) });
  assert.match(readFileSync(join(itemDirectory(f.item, f.env), 'prepared.md'), 'utf8'), /preparation exceeded fifteen minutes/u);
});

test('absent and null ceilings never hold; set ceilings count only today desk kinds', async t => {
  const f = fixture(t);
  mkdirSync(join(f.env.MC_WORK_ROOT, 'runner', 'log'), { recursive: true });
  const rows = [['2026-11-14T01:00:00Z', 'desk-prepare', 2], ['2026-11-14T02:00:00Z', 'decision', 3], ['2026-11-13T23:00:00Z', 'decision', 100], ['2026-11-14T01:00:00Z', 'goal', 100]];
  writeFileSync(deskRunsPath(f.env), `${tsvHeader()}\n${rows.map(([ts, kind, cost]) => tsvRow({ ts, kind, cost })).join('\n')}\n`);
  let calls = 0;
  const session = () => { calls++; return result; };
  assert.equal(deskBudget({ env: f.env, now: f.now() }).spent, 5);
  await f.call({ session });
  setDeskCeiling(null, { env: f.env });
  await f.call({ session });
  assert.equal(calls, 2);
  writeDeskItem(f.item, { env: f.env });
  setDeskCeiling(5, { env: f.env });
  const held = await f.call({ session });
  assert.equal(held.held, true); assert.equal(calls, 2);
  assert.equal(readDeskItem(f.item.id, { env: f.env }).prepare_failures, undefined);
  setDeskCeiling(null, { env: f.env });
  await f.call({ session }); assert.equal(calls, 3);
});

test('the drain rereads the ceiling after recording a paid turn', async t => {
  const f = fixture(t), second = { ...f.item, id: 'f'.repeat(24), source_at: '2026-11-14T11:00:00Z' };
  writeDeskItem(second, { env: f.env });
  setDeskCeiling(0, { env: f.env });
  const initial = await f.call({ session: () => assert.fail('zero ceiling launched a turn') });
  assert.equal(initial.held, true);
  setDeskCeiling(1, { env: f.env });
  const calls = [], said = [];
  const out = await drainDeskPreparation({ env: f.env, now: f.now, deps: { ...f.deps,
    route: () => ({ ok: true, candidate: { tool: 'claude', model: 'sonnet', effort: 'high' } }),
    launch: () => ({ ok: true, id: 'claude-code', spec: { bin: '/fake/claude' } }),
    session: call => { calls.push(call.cwd); return { status: 0, stdout: JSON.stringify({ type:'result', total_cost_usd:1 }), stderr:'' }; },
    say: line => said.push(line),
  } });
  assert.deepEqual(out.done, [f.item.id]);
  assert.deepEqual(calls, [itemDirectory(f.item, f.env)]);
  assert.deepEqual(said.filter(line => line.includes('ceiling')), ['desk-prepare: desk ceiling holds turns: $1.0000 today (UTC), ceiling $1']);
  assert.equal(readDeskItem(second.id, { env: f.env }).prepare_failures, undefined);
});

/** Commissioned decision-lane protection: real runner/store, fake tool session and Git. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { itemDirectory } from '../../src/mc/desk-items.js';
import { setDeskCeiling, deskRunsPath } from '../../src/mc/desk-budget.js';
import { readRunRows } from '../../src/mc/landed.js';
import { run as martin } from '../../src/mc/commands/martin.js';
import { readCanonRole } from '../../src/mc/roles.js';
import { applyObservation, applyRefusal, normaliseCapacity } from '../../src/mc/model-capacity.js';
import { requestMainRepair } from '../../src/mc/main-repair.js';
import { goalJson } from './_helpers/goal-file.js';
import { fixture, NOW, result } from './_helpers/decision-fixture.js';
const sink = { write() {} };

test('three prepared items receive decision identity, role, default candidate, cwd and run rows', async t => {
  const f = fixture(t), a = f.add('alpha/first'), b = f.add('beta/second'), c = f.add('decision:record');
  f.deps.session = async call => {
    f.calls.push(call);
    const item = [a,b,c].find(x => call.prompt.includes(x.id));
    assert.ok(item);
    assert.equal(call.env.MC_ROLE, 'decision'); assert.equal(call.env.MC_HEADLESS, '1');
    assert.equal(call.env.MC_TOOL, 'claude'); assert.equal(call.env.MC_MODEL, 'fable');
    assert.ok(call.args.includes('fable')); assert.ok(call.args.includes('high'));
    const instructions = call.args[call.args.indexOf('--append-system-prompt') + 1];
    assert.ok(instructions.includes(readCanonRole('decision').overlay));
    assert.ok(call.checkInMs > 0); assert.ok(call.stallMs > 0);
    assert.match(call.checkIn(1,1), /Continue decision item/u);
    if (item.kind === 'goal') {
      assert.equal(call.env.MC_GOAL, item.reference);
      assert.equal(call.cwd, join(f.root, 'programs', item.reference.split('/')[0], 'goals', item.reference.split('/')[1], 'memoro-cli'));
    } else {
      assert.equal(call.env.MC_GOAL, undefined); assert.equal(call.cwd, itemDirectory(item, f.env));
    }
    await f.close(item); return result;
  };
  const r = f.runner();
  await Promise.all([r.pass({ lane: 1 }), r.pass({ lane: 2 }), r.pass({ lane: 3 })]);
  assert.deepEqual(f.calls.map(x => x.env.MC_GOAL || 'decision:record').sort(), ['alpha/first', 'beta/second', 'decision:record']);
  assert.deepEqual([a,b,c].map(x => f.state(x).outcome.by), ['decision','decision','decision']);
  const rows = readRunRows(readFileSync(deskRunsPath(f.env), 'utf8'));
  assert.deepEqual(rows.map(x => [x.name,x.kind]).sort(), [a,b,c].map(x => [x.id,'decision']).sort());
  assert.deepEqual(new Set(f.git.filter(x => x.args[0] === 'worktree' && x.args[1] === 'add').map(x => x.args.at(-1))), new Set(['goal/first','goal/second']));
});

test('two prepared items of one goal run sequentially, also across a manual runner', async t => {
  const f = fixture(t), a = f.add('alpha/first'), b = f.add('alpha/first', { source_at: '2026-11-14T11:00:00Z' });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.deps.session = async () => { entered(); await new Promise(resolve => { release = resolve; }); await f.close(a); return result; };
  const r = f.runner(), first = r.pass({ lane: 1 }); await started;
  assert.equal(r.nextWork(), null, 'same-goal exclusion holds while first session runs');
  assert.equal((await f.runner().decisionOne(b.id)).ran, 0, 'manual entrance shares goal claim');
  release(); await first;
  f.deps.session = async () => { await f.close(b); return result; };
  assert.equal((await r.pass({ lane: 2 })).name, b.id);
  assert.deepEqual([f.state(a).state,f.state(b).state], ['closed','closed']);
});

test('a fake session can brief an item for Martin instead of closing it', async t => {
  const f = fixture(t), item = f.add('alpha/first');
  f.deps.session = async () => {
    writeFileSync(join(itemDirectory(item,f.env), 'brief.md'), 'Swedish brief material');
    assert.equal(await martin(['item', item.id, 'brief', '--sort','product','--reversible','yes'], { env: { ...f.env, MC_ROLE:'decision' }, now: () => NOW, stdout:sink, stderr:sink }), 0);
    return result;
  };
  await f.runner().pass();
  assert.equal(f.state(item).state, 'for-martin'); assert.equal(f.state(item).due_at,'2026-11-16T12:00:00.000Z');
  assert.equal(JSON.parse(readFileSync(join(f.root,'programs/alpha/goals/first/GOAL.json'))).status,'Martin');
});

test('an unfinished item retries once then becomes a non-reversible mechanical brief with failure evidence', async t => {
  const f = fixture(t), item = f.add('alpha/first'), r = f.runner();
  await r.pass(); assert.equal(f.state(item).state,'prepared');
  assert.deepEqual(f.state(item).decision_failures.map(x=>x.at),['2026-11-14T12:00:00Z']);
  assert.match(f.state(item).decision_failures[0].reason,/decision session exited 0 without settling/u);
  f.deps.session = async () => { throw new Error('fake tool failed'); };
  await r.pass(); const ended = f.state(item);
  assert.equal(ended.state,'for-martin'); assert.equal(ended.sort,'mechanical'); assert.equal(ended.reversible,false); assert.equal(ended.due_at,null);
  assert.match(readFileSync(join(itemDirectory(item,f.env),'brief.md'),'utf8'), /fake tool failed/u);
  assert.equal(r.nextWork(),null);
  assert.deepEqual(readRunRows(readFileSync(deskRunsPath(f.env),'utf8')).map(x=>[x.name,x.kind]),[[item.id,'decision'],[item.id,'decision']]);
});

test('a reversible overdue brief is picked, told it is due, and closed by default', async t => {
  const f = fixture(t), item = f.add('decision:record', {state:'for-martin',sort:'judgement',reversible:true,due_at:'2026-11-14T11:59:59Z'});
  f.deps.session = async call => { assert.match(call.prompt,/This item is DUE/u); assert.match(call.prompt,/close --by default/u); await f.close(item,'default'); return result; };
  await f.runner().pass(); assert.equal(f.state(item).outcome.by,'default');
});
for (const [label, fields] of [
  ['future brief',{reversible:true,due_at:'2026-11-14T12:00:01Z'}],
  ['non-reversible due brief',{reversible:false,due_at:'2026-11-14T11:00:00Z'}],
  ['reserved due brief',{sort:'reserved',reversible:true,due_at:'2026-11-14T11:00:00Z'}],
]) test(`${label} is never picked`, async t => {
  const f = fixture(t); f.add('decision:record',{state:'for-martin',sort:'product',...fields});
  f.deps.session = () => assert.fail('ineligible default launched');
  assert.equal(f.runner().nextWork(),null); assert.equal((await f.runner().pass()).ran,0);
});

test('a reached daily desk ceiling starts no decision session, including after a paid turn', async t => {
  const f = fixture(t), a = f.add('decision:first'), b = f.add('decision:second',{source_at:'2026-11-14T11:00:00Z'}), r = f.runner();
  setDeskCeiling(0,{env:f.env}); assert.equal((await r.pass()).ran,0);
  assert.deepEqual(f.calls,[]); assert.equal(f.state(a).decision_failures,undefined);
  setDeskCeiling(1,{env:f.env}); await r.pass(); assert.deepEqual(f.calls.map(call=>call.prompt.match(/Decide desk item ([a-f0-9]{24})/u)?.[1]),[a.id]);
  assert.equal((await r.pass()).ran,0); assert.equal(f.state(b).decision_failures,undefined);
});

test('decision uses its first usable candidate, falling back within its own list', async t => {
  const f = fixture(t), item = f.add('decision:record');
  let capacity = applyObservation(normaliseCapacity(null), 'codex', { windows:{primary:{fraction_used:0.1,resets_at:'2026-11-14T15:00:00Z'}}, models:[{id:'gpt-6.1-sol',efforts:['high']}] },NOW);
  f.deps.capacity = {read:()=>capacity,write(){}};
  f.deps.session = async call => { assert.equal(call.env.MC_MODEL,'fable','catalog order wins over measured fallback capacity'); await f.close(item); return result; };
  assert.equal((await f.runner().pass()).ran,1);
  capacity = applyRefusal(capacity,'claude','2026-11-14T15:00:00Z');
  const fallback = f.add('decision:fallback');
  f.deps.session = async call => { assert.equal(call.env.MC_MODEL,'gpt-6.1-sol'); assert.equal(call.env.MC_TOOL,'codex'); assert.equal(call.prompt,undefined); assert.ok(call.args.at(-1).includes(fallback.id)); await f.close(fallback); return {status:0,stdout:'',stderr:''}; };
  assert.equal((await f.runner().pass()).ran,1);
});


test('decision takes a lane ahead of builds and behind merge-failure mend', t => {
  const f = fixture(t), item = f.add('decision:record');
  f.add('alpha/first',{state:'closed'});
  writeFileSync(join(f.root,'programs/alpha/goals/first/GOAL.json'),goalJson());
  const r = f.runner();
  assert.equal(r.nextWork().name,item.id);
  requestMainRepair({root:f.root,repo:'memoro-cli',base:'main-head',files:['tests/red.test.js'],now:()=>NOW});
  assert.equal(r.nextWork().kind,'mend');
});

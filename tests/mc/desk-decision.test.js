/** Commissioned decision-lane protection: real runner/store, fake tool session and Git. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { itemDirectory } from '../../src/mc/desk-items.js';
import { listLessons } from '../../src/mc/desk-lessons.js';
import { setDeskCeiling, deskRunsPath } from '../../src/mc/desk-budget.js';
import { readRunRows } from '../../src/mc/landed.js';
import { run as martin } from '../../src/mc/commands/martin.js';
import { readCanonRole } from '../../src/mc/roles.js';
import { applyObservation, applyRefusal, normaliseCapacity } from '../../src/mc/model-capacity.js';
import { requestMainRepair } from '../../src/mc/main-repair.js';
import { goalJson } from './_helpers/goal-file.js';
import { deskItemId, writeDeskItem } from '../../src/mc/desk-items.js';
import { mkdirSync } from 'node:fs';
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

const FORM = '## Vad den säger\nThe text says A.\n\n## Vad som föreslås\nSay B.\n\n## Vad som hittades\nC was found.\n';

test('a fake session can brief an item for Martin as a proposed change to a text, with no due time, instead of closing it', async t => {
  const f = fixture(t), item = f.add('alpha/first');
  f.deps.session = async () => {
    writeFileSync(join(itemDirectory(item,f.env), 'brief.md'), FORM);
    assert.equal(await martin(['item', item.id, 'brief', '--sort','text','--text','canon/roles/martin.md#Authority','--reversible','yes'], { env: { ...f.env, MC_ROLE:'decision' }, now: () => NOW, stdout:sink, stderr:sink }), 0);
    return result;
  };
  await f.runner().pass();
  assert.equal(f.state(item).state, 'for-martin'); assert.equal(f.state(item).sort,'text'); assert.equal(f.state(item).due_at,null);
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

test('an unfinished pass whose failure cannot take the item lock still logs the paid turn and leaves the item unchanged', async t => {
  const f = fixture(t), item = f.add('alpha/first'); const path = join(itemDirectory(item, f.env), 'item.json'); const before = readFileSync(path, 'utf8');
  const real = f.deps.lock;
  f.deps.lock = (root, fn, options) => { if (options?.name === 'desk-item') throw new Error('the runner lock is held by pid 4242 — try again'); return real(root, fn, options); };
  await f.runner().pass();
  assert.equal(readFileSync(path, 'utf8'), before, 'no failure was counted');
  assert.deepEqual(readRunRows(readFileSync(deskRunsPath(f.env), 'utf8')).map(x => [x.name, x.kind]), [[item.id, 'decision']], 'the paid turn has its run row');
});

test('no clock: a brief for Martin is never picked however long it has waited or whatever its old due time says, and nothing carries it out', async t => {
  for (const [label, fields] of [
    ['an old reversible product brief with a past due time', { sort: 'product', reversible: true, due_at: '2026-11-14T11:59:59Z' }],
    ['an old judgement brief with a past due time', { sort: 'judgement', reversible: true, due_at: '2026-11-10T11:00:00Z' }],
    ['a text brief', { sort: 'text', reversible: false, due_at: null }],
    ['a reserved brief', { sort: 'reserved', reversible: true, due_at: '2026-11-14T11:00:00Z' }],
    ['a stuck item', { sort: 'mechanical', reversible: false, due_at: null }],
  ]) {
    const f = fixture(t); f.add('decision:record', { state: 'for-martin', ...fields });
    f.deps.session = () => assert.fail(`${label} was launched`);
    assert.equal(f.runner().nextWork(), null, label); assert.equal((await f.runner().pass()).ran, 0, label);
  }
});

test('no clock: the decision prompt of a prepared item has no DUE text and no default to carry out, and the oldest source is taken first', async t => {
  const f = fixture(t), late = f.add('decision:late', { source_at: '2026-11-14T11:30:00Z' }), early = f.add('decision:early', { source_at: '2026-11-14T09:00:00Z' });
  f.add('decision:overdue', { state: 'for-martin', sort: 'product', reversible: true, due_at: '2026-11-13T00:00:00Z', source_at: '2026-11-01T00:00:00Z' });
  const seen = [];
  f.deps.session = async call => { seen.push(call.prompt); const item = [late, early].find(x => call.prompt.includes(x.id)); await f.close(item); return result; };
  const r = f.runner();
  assert.equal(r.nextWork().name, early.id, 'ordered by source_at');
  await r.pass(); await r.pass();
  assert.deepEqual(seen.map(p => p.match(/Decide desk item ([a-f0-9]{24})/u)[1]), [early.id, late.id]);
  for (const prompt of seen) { assert.doesNotMatch(prompt, /\bDUE\b|--by default|two days|overdue/u); assert.match(prompt, /No clock carries out a brief/u); assert.match(prompt, /brief --sort text --text/u); assert.match(prompt, /Vad den säger.*Vad som föreslås.*Vad som hittades/su); }
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

/** A session the API ended, as claude's stream writes it (the shape of run.test.js `streamed`): the output `readSessionOutput` reads. */
const apiEnded = (text, extra = {}) => ({ status: 0, stderr: '', timedOut: false, stdout: `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-1' })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 44, session_id: 'sid-1', terminal_reason: 'api_error', result: text, usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 }, ...extra })}\n` });
const PROVIDER_ENDINGS = [
  ['quota', apiEnded("You've hit your 5-hour limit · resets 3pm (UTC)", { api_error_status: 429 }), '(quota)'],
  ['login', apiEnded('Not logged in · Please run /login', { api_error_status: null }), '(interrupted)'],
  ['offline', apiEnded("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", { api_error: 'connection_failed', api_error_status: null, num_turns: 1 }), '(offline)'],
];
const ends = (f, output) => { f.deps.session = async call => { f.calls.push(call); return output; }; };
const logOf = f => join(f.root, 'programs/alpha/goals/first/LOG.md');
const runRows = f => readRunRows(readFileSync(deskRunsPath(f.env), 'utf8'));

for (const [reading, output, note] of PROVIDER_ENDINGS) test(`a decision ending on ${reading === 'offline' ? 'an' : 'a'} ${reading} reading writes nothing to a prepared goal item; the next unsettled ending counts once`, async t => {
  const f = fixture(t), item = f.add('alpha/first'), r = f.runner(), before = readFileSync(logOf(f), 'utf8');
  let clock = NOW; f.deps.now = () => clock;
  ends(f, output);
  await r.pass();
  clock = new Date(NOW.getTime() + 120_000); // past the offline hold, if the reading set one
  await r.pass();
  assert.equal(f.calls.length, 2, 'both sessions ran');
  assert.equal(f.state(item).state, 'prepared');
  assert.equal(f.state(item).decision_failures, undefined, 'no failure was counted');
  assert.equal(existsSync(join(itemDirectory(item, f.env), 'brief.md')), false, 'no brief.md');
  assert.deepEqual(listLessons({ env: f.env }), [], 'no lesson');
  assert.equal(readFileSync(logOf(f), 'utf8'), before, 'the goal LOG.md has no new entry');
  assert.deepEqual(runRows(f).map(x => [x.name, x.kind]), [[item.id, 'decision'], [item.id, 'decision']]);
  assert.ok(runRows(f).every(x => x.note.includes(note)), `the run rows say the ${reading} reading`);
  ends(f, result);
  clock = new Date(NOW.getTime() + 240_000);
  await r.pass();
  assert.equal(f.state(item).state, 'prepared');
  assert.deepEqual(f.state(item).decision_failures.map(x => x.state), ['prepared'], 'an ordinary ending adds exactly one failure');
  assert.equal(existsSync(join(itemDirectory(item, f.env), 'brief.md')), false);
  assert.deepEqual(listLessons({ env: f.env }), []);
});

test('a decision ending on an offline reading writes nothing to a prepared goal item that already has a brief, however often it ends so', async t => {
  const f = fixture(t), item = f.add('alpha/first');
  const brief = join(itemDirectory(item, f.env), 'brief.md'); writeFileSync(brief, 'Swedish text brief');
  const before = readFileSync(logOf(f), 'utf8');
  let clock = NOW; f.deps.now = () => clock;
  const r = f.runner();
  ends(f, PROVIDER_ENDINGS[2][1]);
  await r.pass();
  assert.equal(f.calls.length, 1);
  assert.deepEqual([f.state(item).state, f.state(item).sort], ['prepared', 'technical']);
  assert.equal(readFileSync(brief, 'utf8'), 'Swedish text brief');
  assert.equal(readFileSync(logOf(f), 'utf8'), before, 'the first ending writes no goal entry');
  clock = new Date(NOW.getTime() + 120_000);
  await r.pass();
  assert.equal(f.calls.length, 2);
  assert.deepEqual([f.state(item).state, f.state(item).sort], ['prepared', 'technical']);
  assert.equal(readFileSync(brief, 'utf8'), 'Swedish text brief');
  assert.equal(f.state(item).decision_failures, undefined);
  assert.equal(readFileSync(logOf(f), 'utf8'), before, 'the second ending writes no goal entry');
  assert.equal(runRows(f).length, 2);
});

test('an unsettled ending read as a server error counts once, in the state the item had', async t => {
  const f = fixture(t), item = f.add('alpha/first'), r = f.runner();
  ends(f, apiEnded('API Error: 500 Internal server error.', { api_error_status: 500 }));
  await r.pass();
  assert.equal(f.state(item).state, 'prepared');
  assert.deepEqual(f.state(item).decision_failures.map(x => [x.state, /\(interrupted\)/u.test(x.reason)]), [['prepared', true]]);
});

test('the two-ending limit counts the failures of the item\'s current state: a failure recorded in another state does not spend the attempt of a prepared item', async t => {
  const f = fixture(t), item = f.add('alpha/first', { decision_failures: [{ at: '2026-11-14T10:05:00Z', reason: 'an earlier session exited', state: 'for-martin' }] }), r = f.runner(), brief = join(itemDirectory(item, f.env), 'brief.md');
  ends(f, result);
  await r.pass(); // the first unsettled ending while prepared: one failure in prepared, not the limit
  const first = f.state(item);
  assert.deepEqual([first.state, first.sort], ['prepared', 'technical']);
  assert.deepEqual(first.decision_failures.map(x => x.state), ['for-martin', 'prepared']);
  assert.equal(existsSync(brief), false);
  assert.equal(r.nextWork()?.name, item.id, 'the item is eligible once more');
  await r.pass(); // the second in prepared
  const ended = f.state(item);
  assert.deepEqual([ended.state, ended.sort, ended.reversible, ended.due_at], ['for-martin', 'mechanical', false, null]);
  assert.equal(ended.decision_failures.length, 3);
  const text = readFileSync(brief, 'utf8');
  for (const x of ended.decision_failures) assert.ok(text.includes(x.reason), 'the brief lists every failure');
  assert.deepEqual(listLessons({ env: f.env }).map(x => x.kind), ['unsettled']);
  assert.equal(r.nextWork(), null, 'a stuck item is not taken again: it waits as stuck in the opening');
});

test('an entry written before the state was recorded counts as prepared, so the next unsettled ending of a prepared item is the second', async t => {
  const f = fixture(t), item = f.add('alpha/first', { decision_failures: [{ at: '2026-11-14T10:05:00Z', reason: 'an earlier session exited' }] });
  await f.runner().pass();
  const ended = f.state(item);
  assert.deepEqual([ended.state, ended.sort, ended.reversible, ended.due_at], ['for-martin', 'mechanical', false, null]);
  assert.deepEqual(ended.decision_failures.map(x => x.state ?? null), [null, 'prepared']);
  assert.match(readFileSync(join(itemDirectory(item, f.env), 'brief.md'), 'utf8'), /an earlier session exited/u);
  assert.equal(listLessons({ env: f.env }).length, 1);
});

test('the decision prompt of a programme item names the programme directory and the planning turn\'s state file', async t => {
  const f = fixture(t);
  const dir = join(f.root, 'programs', 'prog'); mkdirSync(join(dir, 'goals'), { recursive: true });
  writeFileSync(join(dir, 'PROGRAMME.json'), JSON.stringify({ schema: 'mc-programme', version: 1, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' }));
  writeFileSync(join(dir, 'README.md'), '# prog\n');
  const at = '2026-11-14T10:00:00Z';
  const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('programme', 'programme:prog', at), kind: 'programme', reference: 'programme:prog', source_at: at, opened_at: at, state: 'prepared', sort: 'mechanical', reversible: null, due_at: null, outcome: null };
  writeDeskItem(item, { env: f.env });
  writeFileSync(join(itemDirectory(item, f.env), 'prepared.md'), 'Prepared evidence.');
  f.deps.session = async call => { f.seen = call.prompt; await f.close(item); return result; };
  await f.runner().pass();
  assert.match(f.seen, new RegExp(`Decide desk item ${item.id}\\.`, 'u'));
  assert.ok(f.seen.includes(`Programme: prog. Programme directory: ${dir}.`), 'the programme directory');
  assert.ok(f.seen.includes(join(f.root, 'runner', 'programme-turn', 'prog.json')), 'the turn state file');
  assert.match(f.seen, /close --by decision so the runner plans the programme again/u);
  assert.doesNotMatch(f.seen, /No goal identity is assigned/u);
  assert.equal(f.state(item).state, 'closed');
});

import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deskItemId, deskItemQuestion, itemDirectory, syncDeskItems, listDeskItems, readDeskItem, updateDeskItem } from '../../src/mc/desk-items.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { run as martin } from '../../src/mc/commands/martin.js';
import { goalJson } from './_helpers/goal-file.js';
import { NO_PROGRESS_STOP } from '../../src/mc/goals.js';

const roots=[]; after(()=>roots.forEach(x=>rmSync(x,{recursive:true,force:true})));
function fixture() { const root=mkdtempSync(join(tmpdir(),'mc-desk-items-')); roots.push(root); const env={MC_WORK_ROOT:join(root,'mc'),MC_HOME:join(root,'mc-home')}; const home=join(env.MC_WORK_ROOT,'programs'); mkdirSync(join(env.MC_WORK_ROOT,'runner','projects'),{recursive:true}); mkdirSync(join(home,'alpha','goals','one'),{recursive:true}); return {root,env,home,dir:join(home,'alpha','goals','one')}; }
const stamp='2026-11-14T10:00:00Z';

test('sync opens the current source once, closes resolved goal items, and is idempotent',()=>{
  const f=fixture();
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'}));
  writeFileSync(join(f.dir,'LOG.md'),`## ${stamp} · person · build · Martin\n\nComment: Martin is asked: Which way?\nOption a: A\nOption b: B\nRecommended: a\n`);
  const dep={env:f.env,home:f.home,now:()=>new Date(stamp),read:fixtureRead};
  const first=syncDeskItems(dep); assert.equal(first.length,1); assert.equal(first[0].kind,'goal'); assert.equal(first[0].reference,'alpha/one'); assert.equal(first[0].source_at,stamp); assert.equal(first[0].state,'new');
  const before=readFileSync(join(f.env.MC_WORK_ROOT,'martin','items',first[0].id,'item.json'),'utf8');
  syncDeskItems(dep); assert.equal(readFileSync(join(f.env.MC_WORK_ROOT,'martin','items',first[0].id,'item.json'),'utf8'),before);
  const goal=JSON.parse(readFileSync(join(f.dir,'GOAL.json'),'utf8')); goal.status='ready'; writeFileSync(join(f.dir,'GOAL.json'),JSON.stringify(goal));
  const closed=syncDeskItems(dep).find(x=>x.id===first[0].id); assert.equal(closed.state,'closed'); assert.equal(closed.outcome.by,'source');
});

const DEFECT_LINE = 'goal defect: criterion 2 — its check names a test that is not on main';
const LEGACY_LINE = 'legacy build · blocked reconciled to Martin; existing obstacle and evidence are retained above — no pre-merge mend is started';
const defectEntry = (at, comment = `${DEFECT_LINE}\nEvidence: tests/x.test.js is missing`) => `## ${at} · claude opus · build · Martin\n\nComment: ${comment}\n`;

test('a goal defect opens one desk item, labelled by its first line, and a second sync opens no other',()=>{
  const f=fixture();
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'}));
  writeFileSync(join(f.dir,'LOG.md'),`## 2026-11-14T09:00:00Z · claude opus · build · ready\n\nDone: arbete\n\n${defectEntry(stamp)}`);
  const dep={env:f.env,home:f.home,now:()=>new Date(stamp),read:fixtureRead};
  const items=syncDeskItems(dep);
  assert.equal(items.length,1); assert.equal(items[0].kind,'goal'); assert.equal(items[0].source_at,stamp); assert.equal(items[0].state,'new');
  assert.equal(syncDeskItems(dep).length,1,'a second sync adds nothing');
  assert.equal(deskItemQuestion(items[0],{env:f.env,home:f.home,read:fixtureRead}),DEFECT_LINE);
});

test('the label of an item is the Martin entry of its minute, even when another entry shares the minute',()=>{
  const f=fixture();
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'}));
  // The session said its piece and then reported the defect, both in one minute (stamps have minute resolution).
  writeFileSync(join(f.dir,'LOG.md'),`## ${stamp} · claude opus · build · ready\n\nDone: arbete\nNext: the tests\n\n${defectEntry(stamp)}`);
  const [item]=syncDeskItems({env:f.env,home:f.home,now:()=>new Date(stamp),read:fixtureRead});
  assert.equal(item.source_at,stamp);
  assert.equal(deskItemQuestion(item,{env:f.env,home:f.home,read:fixtureRead}),DEFECT_LINE,'not the ready entry that shares the minute');
  // A runner entry after it, in the same minute, is not the label either.
  writeFileSync(join(f.dir,'LOG.md'),`${readFileSync(join(f.dir,'LOG.md'),'utf8')}\n## ${stamp} · runner · build · Martin\n\nComment: a later line\n`);
  assert.equal(deskItemQuestion(item,{env:f.env,home:f.home,read:fixtureRead}),DEFECT_LINE);
});

test('a later entry that only carries status Martin (a decision takeover) neither closes the defect item nor opens one',()=>{
  const f=fixture();
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'}));
  writeFileSync(join(f.dir,'LOG.md'),defectEntry(stamp));
  const dep={env:f.env,home:f.home,now:()=>new Date('2026-11-14T10:30:00Z'),read:fixtureRead};
  const [defect]=syncDeskItems(dep);
  writeFileSync(join(f.dir,'LOG.md'),`${readFileSync(join(f.dir,'LOG.md'),'utf8')}\n## 2026-11-14T10:20:00Z · claude opus · build · Martin\n\nComment: jev was asked: not a question for Martin\n\n## 2026-11-14T10:25:00Z · claude opus · build · Martin\n\nComment: decision takeover: the amendment changes what users are promised, a brief for Martin\n`);
  const items=syncDeskItems(dep);
  assert.equal(items.length,1,'no second item opens for the takeover note');
  assert.equal(items[0].id,defect.id); assert.equal(items[0].state,'new'); assert.equal(items[0].outcome,null); assert.equal(items[0].source_at,stamp);
  assert.equal(deskItemQuestion(items[0],{env:f.env,home:f.home,read:fixtureRead}),DEFECT_LINE);
});

test('a goal stopped by the runner, briefed for Martin, keeps its item when a later note by decision is written on it',async ()=>{
  const f=fixture();
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'}));
  writeFileSync(join(f.dir,'LOG.md'),`## ${stamp} · runner · build · Martin\n\nComment: ${NO_PROGRESS_STOP}\n`);
  const dep={env:f.env,home:f.home,now:()=>new Date('2026-11-14T10:10:00Z'),read:fixtureRead};
  const [stop]=syncDeskItems(dep);
  assert.equal(stop.state,'new'); assert.equal(stop.source_at,stamp);
  const dir=join(f.env.MC_WORK_ROOT,'martin','items',stop.id);
  writeFileSync(join(dir,'prepared.md'),'The goal stopped with no progress.\n'); writeFileSync(join(dir,'brief.md'),'The goal stopped with no progress; Martin decides whether it goes on.\n');
  const asDecision={env:{...f.env,MC_ROLE:'decision'},stdout:{write:()=>{}},stderr:{write:()=>{}}};
  assert.equal(await martin(['item',stop.id,'prepared','--sort','product'],asDecision),0);
  assert.equal(await martin(['item',stop.id,'brief','--sort','product','--reversible','no'],asDecision),0);
  const [briefed]=syncDeskItems(dep);
  assert.equal(briefed.state,'for-martin');
  writeFileSync(join(f.dir,'LOG.md'),`${readFileSync(join(f.dir,'LOG.md'),'utf8')}\n## 2026-11-14T10:25:00Z · claude opus · build · Martin · by decision\n\nComment: decision account: the item is briefed and the stop still stands; its question is unchanged.\n`);
  const items=syncDeskItems({...dep,now:()=>new Date('2026-11-14T10:30:00Z')});
  assert.equal(items.length,1,'no item opens beside the briefed one');
  assert.equal(items[0].id,stop.id); assert.equal(items[0].state,'for-martin'); assert.equal(items[0].source_at,stamp); assert.equal(items[0].outcome,null);
  assert.equal(deskItemQuestion(items[0],{env:f.env,home:f.home,read:fixtureRead}),NO_PROGRESS_STOP);
});

test('a later structured question still closes the older item as superseded and opens its own',()=>{
  const f=fixture();
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'}));
  writeFileSync(join(f.dir,'LOG.md'),`## ${stamp} · person · build · Martin\n\nComment: Martin is asked: Which way?\nOption a: A\nOption b: B\nRecommended: a\n`);
  const dep={env:f.env,home:f.home,now:()=>new Date('2026-11-14T10:30:00Z'),read:fixtureRead};
  const [first]=syncDeskItems(dep);
  writeFileSync(join(f.dir,'LOG.md'),`${readFileSync(join(f.dir,'LOG.md'),'utf8')}\n## 2026-11-14T10:25:00Z · person · build · Martin\n\nComment: Martin is asked: Which way now?\nOption a: A\nOption b: B\nRecommended: b\n`);
  const items=syncDeskItems(dep);
  const old=items.find((item)=>item.id===first.id);
  assert.equal(old.state,'closed'); assert.equal(old.outcome.by,'source'); assert.equal(old.outcome.summary,'A later question now waits at 2026-11-14T10:25:00Z.');
  const fresh=items.filter((item)=>item.state!=='closed');
  assert.equal(fresh.length,1,'one item stays open, for the later question'); assert.equal(fresh[0].kind,'goal'); assert.equal(fresh[0].reference,'alpha/one'); assert.equal(fresh[0].source_at,'2026-11-14T10:25:00Z'); assert.equal(fresh[0].state,'new');
  assert.equal(deskItemQuestion(fresh[0],{env:f.env,home:f.home,read:fixtureRead}),'Which way now?');
  assert.equal(deskItemQuestion(old,{env:f.env,home:f.home,read:fixtureRead}),'Which way?','the closed item keeps its own label');
});

test('a goal set Martin by a legacy reconcile entry has the later goal defect as its question: the older item closes and the defect opens its own',()=>{
  const f=fixture();
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'}));
  writeFileSync(join(f.dir,'LOG.md'),`## ${stamp} · runner · build · Martin\n\nComment: ${LEGACY_LINE}\n`);
  const dep={env:f.env,home:f.home,now:()=>new Date('2026-11-14T10:30:00Z'),read:fixtureRead};
  const [legacy]=syncDeskItems(dep);
  assert.equal(legacy.source_at,stamp); assert.equal(deskItemQuestion(legacy,{env:f.env,home:f.home,read:fixtureRead}),LEGACY_LINE);
  writeFileSync(join(f.dir,'LOG.md'),`${readFileSync(join(f.dir,'LOG.md'),'utf8')}\n${defectEntry('2026-11-14T10:25:00Z')}`);
  const items=syncDeskItems(dep);
  const old=items.find((item)=>item.id===legacy.id);
  assert.equal(old.state,'closed'); assert.equal(old.outcome.by,'source'); assert.equal(old.outcome.summary,'A later question now waits at 2026-11-14T10:25:00Z.');
  const fresh=items.filter((item)=>item.state!=='closed');
  assert.equal(fresh.length,1); assert.equal(fresh[0].kind,'goal'); assert.equal(fresh[0].source_at,'2026-11-14T10:25:00Z'); assert.equal(fresh[0].state,'new');
  assert.equal(deskItemQuestion(fresh[0],{env:f.env,home:f.home,read:fixtureRead}),DEFECT_LINE);
});

test('an open item keyed on a later note than the entry that set the goal Martin stays the goal\'s only item',()=>{
  const f=fixture();
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'}));
  writeFileSync(join(f.dir,'LOG.md'),`## ${stamp} · runner · build · Martin\n\nComment: ${LEGACY_LINE}\n\n## 2026-11-14T10:25:00Z · claude opus · build · Martin · by decision\n\nComment: decision account: the question is unchanged and nothing is decided here.\n`);
  // The item the day before this change opened, keyed on the later note.
  const keyed='2026-11-14T10:25:00Z', id=deskItemId('goal','alpha/one',keyed), dir=join(f.env.MC_WORK_ROOT,'martin','items',id);
  mkdirSync(dir,{recursive:true});
  writeJsonAtomic(join(dir,'item.json'),{schema:'mc-desk-item',version:1,id,kind:'goal',reference:'alpha/one',source_at:keyed,opened_at:keyed,state:'new',sort:null,reversible:null,due_at:null,outcome:null});
  const items=syncDeskItems({env:f.env,home:f.home,now:()=>new Date('2026-11-14T10:30:00Z'),read:fixtureRead});
  assert.equal(items.length,1,'no other item opens beside it');
  assert.equal(items[0].id,id); assert.equal(items[0].state,'new'); assert.equal(items[0].source_at,keyed); assert.equal(items[0].outcome,null);
  assert.equal(deskItemQuestion(items[0],{env:f.env,home:f.home,read:fixtureRead}),LEGACY_LINE);
});

test('decision rows open only when decided and flagged by a different chosen key or product >= .70',()=>{
  const f=fixture(); const ledger=join(f.env.MC_HOME,'jev','decisions.jsonl'); mkdirSync(join(f.env.MC_HOME,'jev'),{recursive:true});
  const row=(at, outcome, choice, product)=>({at, outcome, recommend:'a',question:'Question?',answers:{answer:{choice},product}});
  writeFileSync(ledger,[row('2026-11-14T10:01:00Z','decided','b',0.1),row('2026-11-14T10:02:00Z','decided','a',0.70),{at:'2026-11-14T10:02:30Z',outcome:'decided',recommend:'a',question:'No model reading',answers:null},row('2026-11-14T10:03:00Z','answered','b',0.9)].map(JSON.stringify).join('\n')+'\n');
  const items=syncDeskItems({env:f.env,home:f.home,now:()=>new Date(stamp),read:fixtureRead});
  assert.deepEqual(items.map(x=>x.reference).sort(),['decision:2026-11-14T10:01:00Z','decision:2026-11-14T10:02:00Z']);
  assert.equal(listDeskItems({env:f.env}).length,2);
});

test('stable item identity includes source time so a later question is a distinct item',()=>{
  assert.notEqual(deskItemId('goal','alpha/one',stamp),deskItemId('goal','alpha/one','2026-11-15T10:00:00Z'));
});

test('martin items syncs four sources once, closes resolved sources and only writes the item store',async()=>{
  const f=fixture(); const two=join(f.home,'alpha','goals','two'); mkdirSync(two,{recursive:true});
  const q1='2026-11-14T10:00:00Z', q2='2026-11-14T10:01:00Z';
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'})); writeFileSync(join(f.dir,'LOG.md'),`## ${q1} · person · build · Martin\n\nComment: Martin is asked: Policy?\nOption a: A\nOption b: B\nRecommended: a\n`);
  writeFileSync(join(two,'GOAL.json'),goalJson({status:'Martin',title:'Two'})); writeFileSync(join(two,'LOG.md'),`## ${q1} · runner · build · Martin\n\nComment: runner failure: no response\n`);
  const mends=join(f.env.MC_WORK_ROOT,'runner','main-mend'); mkdirSync(mends,{recursive:true});
  writeFileSync(join(mends,'memoro.json'),JSON.stringify({version:1,entries:[{id:'red1',file:'tests/red.js',state:'Martin',created:q1,reason:'Repeated red'}]}));
  const ledger=join(f.env.MC_HOME,'jev','decisions.jsonl'); mkdirSync(join(f.env.MC_HOME,'jev'),{recursive:true});
  const row=(at,outcome,choice,product)=>({at,outcome,recommend:'a',question:'Decision?',answers:{answer:{choice},product}});
  writeFileSync(ledger,[row('2026-11-14T09:59:00Z','decided','b',0.1),row(q2,'decided','b',0.1),row('2026-11-14T10:02:00Z','decided','a',0.1),row('2026-11-14T10:03:00Z','answered','b',0.9)].map(JSON.stringify).join('\n')+'\n');
  mkdirSync(join(f.env.MC_WORK_ROOT,'martin'),{recursive:true});
  writeFileSync(join(f.env.MC_WORK_ROOT,'martin','desk-note.md'),'Must not change');
  const before=sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items'));
  const sync=async()=>{
    const outside=sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items'));
    let output=''; let errors='';
    assert.equal(await martin(['items','--json'],{env:f.env,home:f.home,syncDeps:{now:()=>new Date(q1)},stdout:{write:s=>{output+=s;}},stderr:{write:s=>{errors+=s;}}}),0,errors);
    assert.deepEqual(sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')),outside);
    return JSON.parse(output);
  };
  const items=await sync(); assert.equal(items.length,4,JSON.stringify(items.map(x=>[x.kind,x.reference,x.source_at])));
  assert.deepEqual(items.map(x=>[x.kind,x.reference,x.source_at,x.state]).sort((a,b)=>a[1].localeCompare(b[1])),[
    ['goal','alpha/one',q1,'new'],['goal','alpha/two',q1,'new'],['decision',`decision:${q2}`,q2,'new'],['main-red','main-red:memoro/red1',q1,'new'],
  ].sort((a,b)=>a[1].localeCompare(b[1])));
  assert.deepEqual(sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')),before);
  const fileSet=sourceSnapshot(f.root);
  await sync(); assert.deepEqual(sourceSnapshot(f.root),fileSet,'second sync changes no file, including store metadata');
  assert.deepEqual(sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')),before);
  const red=JSON.parse(readFileSync(join(mends,'memoro.json'),'utf8')); red.entries[0].state='landed'; writeFileSync(join(mends,'memoro.json'),JSON.stringify(red));
  const afterRed=sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')); const redItem=(await sync()).find(x=>x.kind==='main-red'); assert.equal(redItem.state,'closed'); assert.equal(redItem.outcome.by,'source'); assert.deepEqual(sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')),afterRed);
  const goal=JSON.parse(readFileSync(join(f.dir,'GOAL.json'),'utf8')); goal.status='ready'; writeFileSync(join(f.dir,'GOAL.json'),JSON.stringify(goal));
  const afterReady=sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')); const closed=(await sync()).find(x=>x.reference==='alpha/one'); assert.equal(closed.state,'closed'); assert.equal(closed.outcome.by,'source'); assert.deepEqual(sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')),afterReady);
  writeFileSync(join(two,'LOG.md'),`## ${q1} · runner · build · Martin\n\nComment: runner failure: no response\n\n## 2026-11-15T10:00:00Z · person · build · Martin\n\nComment: Martin is asked: New policy?\nOption a: A\nOption b: B\nRecommended: a\n`);
  const beforeLater=sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')); const later=(await sync()).filter(x=>x.reference==='alpha/two');
  assert.deepEqual(later.map(x=>x.state).sort(),['closed','new']); assert.equal(later.find(x=>x.state==='closed').outcome.by,'source'); assert.deepEqual(sourceSnapshot(f.root,join(f.env.MC_WORK_ROOT,'martin','items')),beforeLater);
});

function sourceSnapshot(root, excluded) { const out=[]; function walk(p) { for (const n of readdirSync(p)) { const c=join(p,n); if (c===excluded) continue; const st=lstatSync(c); if (st.isDirectory()) { out.push([c,'directory']); walk(c); } else out.push([c,'file',st.size,st.mtimeMs,createHash('sha256').update(readFileSync(c)).digest('hex')]); } } walk(root); return out.sort((a,b)=>a[0].localeCompare(b[0])); }
function fixtureRead(path) { try { return readFileSync(path,'utf8'); } catch { return null; } }

for (const source of ['goal', 'main-red']) for (const fault of ['missing', 'malformed']) {
  test(`sync preserves a waiting ${source} item when its source is ${fault}, then recovers`, () => {
    const f = fixture();
    const path = source === 'goal' ? join(f.dir, 'GOAL.json') : join(f.env.MC_WORK_ROOT, 'runner', 'main-mend', 'memoro.json');
    mkdirSync(join(f.env.MC_WORK_ROOT, 'runner', 'main-mend'), { recursive: true });
    const original = source === 'goal' ? goalJson({ status: 'Martin' }) : JSON.stringify({ version: 1, entries: [{ id: 'red1', state: 'Martin', created: stamp, reason: 'Repeated red' }] });
    writeFileSync(path, original);
    writeFileSync(join(f.dir, 'LOG.md'), `## ${stamp} · person · build · Martin\n\nComment: Martin is asked: Keep waiting?\n`);
    const issues = [];
    const deps = { env: f.env, home: f.home, now: () => new Date(stamp), reportIssue: issue => issues.push(issue) };
    const [item] = syncDeskItems(deps);
    const bytes = readFileSync(join(f.env.MC_WORK_ROOT, 'martin', 'items', item.id, 'item.json'), 'utf8');
    if (fault === 'missing') rmSync(path); else writeFileSync(path, '{');
    syncDeskItems(deps);
    assert.equal(readFileSync(join(f.env.MC_WORK_ROOT, 'martin', 'items', item.id, 'item.json'), 'utf8'), bytes);
    assert.ok(issues.some(issue => issue.path === path), 'unreadable source is reported');
    writeFileSync(path, original);
    assert.equal(syncDeskItems(deps).find(x => x.id === item.id).state, 'new');
  });
}

// One writer at a time: the injected lock stands for a second writer, which does its write before the first one's hold begins.
const waiting = (f) => {
  writeFileSync(join(f.dir, 'GOAL.json'), goalJson({ status: 'Martin' }));
  writeFileSync(join(f.dir, 'LOG.md'), `## ${stamp} · person · build · Martin\n\nComment: Martin is asked: Keep waiting?\n`);
  const deps = { env: f.env, home: f.home, now: () => new Date(stamp), reportIssue: () => {} };
  const [item] = syncDeskItems(deps);
  return { deps, item, path: join(f.env.MC_WORK_ROOT, 'martin', 'items', item.id, 'item.json') };
};
const settled = (item, by = 'decision') => ({ ...item, state: 'closed', outcome: { by, at: '2026-11-14T10:30:00.000Z', summary: 'Settled while the sync waited.' } });

// The item verbs are synchronous up to their first await, so a verb started inside the injected lock has written when the lock's function returns.
const verb = (f, args, role = 'decision') => { martin(args, { env: { ...f.env, MC_ROLE: role }, home: f.home, stdout: { write() {} }, stderr: { write() {} } }); };

test('the sync runs in one strict hold of the runner lock and never overwrites a decision close made through the real verb before it', () => {
  const f = fixture(); const { deps, item } = waiting(f);
  writeFileSync(join(itemDirectory(item, f.env), 'prepared.md'), 'Evidence'); verb(f, ['item', item.id, 'prepared', '--sort', 'technical']);
  assert.equal(readDeskItem(item.id, { env: f.env }).state, 'prepared');
  writeFileSync(join(f.dir, 'GOAL.json'), goalJson({ status: 'ready' })); // the goal has left Martin: the sync would close the item by source
  const holds = [];
  const lock = (root, fn, options) => { holds.push({ root, options }); verb(f, ['item', item.id, 'close', '--by', 'decision', '--summary', 'Carried out.']); return fn(); };
  syncDeskItems({ ...deps, lock });
  assert.deepEqual(holds, [{ root: f.env.MC_WORK_ROOT, options: { strict: true, name: 'desk-items-sync' } }], 'one hold for the whole sync');
  const after = readDeskItem(item.id, { env: f.env });
  assert.deepEqual([after.state, after.outcome.by, after.outcome.summary], ['closed', 'decision', 'Carried out.'], 'the decision close made before the hold stands');
  assert.deepEqual([after.id, after.sort, after.outcome.replaced], [item.id, 'technical', undefined], 'the same item, its sort kept, no source closure written over it');
  assert.deepEqual(readdirSync(join(f.env.MC_WORK_ROOT, 'martin', 'items')).filter(n => !n.startsWith('.')), [item.id]);
});

test('the sync still closes by source when nobody settled the item first', () => {
  const f = fixture(); const { deps, item } = waiting(f);
  writeFileSync(join(f.dir, 'GOAL.json'), goalJson({ status: 'ready' }));
  syncDeskItems({ ...deps, lock: (root, fn) => fn() });
  assert.equal(readDeskItem(item.id, { env: f.env }).outcome.by, 'source');
});

test('a sync that cannot take the lock throws and writes nothing, not even the store', () => {
  const f = fixture(); const { deps, item, path } = waiting(f);
  writeFileSync(join(f.dir, 'GOAL.json'), goalJson({ status: 'ready' }));
  const before = sourceSnapshot(f.root); const issues = [];
  const lock = () => { throw new Error('the runner lock is held by pid 4242 — try again'); };
  assert.throws(() => syncDeskItems({ ...deps, lock, reportIssue: issue => issues.push(issue) }), /held by pid 4242/u);
  assert.deepEqual(sourceSnapshot(f.root), before); assert.deepEqual(issues, []);
  assert.equal(readDeskItem(item.id, { env: f.env }).state, 'new'); assert.ok(path);
});

test('updateDeskItem reads the record inside the hold, writes only a change, and stops when the lock cannot be taken', () => {
  const f = fixture(); const { item, path } = waiting(f);
  const order = []; const writes = [];
  const lock = (root, fn, options) => { order.push(['enter', options]); writeJsonAtomic(path, { ...item, sort: 'technical' }); try { return fn(); } finally { order.push(['exit']); } };
  const read = id => { order.push(['read']); return readDeskItem(id, { env: f.env }); };
  const write = (target, value) => { order.push(['write']); writes.push([target, value]); };
  const changed = updateDeskItem(item.id, current => ({ ...current, state: 'prepared' }), { env: f.env, lock, read, write });
  assert.deepEqual(order.map(x => x[0]), ['enter', 'read', 'write', 'exit']);
  assert.deepEqual(order[0][1], { strict: true, name: 'desk-item' });
  assert.equal(changed.written, true); assert.deepEqual([changed.item.state, changed.item.sort], ['prepared', 'technical'], 'the change saw the record the earlier writer left');
  assert.deepEqual(writes, [[path, changed.item]]);
  order.length = 0; writes.length = 0;
  const unchanged = updateDeskItem(item.id, () => null, { env: f.env, lock, read, write });
  assert.equal(unchanged.written, false); assert.deepEqual(writes, []);
  const refused = () => { throw new Error('the runner lock is held by pid 4242 — try again'); };
  assert.throws(() => updateDeskItem(item.id, current => ({ ...current, state: 'prepared' }), { env: f.env, lock: refused, read, write }), /held by pid 4242/u);
  assert.deepEqual(writes, []);
});

test('the sync never writes a new record over an item a second sync created and the verbs advanced', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'GOAL.json'), goalJson({ status: 'Martin' }));
  writeFileSync(join(f.dir, 'LOG.md'), `## ${stamp} · person · build · Martin\n\nComment: Martin is asked: Keep waiting?\n`);
  const deps = { env: f.env, home: f.home, now: () => new Date(stamp), reportIssue: () => {} };
  const lock = (root, fn) => {
    const [made] = syncDeskItems({ ...deps, lock: (r, body) => body() });
    writeFileSync(join(itemDirectory(made, f.env), 'prepared.md'), 'Evidence');
    verb(f, ['item', made.id, 'prepared', '--sort', 'technical']);
    return fn();
  };
  const items = syncDeskItems({ ...deps, lock });
  assert.equal(items.length, 1, 'one item');
  assert.deepEqual([items[0].state, items[0].sort], ['prepared', 'technical']);
  assert.deepEqual(readDeskItem(items[0].id, { env: f.env }), items[0]);
  assert.equal(readdirSync(join(f.env.MC_WORK_ROOT, 'martin', 'items')).filter(n => !n.startsWith('.')).length, 1);
});

test('a main-red repair that reaches Martin again after an answer is a new desk item; an unanswered one keeps its own', () => {
  const f = fixture();
  const dir = join(f.env.MC_WORK_ROOT, 'runner', 'main-mend'); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'memoro.json');
  const answeredAt = '2026-11-14T12:00:00.000Z', again = '2026-11-14T15:00:00.000Z';
  const red = { id: 'red1', file: 'tests/a.test.js', state: 'Martin', created: stamp, reason: 'Repeated red', failures: 2 };
  const put = (fields) => writeFileSync(path, JSON.stringify({ version: 1, entries: [{ ...red, ...fields }] }));
  const deps = { env: f.env, home: f.home, now: () => new Date(again), reportIssue: () => {} };
  const reference = 'main-red:memoro/red1';
  const items = () => syncDeskItems(deps).filter((item) => item.reference === reference);
  put({});
  const [first] = items();
  assert.equal(first.id, deskItemId('main-red', reference, stamp), 'an unanswered entry keeps the id made from its creation');
  assert.equal(first.source_at, stamp);
  put({ state: 'queued', failures: 0, answered: { verb: 'requeue', by: 'person', at: answeredAt, reason: 'retry' } });
  assert.deepEqual(items().map((item) => [item.state, item.outcome?.by]), [['closed', 'source']], 'a sync alone closes the answered item by source');
  put({ failures: 2, answered: { verb: 'requeue', by: 'person', at: answeredAt, reason: 'retry' } });
  const all = items();
  assert.equal(all.length, 2, 'the entry reaching Martin again opens a new item beside the closed one');
  const reopened = all.find((item) => item.id !== first.id);
  assert.equal(reopened.id, deskItemId('main-red', reference, answeredAt));
  assert.equal(reopened.source_at, answeredAt);
  assert.equal(reopened.state, 'new');
  assert.equal(all.find((item) => item.id === first.id).state, 'closed');
  assert.equal(items().length, 2, 'another sync opens nothing more');
});

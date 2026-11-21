import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { renameSync } from 'node:fs';
import { deskItemId, deskItemQuestion, itemDirectory, syncDeskItems, listDeskItems, readDeskItem, readGoalDeskItem, updateDeskItem } from '../../src/mc/desk-items.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { run as martin } from '../../src/mc/commands/martin.js';
import { goalJson } from './_helpers/goal-file.js';
import { NO_PROGRESS_STOP, parseLog } from '../../src/mc/goals.js';
import { writeDeskItem } from '../../src/mc/desk-items.js';
import { repairSnapshot } from '../../src/mc/repair-manifest.js';

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

test('review repair stops open for decision and a stale brief does not label the current stop', () => {
  const f = fixture();
  const stop = 'no progress: review repair limit reached after 2 automatic repairs. Failed: bugs. See REVIEW.md.';
  const earlier = '2026-11-14T09:10:00Z';
  const previousId = deskItemId('goal', 'alpha/one', earlier);
  writeDeskItem({ id: previousId, kind: 'goal', reference: 'alpha/one', source_at: earlier, state: 'for-martin' }, { env: f.env });
  const rawLog = `## ${stamp} · claude opus · review · Martin · by review\n\nComment: ${stop}\n`;
  writeFileSync(join(f.dir, 'GOAL.json'), goalJson({ stage: 'review', status: 'Martin' }));
  writeFileSync(join(f.dir, 'LOG.md'), rawLog);
  const goal = { programme: 'alpha', goal: 'one', stage: 'review', status: 'Martin', log: parseLog(rawLog) };
  assert.equal(readGoalDeskItem(goal, { env: f.env }), null, 'an older brief is not the current item');
  syncDeskItems({ env: f.env, home: f.home, now: () => new Date(stamp), read: fixtureRead });
  const item = readGoalDeskItem(goal, { env: f.env });
  assert.equal(item.state, 'new');
  assert.equal(deskItemQuestion(item, { env: f.env, home: f.home, read: fixtureRead }), stop);
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
  assert.equal(await martin(['item',stop.id,'brief','--sort','reserved','--reversible','no'],asDecision),0);
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

// A goal that has left goals/ for the archive, as `archiveGoal` leaves it: its directory under `.archive`, its log kept.
const LIVE_QUESTION = `## ${stamp} · person · build · Martin\n\nComment: Martin is asked: Keep waiting?\n`;
const DROP_ENTRIES = `\n## 2026-11-14T20:35:00Z · person · dropped · ready\n\nComment: Not wanted: the cutover is off\nThe second line of the reason\n\n## 2026-11-14T20:36:00Z · runner · dropped · ready\n\nComment: drop finalization pending — x\n`;
const archivedGoal = (stage) => goalJson({ stage, status: 'ready' });
const archiveDir = (f, name) => { const dir = join(f.home, 'alpha', 'goals', '.archive', name); mkdirSync(dir, { recursive: true }); return dir; };
// The first sync opens the live question of alpha/one.
function openQuestion(f) {
  writeFileSync(join(f.home, 'alpha', 'README.md'), '# alpha\n'); // the programme README the question's context reads
  writeFileSync(join(f.dir, 'GOAL.json'), goalJson({ status: 'Martin' }));
  writeFileSync(join(f.dir, 'LOG.md'), LIVE_QUESTION);
  const issues = [];
  const deps = { env: f.env, home: f.home, now: () => new Date(stamp), read: fixtureRead, reportIssue: issue => issues.push(issue) };
  const [item] = syncDeskItems(deps);
  return { item, deps, issues, path: join(f.dir, 'GOAL.json') };
}

test('an open goal item closes by source when its goal is archived as dropped, with the first line of the drop as its reason; a second sync changes nothing', () => {
  const f = fixture(); const { item, deps, issues } = openQuestion(f);
  mkdirSync(join(f.home, 'alpha', 'goals', '.archive'), { recursive: true });
  renameSync(f.dir, join(f.home, 'alpha', 'goals', '.archive', 'one'));
  const archive = join(f.home, 'alpha', 'goals', '.archive', 'one');
  writeFileSync(join(archive, 'GOAL.json'), archivedGoal('dropped')); writeFileSync(join(archive, 'LOG.md'), `${LIVE_QUESTION}${DROP_ENTRIES}`);
  const closed = syncDeskItems(deps).find(x => x.id === item.id);
  assert.equal(closed.state, 'closed'); assert.equal(closed.outcome.by, 'source');
  assert.equal(closed.outcome.summary, 'The goal is dropped and archived. Reason: Not wanted: the cutover is off');
  assert.deepEqual(issues, [], 'no issue is reported for the archived goal');
  const path = join(f.env.MC_WORK_ROOT, 'martin', 'items', item.id, 'item.json'); const before = readFileSync(path, 'utf8');
  syncDeskItems(deps); assert.equal(readFileSync(path, 'utf8'), before);
});

test('an open goal item closes by source when its goal is archived as done under the stamped name, and says so', () => {
  const f = fixture(); const { item, deps, issues } = openQuestion(f);
  const dir = archiveDir(f, 'one-20261114T2035'); writeFileSync(join(dir, 'GOAL.json'), archivedGoal('done')); writeFileSync(join(dir, 'LOG.md'), LIVE_QUESTION);
  rmSync(f.dir, { recursive: true });
  const closed = syncDeskItems(deps).find(x => x.id === item.id);
  assert.deepEqual([closed.state, closed.outcome.by, closed.outcome.summary], ['closed', 'source', 'The goal is done and archived.']);
  assert.deepEqual(issues, []);
});

test('a missing goal with nothing in the archive keeps its item open, and the live path is reported', () => {
  const f = fixture(); const { item, deps, issues, path } = openQuestion(f);
  rmSync(f.dir, { recursive: true });
  const after = syncDeskItems(deps).find(x => x.id === item.id);
  assert.equal(after.state, 'new'); assert.equal(after.outcome, null);
  assert.deepEqual(issues.map(x => x.path), [path]);
});

test('an archived goal whose file does not parse, or whose stage is not finished, keeps its item open with the live path reported', () => {
  for (const [label, text] of [['malformed', '{'], ['building', archivedGoal('build')]]) {
    const f = fixture(); const { item, deps, issues, path } = openQuestion(f);
    rmSync(f.dir, { recursive: true });
    const dir = archiveDir(f, 'one'); writeFileSync(join(dir, 'GOAL.json'), text); writeFileSync(join(dir, 'LOG.md'), `${LIVE_QUESTION}${DROP_ENTRIES}`);
    const after = syncDeskItems(deps).find(x => x.id === item.id);
    assert.equal(after.state, 'new', label); assert.equal(after.outcome, null, label);
    assert.deepEqual(issues.map(x => x.path), [path], label);
  }
});

test('an archived goal of another name, one-two, does not close the item of one', () => {
  const f = fixture(); const { item, deps, issues, path } = openQuestion(f);
  rmSync(f.dir, { recursive: true });
  const dir = archiveDir(f, 'one-two'); writeFileSync(join(dir, 'GOAL.json'), archivedGoal('dropped')); writeFileSync(join(dir, 'LOG.md'), `${LIVE_QUESTION}${DROP_ENTRIES}`);
  const after = syncDeskItems(deps).find(x => x.id === item.id);
  assert.equal(after.state, 'new'); assert.equal(after.outcome, null);
  assert.deepEqual(issues.map(x => x.path), [path]);
});

for (const fault of ['empty', 'malformed', 'unreadable']) {
  test(`a live goal file that is ${fault} keeps its item open, whatever the archive holds`, () => {
    const f = fixture(); const { item, deps, issues, path } = openQuestion(f);
    const dir = archiveDir(f, 'one'); writeFileSync(join(dir, 'GOAL.json'), archivedGoal('dropped')); writeFileSync(join(dir, 'LOG.md'), `${LIVE_QUESTION}${DROP_ENTRIES}`);
    if (fault !== 'unreadable') writeFileSync(path, fault === 'empty' ? '' : '{');
    // The live file exists on disk; for `unreadable` the reader returns nothing for it, as the production reader does on a read error.
    const read = (p) => (fault === 'unreadable' && p === path ? null : fixtureRead(p));
    const after = syncDeskItems({ ...deps, read }).find(x => x.id === item.id);
    assert.equal(after.state, 'new'); assert.equal(after.outcome, null);
    assert.ok(issues.some(x => x.path === path), 'the live path is reported');
    assert.ok(issues.every(x => x.path === path), 'nothing else is reported');
  });
}

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

/* ---- a programme item: the programme planning turn's */

const README_MD = '# prog\n\n## Parts\n\n### Part 1 — One\n\n### Part 2 — Two\n';
const PROGRAMME_RECORD = JSON.stringify({ schema: 'mc-programme', version: 2, horizon: null, end: 'Done when it holds.', state: 'ready', created: '2026-11-14T10:20:30Z', created_by: 'person' });
/** A goal of `prog` that names `parts` of its README.md, as the turn's session writes it. */
function namesParts(f, name, parts) {
  const dir = join(f.home, 'prog', 'goals', name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'GOAL.json'), goalJson({ status: 'ready', documents: [{ label: `Design, ${parts.map((part) => `Part ${part}`).join('; ')}`, path: join(f.home, 'prog', 'README.md') }] }));
}
/** A programme `prog` with a record and a page, and the prepared item its planning turn opened. */
function programmeItem(f, fields = {}) {
  const dir = join(f.home, 'prog'); mkdirSync(join(dir, 'goals'), { recursive: true });
  writeFileSync(join(dir, 'PROGRAMME.json'), PROGRAMME_RECORD); writeFileSync(join(dir, 'README.md'), README_MD);
  const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('programme', 'programme:prog', stamp), kind: 'programme', reference: 'programme:prog', source_at: stamp, opened_at: stamp, state: 'prepared', sort: 'mechanical', reversible: null, due_at: null, outcome: null, ...fields };
  writeDeskItem(item, { env: f.env });
  return item;
}
const turnStateAt = (f) => join(f.env.MC_WORK_ROOT, 'runner', 'programme-turn', 'prog.json');
function writeTurnState(f, text) { mkdirSync(join(f.env.MC_WORK_ROOT, 'runner', 'programme-turn'), { recursive: true }); writeFileSync(turnStateAt(f), text); }
const turnStateText = (...reasons) => JSON.stringify({ schema: 'mc-programme-turn', version: 1, programme: 'prog', failures: reasons.map((reason, index) => ({ at: `2026-11-14T10:0${index}:00Z`, reason, log: null })), items: [] });
function syncProgramme(f) {
  const issues = [];
  const item = syncDeskItems({ env: f.env, home: f.home, now: () => new Date(stamp), read: fixtureRead, reportIssue: (issue) => issues.push(issue) }).find((one) => one.reference === 'programme:prog');
  return { item, issues };
}

test('a programme item closes by source when goals name every part of its README.md, its record no longer reads valid and ready, or its directory is gone', () => {
  const open = fixture(); programmeItem(open);
  assert.equal(syncProgramme(open).item.state, 'prepared', 'a programme with no goal keeps its item open');
  writeFileSync(join(open.home, 'prog', 'goals', '.hold.json'), '{}');
  assert.equal(syncProgramme(open).item.state, 'prepared', 'a dot-entry of goals/ is no goal');

  // A goal that is there does not close it: only a document naming every part does (the runner's own completion predicate).
  const partial = fixture(); programmeItem(partial);
  mkdirSync(join(partial.home, 'prog', 'goals', 'plain'), { recursive: true }); writeFileSync(join(partial.home, 'prog', 'goals', 'plain', 'GOAL.json'), goalJson({ status: 'ready' }));
  namesParts(partial, 'one', [1]);
  assert.equal(syncProgramme(partial).item.state, 'prepared', 'goals naming no part, or part 1 only, leave the item open');
  namesParts(partial, 'two', [2]);
  const held = syncProgramme(partial).item;
  assert.deepEqual([held.state, held.outcome.by, held.outcome.summary], ['closed', 'source', 'Goals now name every part of the programme document.']);

  const changed = fixture(); programmeItem(changed); namesParts(changed, 'all', [1, 2]);
  writeFileSync(join(changed.home, 'prog', 'README.md'), `${README_MD}\n### Part 3 — Three\n`);
  assert.equal(syncProgramme(changed).item.state, 'prepared', 'a README.md with an uncut part closes nothing');

  for (const [kind, record] of [['draft', JSON.stringify({ ...JSON.parse(PROGRAMME_RECORD), state: 'draft' })]]) {
    const f = fixture(); programmeItem(f); writeFileSync(join(f.home, 'prog', 'PROGRAMME.json'), record);
    assert.equal(syncProgramme(f).item.state, 'closed', `${kind}: a record the turn can no longer cut from closes it`);
  }

  for (const [kind, record] of [['done', JSON.stringify({ ...JSON.parse(PROGRAMME_RECORD), state: 'done' })], ['invalid', '{ not json']]) {
    const f = fixture(); programmeItem(f); writeFileSync(join(f.home, 'prog', 'PROGRAMME.json'), record);
    const closed = syncProgramme(f).item;
    assert.deepEqual([closed.state, closed.outcome.by, closed.outcome.summary], ['closed', 'source', 'The programme record no longer reads valid and ready.'], kind);
  }

  // A repair order's cut is done when its release is reconciled: its goals may name every part while the release is refused.
  const repair = fixture(); programmeItem(repair); namesParts(repair, 'all', [1, 2]);
  const revision = 'b833c806-2932-46f3-81d6-ec21b75d8aad';
  const released = { ...JSON.parse(PROGRAMME_RECORD), created_by: 'repair', repair: {
    sources: [{ kind: 'proposal', path: '/evidence/proposal.md', key: 'a'.repeat(64), digest: 'b'.repeat(64) }],
    release: { revision, manifest: repairSnapshot(join(repair.home, 'prog')).manifest } } };
  writeFileSync(join(repair.home, 'prog', 'PROGRAMME.json'), JSON.stringify(released));
  assert.equal(syncProgramme(repair).item.state, 'prepared', 'a released repair order that is not reconciled keeps its item open, whatever its goals name');
  writeFileSync(join(repair.home, 'prog', 'PROGRAMME.json'), JSON.stringify({ ...released, repair: { ...released.repair,
    reconciled: { revision, reason: 'cut by code: one goal per released part', parts: [[1, 'c'.repeat(64)], [2, 'd'.repeat(64)]], goals: [] } } }));
  const reconciled = syncProgramme(repair).item;
  assert.deepEqual([reconciled.state, reconciled.outcome.by, reconciled.outcome.summary], ['closed', 'source', 'The repair release is now reconciled.']);

  const gone = fixture(); programmeItem(gone); rmSync(join(gone.home, 'prog'), { recursive: true, force: true });
  const missing = syncProgramme(gone).item;
  assert.deepEqual([missing.state, missing.outcome.by, missing.outcome.summary], ['closed', 'source', 'The programme directory is gone.']);
});

test('a programme item whose turn state cannot be read stays open, and the sync reports the file', () => {
  const f = fixture(); programmeItem(f);
  namesParts(f, 'g', [1, 2]);
  writeTurnState(f, '{ not json');
  const { item, issues } = syncProgramme(f);
  assert.equal(item.state, 'prepared', 'not closed on a source that could not be read, though goals name every part');
  const reported = issues.filter((issue) => issue.path === turnStateAt(f));
  assert.equal(reported.length, 1, 'the unreadable state file is reported');
  assert.match(reported[0].error, /not JSON/u);
});

test('a programme item is labelled by the reason of the last failure in its turn state', () => {
  const f = fixture(); const item = programmeItem(f);
  const ask = () => deskItemQuestion(item, { env: f.env, home: f.home, read: fixtureRead });
  assert.equal(ask(), 'Source reason unavailable.', 'no state file: no label to give');
  writeTurnState(f, turnStateText('planning session exited 0 with the programme holding no goal (a)', 'read checkout retained: /w/runner/work/programme-turn-prog/memoro'));
  assert.equal(ask(), 'read checkout retained: /w/runner/work/programme-turn-prog/memoro');
  writeTurnState(f, '{ not json');
  assert.equal(ask(), 'Source reason unavailable.', 'an unreadable state file gives none');
});

test('a text item is labelled by its text, a sync neither closes nor opens another for it, and an old-sort or due record still reads', () => {
  const f = fixture();
  const at = '2026-11-14T10:00:00.000Z';
  const text = { schema: 'mc-desk-item', version: 1, id: deskItemId('text', 'text:canon/x.md#A', at), kind: 'text', reference: 'text:canon/x.md#A', text: 'canon/x.md#A', goal: null, source_at: at, opened_at: at, state: 'for-martin', sort: 'text', reversible: null, due_at: null, outcome: null };
  const old = { schema: 'mc-desk-item', version: 1, id: deskItemId('goal', 'alpha/one', stamp), kind: 'goal', reference: 'alpha/one', source_at: stamp, opened_at: stamp, state: 'for-martin', sort: 'product', reversible: true, due_at: '2026-11-16T10:00:00Z', default_action: 'keep', outcome: null };
  for (const item of [text, old]) { mkdirSync(join(f.env.MC_WORK_ROOT, 'martin', 'items', item.id), { recursive: true }); writeJsonAtomic(join(f.env.MC_WORK_ROOT, 'martin', 'items', item.id, 'item.json'), item); }
  assert.equal(deskItemQuestion(text, { env: f.env, home: f.home, read: fixtureRead }), 'canon/x.md#A');
  const dep = { env: f.env, home: f.home, now: () => new Date('2026-11-20T10:00:00Z'), read: fixtureRead, reportIssue: () => {} };
  const synced = syncDeskItems(dep);
  assert.equal(synced.find((item) => item.id === text.id).state, 'for-martin', 'a text item has no source: only a close ends it, whatever the date');
  assert.deepEqual(synced.map((item) => item.id).sort(), [old.id, text.id].sort(), 'the sync opened nothing beside them');
  assert.deepEqual([readDeskItem(old.id, { env: f.env }).sort, readDeskItem(old.id, { env: f.env }).due_at], ['product', '2026-11-16T10:00:00Z']);
});

/* ---- a manager item: left by the removed horizon turn */

const horizonStateAt = (f, slug = 'h-one') => join(f.env.MC_WORK_ROOT, 'runner', 'manager-turn', 'horizon', `${slug}.json`);
const horizonStateText = (...reasons) => JSON.stringify({ schema: 'mc-manager-turn', version: 1, kind: 'horizon', horizon: 'h-one', failures: reasons.map((reason, index) => ({ at: `2026-11-14T10:0${index}:00Z`, reason, log: null })), items: [] });
/** A `prepared` manager item as the removed horizon turn opened it at its second failure. */
function managerItem(f, fields = {}) {
  const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('manager', 'manager:h-one', stamp), kind: 'manager', reference: 'manager:h-one', source_at: stamp, opened_at: stamp, state: 'prepared', sort: 'mechanical', reversible: null, due_at: null, outcome: null, ...fields };
  writeDeskItem(item, { env: f.env });
  return item;
}

test('a manager item left by the removed horizon turn closes by source, its state file left as it was', () => {
  const f = fixture(); managerItem(f);
  mkdirSync(join(f.env.MC_WORK_ROOT, 'runner', 'manager-turn', 'horizon'), { recursive: true }); writeFileSync(horizonStateAt(f), '{ not json');
  const item = syncDeskItems({ env: f.env, home: f.home, now: () => new Date(stamp), read: fixtureRead, reportIssue: () => {} }).find((one) => one.reference === 'manager:h-one');
  assert.deepEqual([item.state, item.outcome.by, item.outcome.summary], ['closed', 'source', "The manager's horizon turn is removed."]);
  assert.equal(readFileSync(horizonStateAt(f), 'utf8'), '{ not json', 'nothing on disk is rewritten');
});

test('a manager item is labelled by the reason of the last failure in its horizon state', () => {
  const f = fixture(); const item = managerItem(f);
  const ask = () => deskItemQuestion(item, { env: f.env, home: f.home, read: fixtureRead });
  assert.equal(ask(), 'Source reason unavailable.', 'no state file: no label to give');
  mkdirSync(join(f.env.MC_WORK_ROOT, 'runner', 'manager-turn', 'horizon'), { recursive: true });
  writeFileSync(horizonStateAt(f), horizonStateText('manager session ended with no programme, no reached horizon and no text item', 'read checkout retained: /w/runner/work/manager-turn-h-one/memoro'));
  assert.equal(ask(), 'read checkout retained: /w/runner/work/manager-turn-h-one/memoro');
  writeFileSync(horizonStateAt(f), '{ not json');
  assert.equal(ask(), 'Source reason unavailable.', 'an unreadable state file gives none');
});

test('one way to ask: the record — a reader row opens a decision item when its key differs, an unread row always does, and a row that took the recommendation does not',()=>{
  const f=fixture(); const ledger=join(f.env.MC_HOME,'jev','decisions.jsonl'); mkdirSync(join(f.env.MC_HOME,'jev'),{recursive:true});
  const row=(at,extra)=>({at,recommend:'a',question:'Question?',options:{a:'A',b:'B'},kind:null,...extra});
  writeFileSync(ledger,[
    row('2026-11-14T10:01:00Z',{outcome:'read',answered_by:'reader',chosen:'b',reader:{tool:'claude',model:'fable',key:'b',why:'the standard says b'}}),
    row('2026-11-14T10:02:00Z',{outcome:'read',answered_by:'reader',chosen:'a',reader:{tool:'claude',model:'fable',key:'a'}}),
    row('2026-11-14T10:03:00Z',{outcome:'decided',answered_by:'session',chosen:'a',unread_reason:'the reader ended without a verdict'}),
    row('2026-11-14T10:04:00Z',{outcome:'answered',answered_by:'jev',chosen:'a',answers:{answer:{choice:'a'},product:0.9}}),
    row('2026-11-14T10:05:00Z',{outcome:'answered',answered_by:'jev',chosen:'b',answers:{answer:{choice:'b'}}}),
    row('2026-11-14T10:06:00Z',{outcome:'text',answered_by:'reader',chosen:'a',desk_item:'abc123',reader:{tool:'claude',model:'fable',key:'a'}}),
  ].map(JSON.stringify).join('\n')+'\n');
  const items=syncDeskItems({env:f.env,home:f.home,now:()=>new Date(stamp),read:fixtureRead});
  assert.deepEqual(items.map(x=>x.reference).sort(),['decision:2026-11-14T10:01:00Z','decision:2026-11-14T10:03:00Z','decision:2026-11-14T10:05:00Z'],'a differing reader or jev answer and an unread one; the recommendation taken, however product jev read it, is not');
});

test('one way to ask: the record — an old decided row is flagged by the rule it had, and an old row with no answered_by is never unread',()=>{
  const f=fixture(); const ledger=join(f.env.MC_HOME,'jev','decisions.jsonl'); mkdirSync(join(f.env.MC_HOME,'jev'),{recursive:true});
  const old=(at,choice,product)=>({at,outcome:'decided',recommend:'a',question:'Question?',answers:{answer:{choice},product}});
  writeFileSync(ledger,[old('2026-11-14T10:01:00Z','a',0.1),old('2026-11-14T10:02:00Z','b',0.1),old('2026-11-14T10:03:00Z','a',0.8)].map(JSON.stringify).join('\n')+'\n');
  const items=syncDeskItems({env:f.env,home:f.home,now:()=>new Date(stamp),read:fixtureRead});
  assert.deepEqual(items.map(x=>x.reference).sort(),['decision:2026-11-14T10:02:00Z','decision:2026-11-14T10:03:00Z']);
});

test('one way to ask: the record — a text item proposed with a goal is found by a call that names it, and the goal is set once',async()=>{
  const { proposeText } = await import('../../src/mc/desk-texts.js');
  const f=fixture(); const brief='## Vad den säger\nA\n\n## Vad som föreslås\nB\n\n## Vad som hittades\nC\n';
  const text='canon/tasks/asking-martin.md#What mc does with it';
  const first=proposeText({env:f.env,text,brief,goal:null,now:new Date(stamp)});
  assert.ok(first.item,first.error); assert.equal(first.item.goal,null);
  const second=proposeText({env:f.env,text,brief,goal:'alpha/one',now:new Date('2026-11-14T11:00:00Z')});
  assert.equal(second.duplicate,true); assert.equal(second.item.id,first.item.id); assert.equal(second.item.goal,'alpha/one');
  assert.equal(readDeskItem(first.item.id,{env:f.env}).goal,'alpha/one','stored');
  const third=proposeText({env:f.env,text,brief,goal:'alpha/two',now:new Date('2026-11-14T12:00:00Z')});
  assert.equal(third.duplicate,true); assert.equal(third.item.goal,'alpha/one','an item that names a goal keeps it');
  assert.equal(readDeskItem(first.item.id,{env:f.env}).goal,'alpha/one');
});

test('a take-back item from the red ledger is read by mc martin get and never synced as a desk item', () => {
  const f=fixture();
  const started='2026-11-15T10:00:00.000Z';
  writeFileSync(join(f.env.MC_WORK_ROOT,'runner','check-red.json'),JSON.stringify({version:1,from:'2026-11-01T00:00:00.000Z',entries:{[started]:{sha:'b'.repeat(40),parts:[],pid:null,repair:[],take_back:'failed',desk:'Martin',reason:'memoro-tail was not taken back',created:started,done:true,steps:['Red: x']}}}));
  const dep={env:f.env,home:f.home,now:()=>new Date(stamp),read:fixtureRead};
  assert.deepEqual(syncDeskItems(dep),[],'the desk syncs goals and main-red only');
  assert.deepEqual(readdirSync(join(f.env.MC_WORK_ROOT,'martin','items')).filter(name=>!name.startsWith('.')),[]);
});

/* ---- an archive item: the programme archive turn's */

function archiveItem(f, fields = {}) {
  const dir = join(f.home, 'prog'); mkdirSync(join(dir, 'goals', '.archive', 'g1'), { recursive: true });
  writeFileSync(join(dir, 'PROGRAMME.json'), PROGRAMME_RECORD); writeFileSync(join(dir, 'README.md'), '# prog\n');
  const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('archive', 'archive:prog', stamp), kind: 'archive', reference: 'archive:prog', source_at: stamp, opened_at: stamp, state: 'prepared', sort: 'mechanical', reversible: null, due_at: null, outcome: null, ...fields };
  writeDeskItem(item, { env: f.env });
  return item;
}
const archiveStateAt = (f) => join(f.env.MC_WORK_ROOT, 'runner', 'archive-turn', 'prog.json');
function writeArchiveState(f, text) { mkdirSync(join(f.env.MC_WORK_ROOT, 'runner', 'archive-turn'), { recursive: true }); writeFileSync(archiveStateAt(f), text); }
function syncArchive(f) {
  const issues = [];
  const item = syncDeskItems({ env: f.env, home: f.home, now: () => new Date(stamp), read: fixtureRead, reportIssue: (issue) => issues.push(issue) }).find((one) => one.reference === 'archive:prog');
  return { item, issues };
}

test('an archive item closes by source only when its programme directory is gone or goals/ holds a live goal', () => {
  const open = fixture(); archiveItem(open);
  assert.equal(syncArchive(open).item.state, 'prepared', 'a finished programme keeps its item open');
  writeFileSync(join(open.home, 'prog', 'goals', '.hold.json'), '{}');
  assert.equal(syncArchive(open).item.state, 'prepared', 'a dot-entry of goals/ is no live goal');
  const done = fixture(); archiveItem(done); writeFileSync(join(done.home, 'prog', 'PROGRAMME.json'), JSON.stringify({ ...JSON.parse(PROGRAMME_RECORD), state: 'done' }));
  assert.equal(syncArchive(done).item.state, 'prepared', 'a record that reads done while the directory stands does not close it');

  const live = fixture(); archiveItem(live);
  mkdirSync(join(live.home, 'prog', 'goals', 'g'), { recursive: true }); writeFileSync(join(live.home, 'prog', 'goals', 'g', 'GOAL.json'), goalJson({ status: 'ready' }));
  const held = syncArchive(live).item;
  assert.deepEqual([held.state, held.outcome.by, held.outcome.summary], ['closed', 'source', 'The programme now holds a live goal.']);

  const gone = fixture(); archiveItem(gone); rmSync(join(gone.home, 'prog'), { recursive: true, force: true });
  const missing = syncArchive(gone).item;
  assert.deepEqual([missing.state, missing.outcome.by, missing.outcome.summary], ['closed', 'source', 'The programme directory is gone.']);
});

test('an archive item stays open while the moved directory\'s record does not read done, and closes by source once it does', () => {
  const f = fixture(); archiveItem(f, { state: 'for-martin' });
  const moved = join(f.home, '.archive-dest', 'prog'); mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, 'PROGRAMME.json'), PROGRAMME_RECORD);
  rmSync(join(f.home, 'prog'), { recursive: true, force: true });
  writeArchiveState(f, JSON.stringify({ schema: 'mc-archive-turn', version: 1, programme: 'prog', failures: [], items: [], reading: null, destination: moved }));
  assert.equal(syncArchive(f).item.state, 'for-martin', 'a record write still failing after the move keeps the item open');
  writeFileSync(join(moved, 'PROGRAMME.json'), JSON.stringify({ ...JSON.parse(PROGRAMME_RECORD), state: 'done' }));
  const closed = syncArchive(f).item;
  assert.deepEqual([closed.state, closed.outcome.by, closed.outcome.summary], ['closed', 'source', 'The programme directory is gone.']);
});

test('an archive item whose state cannot be read stays open and the sync reports the file; it is labelled by the last failure', () => {
  const f = fixture();
  const item = archiveItem(f);
  const ask = () => deskItemQuestion(item, { env: f.env, home: f.home, read: fixtureRead });
  assert.equal(ask(), 'The write-back reading found a gap.', 'no state file: the reading found a gap');
  writeArchiveState(f, JSON.stringify({ schema: 'mc-archive-turn', version: 1, programme: 'prog', failures: [{ at: '2026-11-14T10:00:00Z', reason: 'archive failed: gh is down\nmore', log: null }], items: [], reading: null, destination: null }));
  assert.equal(ask(), 'archive failed: gh is down');
  mkdirSync(join(f.home, 'prog', 'goals', 'g'), { recursive: true }); writeFileSync(join(f.home, 'prog', 'goals', 'g', 'GOAL.json'), goalJson({ status: 'ready' }));
  writeArchiveState(f, '{ not json');
  const { item: kept, issues } = syncArchive(f);
  assert.equal(kept.state, 'prepared', 'not closed on a source that could not be read');
  assert.equal(issues.filter((issue) => issue.path === archiveStateAt(f)).length, 1);
});

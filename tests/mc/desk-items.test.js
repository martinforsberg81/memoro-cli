import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deskItemId, syncDeskItems, listDeskItems } from '../../src/mc/desk-items.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { run as martin } from '../../src/mc/commands/martin.js';
import { goalJson } from './_helpers/goal-file.js';

const roots=[]; after(()=>roots.forEach(x=>rmSync(x,{recursive:true,force:true})));
function fixture() { const root=mkdtempSync(join(tmpdir(),'mc-desk-items-')); roots.push(root); const env={MC_WORK_ROOT:join(root,'mc'),MC_HOME:join(root,'mc-home')}; const home=join(env.MC_WORK_ROOT,'programs'); mkdirSync(join(home,'alpha','goals','one'),{recursive:true}); return {root,env,home,dir:join(home,'alpha','goals','one')}; }
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

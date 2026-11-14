import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deskItemId, syncDeskItems, listDeskItems } from '../../src/mc/desk-items.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
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

test('sync creates four live kinds once, ignores other ledger outcomes and only changes the item store',()=>{
  const f=fixture(); const two=join(f.home,'alpha','goals','two'); mkdirSync(two,{recursive:true});
  const q1='2026-11-14T10:00:00Z', q2='2026-11-14T10:01:00Z';
  writeFileSync(join(f.dir,'GOAL.json'),goalJson({status:'Martin'})); writeFileSync(join(f.dir,'LOG.md'),`## ${q1} · person · build · Martin\n\nComment: Martin is asked: Policy?\nOption a: A\nOption b: B\nRecommended: a\n`);
  writeFileSync(join(two,'GOAL.json'),goalJson({status:'Martin',title:'Two'})); writeFileSync(join(two,'LOG.md'),`## ${q1} · runner · build · Martin\n\nComment: runner failure: no response\n`);
  const mends=join(f.env.MC_WORK_ROOT,'runner','main-mend'); mkdirSync(mends,{recursive:true});
  writeFileSync(join(mends,'memoro.json'),JSON.stringify({version:1,entries:[{id:'red1',file:'tests/red.js',state:'Martin',created:q1,reason:'Repeated red'}]}));
  const ledger=join(f.env.MC_HOME,'jev','decisions.jsonl'); mkdirSync(join(f.env.MC_HOME,'jev'),{recursive:true});
  const row=(at,outcome,choice,product)=>({at,outcome,recommend:'a',question:'Decision?',answers:{answer:{choice},product}});
  writeFileSync(ledger,[row('2026-11-14T09:59:00Z','decided','b',0.1),row(q2,'decided','b',0.1),row('2026-11-14T10:02:00Z','decided','a',0.1),row('2026-11-14T10:03:00Z','answered','b',0.9)].map(JSON.stringify).join('\n')+'\n');
  const before=sourceSnapshot(f.root), deps={env:f.env,home:f.home,now:()=>new Date(q1),read:fixtureRead};
  const items=syncDeskItems(deps); assert.equal(items.length,4,JSON.stringify(items.map(x=>[x.kind,x.reference,x.source_at])));
  assert.deepEqual(items.map(x=>[x.kind,x.reference,x.source_at,x.state]).sort((a,b)=>a[1].localeCompare(b[1])),[
    ['goal','alpha/one',q1,'new'],['goal','alpha/two',q1,'new'],['decision',`decision:${q2}`,q2,'new'],['main-red','main-red:memoro/red1',q1,'new'],
  ].sort((a,b)=>a[1].localeCompare(b[1])));
  assert.deepEqual(sourceSnapshot(f.root),before);
  const fileSet=items.map(x=>readFileSync(join(f.env.MC_WORK_ROOT,'martin','items',x.id,'item.json'),'utf8'));
  syncDeskItems(deps); assert.deepEqual(items.map(x=>readFileSync(join(f.env.MC_WORK_ROOT,'martin','items',x.id,'item.json'),'utf8')),fileSet);
  assert.deepEqual(sourceSnapshot(f.root),before);
  const red=JSON.parse(readFileSync(join(mends,'memoro.json'),'utf8')); red.entries[0].state='landed'; writeFileSync(join(mends,'memoro.json'),JSON.stringify(red));
  const afterRed=sourceSnapshot(f.root); const redItem=syncDeskItems(deps).find(x=>x.kind==='main-red'); assert.equal(redItem.state,'closed'); assert.equal(redItem.outcome.by,'source'); assert.deepEqual(sourceSnapshot(f.root),afterRed);
  const goal=JSON.parse(readFileSync(join(f.dir,'GOAL.json'),'utf8')); goal.status='ready'; writeFileSync(join(f.dir,'GOAL.json'),JSON.stringify(goal));
  const afterReady=sourceSnapshot(f.root); const closed=syncDeskItems(deps).find(x=>x.reference==='alpha/one'); assert.equal(closed.state,'closed'); assert.equal(closed.outcome.by,'source'); assert.deepEqual(sourceSnapshot(f.root),afterReady);
  writeFileSync(join(two,'LOG.md'),`## ${q1} · runner · build · Martin\n\nComment: runner failure: no response\n\n## 2026-11-15T10:00:00Z · person · build · Martin\n\nComment: Martin is asked: New policy?\nOption a: A\nOption b: B\nRecommended: a\n`);
  const beforeLater=sourceSnapshot(f.root); const later=syncDeskItems(deps).filter(x=>x.reference==='alpha/two');
  assert.deepEqual(later.map(x=>x.state).sort(),['closed','new']); assert.equal(later.find(x=>x.state==='closed').outcome.by,'source'); assert.deepEqual(sourceSnapshot(f.root),beforeLater);
});

function sourceSnapshot(root) { const out=[]; function walk(p) { for (const n of readdirSync(p)) { const c=join(p,n); if (c.endsWith('/mc/martin')) continue; const st=lstatSync(c); if (st.isDirectory()) { out.push([c,'directory']); walk(c); } else out.push([c,'file',createHash('sha256').update(readFileSync(c)).digest('hex')]); } } walk(root); return out.sort((a,b)=>a[0].localeCompare(b[0])); }
function fixtureRead(path) { try { return readFileSync(path,'utf8'); } catch { return null; } }

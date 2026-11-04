import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, HELP } from '../../src/mc-admin-cli.js';
import { collectDashboard, renderDashboard } from '../../src/mc/admin-dashboard.js';

const fixed = () => new Date('2026-11-04T12:00:00.000Z');
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }; }
function sourceFor(url, data) { return url.endsWith('/health') ? data.health : url.endsWith('/usage-summary') ? data.usage : url.endsWith('/costs/summary') ? data.costs : data.operations; }
function fixtures() {
  return {
    usage: { ok:true, generatedAt:'2026-11-04T11:59:00Z', timezone:'UTC', activityBasis:'active_session_last_seen',
      windows:{yesterdayStart:'2026-11-03T00:00:00Z',todayStart:'2026-11-04T00:00:00Z',sevenDaysStart:'2026-10-28T12:00:00Z',end:'2026-11-04T12:00:00Z'},
      groups:['regular','test','review','admin','otherManaged'].map(kind => ({kind,total:2,activeYesterday:0,activeLastSevenDays:1,userId:123456789})) },
    costs: {ok:true, generatedAt:'2026-11-04T11:59:00Z',month:'2026-11',cards:{
      thisMonth:{usd:12,source:'actual',scope:'external_vendor',vendorRows:4,vendorDays:3,throughDate:'2026-11-03'},
      aiThisMonth:{usd:5,source:'partial',scope:'ai_rollup'},today:{usd:0,source:'estimate'},
      projected:{usd:999,secret:'excluded-cost-sentinel'} }},
    health: { ok:true, status:'degraded', checkedAt:'2026-11-04T11:59:00Z', services:{ secrets:{status:'not_configured', present:0,total:2}, d1:{status:'healthy',latency:0}, queues:{status:'healthy',note:'Binding available'}, universeVectors:{status:'healthy',vectorCount:0} }, secret:'health-secret' },
    operations: { ok:true, generatedAt:'2026-11-04T11:58:00Z', warnings:['warn_code'], operations:[
      { key:'z.ok',label:'Okay',state:'success',conclusion:{level:'ok',reasonCodes:[]},counts:{jobs:0,requests:null,userId:123456789,supportTicketId:654321,secret:'ops-secret'},latestRun:{startedAt:'2026-11-04T11:00:00Z',finishedAt:'2026-11-04T11:01:00Z'},payload:{password:'payload-secret'} },
      { key:'a.watch',label:'Watch\u001b[31m red',state:'warning',conclusion:{level:'watch',reasonCodes:['watch_code']},warnings:['op_warn'] },
      { key:'b.action',label:'Action',state:'error',conclusion:{level:'action',reasonCodes:['action_code']} },
      { key:'c.noverdict',label:'No verdict',state:'success',latestRun:{status:'success'} },
    ], incidents:{summary:{new:{count:2,occurrences:3},acknowledged:{count:0,occurrences:0}},totalGroups:2,totalOccurrences:3,raw:'incident-secret'}, error:'raw error secret' },
  };
}

test('entry validates before delegation, supports offline help, and sends only fixed child plus validated flag', async () => {
  let calls=[];
  assert.equal(await run(['--help'], { stdout:{write:s=>calls.push(s)}, env:{MC_HEADLESS:'1'} }),0);
  assert.match(calls[0],/read-only/);
  assert.equal(await run(['--oops'], { stderr:{write:s=>calls.push(s)}, env:{} }),1);
  assert.equal(await run(['--json','--json'], { stderr:{write:s=>calls.push(s)}, env:{} }),1);
  assert.equal(await run(['--json'], { env:{MC_HEADLESS:'1'}, stderr:{write:s=>calls.push(s)} }),1);
  assert.equal(await run([], { env:{}, cwd:'/tmp', stdout:{write(){}}, stderr:{write(){}}, runScriptWithKeys:async (...args)=>{calls.push(args);return 0;} }),0);
  assert.deepEqual(calls.at(-1).slice(1,2), [[]]);
  assert.match(calls.at(-1)[0],/scripts\/admin-dashboard\.js$/u);
  assert.equal(await run(['--json'], { env:{}, stdout:{write(){}}, stderr:{write(){}}, runScriptWithKeys:async (...args)=>{calls.push(args);return 0;} }),0);
  assert.deepEqual(calls.at(-1)[1],['--json']);
  assert.equal(await run([], {env:{}, stdout:{write(){}}, stderr:{write(){}}, runScriptWithKeys:async()=>17}),1);
});

test('collector requests only fixed bounded GET destinations and produces safe text and JSON projection', async () => {
  const data=fixtures(), calls=[];
  const fetch=async (url,options)=>{calls.push([url,options]); return response(sourceFor(url,data));};
  const {model,exitCode}=await collectDashboard({token:'test-token',fetch,clock:fixed});
  assert.equal(exitCode,0);
  assert.deepEqual(calls.map(c=>c[0]).sort(),['https://meetmemoro.app/admin/costs/summary','https://meetmemoro.app/admin/health','https://meetmemoro.app/admin/operations/status','https://meetmemoro.app/admin/usage-summary']);
  for(const [,o] of calls){ assert.equal(o.method,'GET'); assert.equal(o.redirect,'error'); assert.equal(o.cache,'no-store'); assert.equal(o.headers['Cache-Control'],'no-store'); assert.equal(o.headers['X-Operator-Purpose'],'maintenance'); assert.equal(o.headers.Authorization,'Bearer test-token'); assert.ok(o.signal); }
  assert.equal(model.schemaVersion,2); assert.equal(model.sources.health.ageSeconds,60); assert.equal(model.sources.operations.ageSeconds,120);
  assert.equal(model.sources.health.data.services.find(s=>s.name==='d1').latency,0);
  assert.equal(model.sources.health.data.services.find(s=>s.name==='universeVectors').counts.vectorCount,0);
  assert.equal(model.sources.operations.data.operations.find(o=>o.key==='z.ok').counts.jobs,0);
  assert.equal(model.sources.operations.data.operations.find(o=>o.key==='z.ok').counts.requests,undefined);
  assert.deepEqual(model.sources.operations.data.operations.find(o=>o.key==='z.ok').counts,{jobs:0});
  assert.deepEqual(model.sources.operations.data.operations.map(o=>[o.key,o.level,o.reasons]),[ ['z.ok','ok',[]], ['a.watch','watch',['watch_code']], ['b.action','action',['action_code']], ['c.noverdict','unknown',[]] ]);
  assert.deepEqual(model.sources.operations.data.incidents,{groups:[{status:'new',count:2,occurrences:3},{status:'acknowledged',count:0,occurrences:0}],totalGroups:2,totalOccurrences:3});
  const ordered=renderDashboard(model).split('\n').filter(s=>/^([a-z]\.|[a-z]\.noverdict)/u.test(s));
  assert.deepEqual(ordered.map(s=>s.split(' ')[0]),['b.action','a.watch','c.noverdict','z.ok']);
  const text=renderDashboard(model), json=JSON.stringify(model);
  for(const secret of ['health-secret','ops-secret','payload-secret','incident-secret','raw error secret']) { assert.equal(text.includes(secret),false); assert.equal(json.includes(secret),false); }
  assert.doesNotMatch(text+json,/123456789|654321|userId|supportTicketId/);
  assert.match(text,/universeVectors: healthy; vectorCount=0/);
  assert.equal(model.sources.health.data.services.find(s=>s.name==='queues').status,'healthy');
  assert.match(text,/queues: healthy; Binding available \(binding availability only; not delivery health or backlog\)/);
  assert.ok(!text.includes('\u001b')); assert.match(text,/Stored incident aggregates/); assert.match(text,/not delivery health or backlog/); assert.match(text,/support detail are not connected yet/); assert.match(text,/incidents acknowledged: 0 groups \/ 0 occurrences/); assert.match(text,/a.watch warning op_warn/);
  assert.equal(model.sources.health.data.services.find(s=>s.name==='secrets').status,'not_configured');
});

test('missing token, partial failures and invalid source never become zero or erase the other source', async () => {
  let count=0;
  let result=await collectDashboard({clock:fixed,token:null,fetch:async()=>{count++;}});
  assert.equal(count,0); assert.equal(result.exitCode,1); assert.equal(result.model.sources.health.errorCode,'missing_credentials');
  const good=fixtures().health;
  for(const bad of [response('{}'),response('{bad'),response(fixtures().operations,401),response(fixtures().operations,403),response(fixtures().operations,500),response({ok:false,error:'do not leak'}),response({ok:true,operations:Array(201).fill({key:'x'}),incidents:{}})]) {
    result=await collectDashboard({clock:fixed,token:'t',fetch:async url=>url.endsWith('/health')?response(good):bad});
    assert.equal(result.exitCode,1); assert.equal(result.model.sources.health.availability,'available'); assert.equal(result.model.sources.operations.availability,'unavailable');
    assert.equal(result.model.sources.operations.data,null);
  }
  result=await collectDashboard({clock:fixed,token:'t',fetch:async url=>url.endsWith('/health')?response(good):Promise.reject(new TypeError('redirect blocked'))});
  assert.equal(result.model.sources.operations.availability,'unavailable');
  result=await collectDashboard({clock:fixed,token:'t',fetch:async url=>url.endsWith('/health')?response(good):Promise.reject(Object.assign(Error('secret'),{name:'TimeoutError'}))});
  assert.equal(result.model.sources.operations.errorCode,'timeout'); assert.equal(result.model.sources.health.data.services[0].counts.present,0);
});

test('strict response limit, list bounds, unknown timestamps and future source time are explicit', async () => {
  const huge={ok:true,operations:[], padding:'x'.repeat(1024*1024)};
  let result=await collectDashboard({clock:fixed,token:'t',fetch:async url=>response(url.endsWith('/health')?fixtures().health:huge)});
  assert.equal(result.model.sources.operations.errorCode,'response_too_large');
  const over={ok:true,operations:[{key:'x',warnings:Array(51).fill('x')}],incidents:{summary:{}}};
  result=await collectDashboard({clock:fixed,token:'t',fetch:async url=>response(url.endsWith('/health')?{ok:true,status:'healthy',services:{},checkedAt:'nope'}:over)});
  assert.equal(result.model.sources.operations.errorCode,'too_many_items');
  assert.equal(result.model.sources.health.availability,'available');
  assert.equal(result.model.sources.health.timestamp,null); assert.equal(result.model.sources.health.ageSeconds,null);
  const future={ok:true,status:'healthy',services:{},checkedAt:'2027-01-01T00:00:00Z'};
  result=await collectDashboard({clock:fixed,token:'t',fetch:async url=>response(url.endsWith('/health')?future:fixtures().operations)});
  assert.equal(result.model.sources.health.future,true); assert.match(renderDashboard(result.model),/future timestamp/);
  // Both sources are generated during the request, before collection completes.
  let current = fixed();
  const data = fixtures();
  data.health.checkedAt = '2026-11-04T12:00:01Z';
  data.operations.generatedAt = '2026-11-04T12:00:02Z';
  result = await collectDashboard({token:'t', clock:() => current, fetch:async url => {
    current = new Date('2026-11-04T12:00:03Z');
    return response(sourceFor(url,data));
  }});
  assert.equal(result.model.fetchedAt, '2026-11-04T12:00:03.000Z');
  assert.equal(result.model.sources.health.ageSeconds, 2);
  assert.equal(result.model.sources.operations.ageSeconds, 1);
  assert.equal(result.model.sources.health.future, false);
  assert.equal(result.model.sources.operations.future, false);
  assert.doesNotMatch(renderDashboard(result.model), /future timestamp/);
});

test('package maps both binaries and runner failure cannot expose error details', async () => {
  const pkg=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url)));
  const lock=JSON.parse(readFileSync(new URL('../../package-lock.json',import.meta.url)));
  assert.equal(pkg.bin['mc-admin'],'src/mc-admin-cli.js'); assert.equal(lock.packages[''].bin['mc-admin'],pkg.bin['mc-admin']);
  assert.match(HELP,/credentials/); assert.match(HELP,/Exit codes/);
  let output=''; await run([], {env:{},stdout:{write(){}},stderr:{write:s=>output+=s},runScriptWithKeys:async()=>1});
  assert.doesNotMatch(output,/ADMIN_TOKEN|secret/);
});

 test('package executable follows symlinks and prints offline help', () => {
  const scratch=mkdtempSync(join(tmpdir(),'mc-admin-entry-'));
  try {
    const link=join(scratch,'mc-admin');
    symlinkSync(fileURLToPath(new URL('../../src/mc-admin-cli.js',import.meta.url)),link);
    const result=spawnSync(process.execPath,[link,'--help'],{encoding:'utf8',env:{...process.env,MC_HEADLESS:'1',MC_HOME:join(scratch,'home'),MC_WORK_ROOT:join(scratch,'work')}});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/Usage: mc-admin/);
    assert.equal(result.stderr,'');
  } finally { rmSync(scratch,{recursive:true,force:true}); }
});

test('usage and costs retain periods, account groups and quality without sensitive or legacy detail', async () => {
  const data = fixtures();
  const { model, exitCode } = await collectDashboard({token:'t',clock:fixed,fetch:async url=>response(sourceFor(url,data))});
  assert.equal(exitCode,0);
  assert.deepEqual(model.sources.usage.data.groups, ['regular','test','review','admin','otherManaged'].map(kind=>({kind,total:2,activeYesterday:0,activeLastSevenDays:1})));
  assert.deepEqual(model.sources.usage.data.windows, data.usage.windows);
  assert.deepEqual(model.sources.costs.data, {month:'2026-11',vendor:{usd:12,source:'actual',throughDate:'2026-11-03',days:3},aiMonth:{usd:5,source:'partial'},aiToday:{usd:0,source:'estimate'}});
  const text = renderDashboard(model), json = JSON.stringify(model);
  assert.match(text,/regular: 2 accounts; active yesterday 0; active 7d 1/);
  assert.match(text,/External vendors 2026-11 \(UTC\): USD 12.00; actual; recorded through 2026-11-03; 3 days represented/);
  assert.match(text,/AI metered 2026-11 to date \(UTC\): USD 5.00; partial/);
  assert.match(text,/AI metered today \(UTC\): USD 0.00; estimate/);
  assert.match(text,/overlaps vendor costs; do not add/);
  assert.doesNotMatch(text+json,/excluded-cost-sentinel|123456789|userId|projected|999/);
});

test('missing vendor imports remain unknown and invalid or unavailable new sources preserve operations', async () => {
  const data = fixtures();
  data.costs.cards.thisMonth = {...data.costs.cards.thisMonth,usd:0,source:'estimate',vendorRows:0,vendorDays:0,throughDate:null};
  let result = await collectDashboard({token:'t',clock:fixed,fetch:async url=>response(sourceFor(url,data))});
  assert.equal(result.exitCode,0);
  assert.equal(result.model.sources.costs.data.vendor.usd,null);
  assert.match(renderDashboard(result.model),/External vendors 2026-11 \(UTC\): unknown; unknown/);
  assert.match(renderDashboard(result.model),/Vendor cost data unavailable/);
  data.costs = fixtures().costs;
  data.costs.cards.thisMonth.usd = 0;
  result = await collectDashboard({token:'t',clock:fixed,fetch:async url=>response(sourceFor(url,data))});
  assert.equal(result.model.sources.costs.data.vendor.usd,0);
  for (const name of ['usage','costs']) {
    for (const failure of ['http','shape']) {
      result = await collectDashboard({token:'t',clock:fixed,fetch:async url=> {
        if (url.endsWith(name === 'usage' ? '/usage-summary' : '/costs/summary')) return failure === 'http' ? response({error:'private provider error'},403) : response({ok:true});
        return response(sourceFor(url,data));
      }});
      assert.equal(result.exitCode,1);
      assert.equal(result.model.sources[name].availability,'unavailable');
      assert.equal(result.model.sources[name].data,null);
      assert.equal(result.model.sources.operations.availability,'available');
      assert.doesNotMatch(JSON.stringify(result.model),/private provider error/);
    }
  }
  data.usage.groups[0].kind = 'admin';
  result = await collectDashboard({token:'t',clock:fixed,fetch:async url=>response(sourceFor(url,data))});
  assert.equal(result.model.sources.usage.errorCode,'invalid_shape');
});

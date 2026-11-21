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
      groups:['regular','test','review','admin','otherManaged'].map((kind, i) => ({kind,total:[11,3,4,1,5][i],activeYesterday:[2,0,1,0,3][i],activeLastSevenDays:[5,1,2,1,4][i],userId:123456789})) },
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
  assert.match(calls[0],/Exit codes: .*1 .*partial usage, or a daily usage rollup behind yesterday \(UTC\)/);
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
  assert.deepEqual(model.sources.usage.data, {...legacyProjection, dailyUsage:null});
  assert.deepEqual(model.sources.costs.data, {month:'2026-11',vendor:{usd:12,source:'actual',throughDate:'2026-11-03',days:3},aiMonth:{usd:5,source:'partial'},aiToday:{usd:0,source:'estimate'}});
  const text = renderDashboard(model), json = JSON.stringify(model);
  assert.deepEqual(text.split('\n').slice(text.split('\n').indexOf('USAGE'), text.split('\n').indexOf('COSTS') - 1), [
    'USAGE', 'Daily usage is unavailable on this server.', ...fallback,
  ]);
  assert.match(text,/External vendors 2026-11 \(UTC\): USD 12.00; actual; recorded through 2026-11-03; 3 days represented/);
  assert.match(text,/AI metered 2026-11 to date \(UTC\): USD 5.00; partial/);
  assert.match(text,/AI metered today \(UTC\): USD 0.00; estimate/);
  assert.match(text,/overlaps vendor costs; do not add/);
  assert.doesNotMatch(text+json,/excluded-cost-sentinel|123456789|userId|projected|999/);
});

test('usage shows the exact account total beyond the safe integer range', async () => {
  const data = fixtures();
  const totals = [Number.MAX_SAFE_INTEGER, 2, 0, 0, 0];
  const groups = data.usage.groups.map(({kind}, i) => ({
    kind, total:totals[i], activeYesterday:0, activeLastSevenDays:0,
  }));
  data.usage.groups = groups;
  const { model, exitCode } = await collectDashboard({token:'t',clock:fixed,fetch:async url=>response(sourceFor(url,data))});
  assert.equal(exitCode,0);
  const lines = renderDashboard(model).split('\n');
  assert.equal(lines[lines.indexOf('USAGE') + 2], '9007199254740993 accounts in total');
  assert.deepEqual(JSON.parse(JSON.stringify(model)).sources.usage.data.groups, groups);
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


test('zero usage is successful and an isolated usage failure stays unknown', async () => {
  const data = fixtures();
  data.usage.groups = data.usage.groups.map(group => ({...group,total:0,activeYesterday:0,activeLastSevenDays:0}));
  let result = await collectDashboard({token:'t',clock:fixed,fetch:async url=>response(sourceFor(url,data))});
  assert.equal(result.exitCode,0);
  let text = renderDashboard(result.model);
  assert.match(text,/0 accounts in total/);
  assert.deepEqual(text.split('\n').filter(line => /^(regular|test|review|admin|otherManaged):/.test(line)),
    ['regular','test','review','admin','otherManaged'].map(kind => `${kind}: 0 accounts, with a session last seen yesterday 0, trailing 168 hours 0`));
  result = await collectDashboard({token:'t',clock:fixed,fetch:async url=>url.endsWith('/usage-summary') ? response({},503) : response(sourceFor(url,data))});
  assert.equal(result.exitCode,1);
  assert.equal(result.model.sources.usage.availability,'unavailable');
  assert.equal(result.model.sources.usage.data,null);
  for (const name of ['health','operations','costs']) assert.equal(result.model.sources[name].availability,'available');
  text = renderDashboard(result.model);
  assert.match(text,/unknown \(usage source unavailable\)/);
  assert.doesNotMatch(text,/accounts in total/);
  assert.match(text,/External vendors 2026-11/);
});

const kinds = ['regular', 'test', 'review', 'admin', 'otherManaged'];
const healthyAttention = '- No reported attention signals; unknown source or conclusion remains unknown.';
const partialAttention = '- Daily usage is unavailable.';
const accountLines = ['regular: 11 accounts', 'test: 3 accounts', 'review: 4 accounts', 'admin: 1 account', 'otherManaged: 5 accounts'];
const legacyProjection = {
  timezone:'UTC', activityBasis:'active_session_last_seen',
  windows:{yesterdayStart:'2026-11-03T00:00:00Z',todayStart:'2026-11-04T00:00:00Z',sevenDaysStart:'2026-10-28T12:00:00Z',end:'2026-11-04T12:00:00Z'},
  groups:[
    {kind:'regular',total:11,activeYesterday:2,activeLastSevenDays:5},
    {kind:'test',total:3,activeYesterday:0,activeLastSevenDays:1},
    {kind:'review',total:4,activeYesterday:1,activeLastSevenDays:2},
    {kind:'admin',total:1,activeYesterday:0,activeLastSevenDays:1},
    {kind:'otherManaged',total:5,activeYesterday:3,activeLastSevenDays:4},
  ],
};
const fallback = [
  '24 accounts in total',
  'UTC session-recency windows: yesterday [2026-11-03T00:00:00Z, 2026-11-04T00:00:00Z), trailing 168 hours [2026-10-28T12:00:00Z, 2026-11-04T12:00:00Z)',
  'Account totals exclude deleted accounts. Admin takes precedence over managed groups.',
  'Session recency counts active accounts with an active session last seen in the window. A return visit or sign-out can change earlier counts.',
  'regular: 11 accounts, with a session last seen yesterday 2, trailing 168 hours 5',
  'test: 3 accounts, with a session last seen yesterday 0, trailing 168 hours 1',
  'review: 4 accounts, with a session last seen yesterday 1, trailing 168 hours 2',
  'admin: 1 account, with a session last seen yesterday 0, trailing 168 hours 1',
  'otherManaged: 5 accounts, with a session last seen yesterday 3, trailing 168 hours 4',
];

function dailyFixture({ day = '2026-11-03', start = '2026-10-28', marker = '2026-10-27',
  complete = true, zero = false, assistantOnly = false } = {}) {
  const measured = day && !zero;
  const regular = measured ? [assistantOnly ? 0 : 2, assistantOnly ? 0 : 3, 1, 2, 34] : [0, 0, 0, 0, 0];
  const admin = measured && !assistantOnly ? [0, 1, 0, 0, 0] : [0, 0, 0, 0, 0];
  const groups = kinds.map((kind, i) => {
    const [users, users7d, aiUsers, aiUsers7d, aiQuestions] = i === 0 ? regular : i === 3 ? admin : [0, 0, 0, 0, 0];
    return { kind, users:day ? users : null, users7d:day && complete ? users7d : null,
      aiUsers:day ? aiUsers : null, aiUsers7d:day && complete ? aiUsers7d : null, aiQuestions:day ? aiQuestions : null };
  });
  return { date:day, window7d:day ? {start,end:day,complete} : null,
    collectionStartedAt:marker ? `${marker}T00:00:00.000Z` : null,
    uniqueUsers:day ? regular[0] : null, uniqueUsers7d:day && complete ? regular[1] + admin[1] : null,
    aiUsers:day ? regular[2] : null, aiUsers7d:day && complete ? regular[3] : null, aiQuestions:day ? regular[4] : null, groups };
}

async function readUsage(extension) {
  const data = fixtures();
  Object.assign(data.usage, extension);
  data.health = { ok:true, status:'healthy', checkedAt:data.health.checkedAt,
    services:Object.fromEntries(['secrets','d1','r2','kv','universeVectors','queues'].map(name => [name, {status:'healthy'}])) };
  data.operations = { ok:true, generatedAt:data.operations.generatedAt, operations:[],
    incidents:{summary:{},totalGroups:0,totalOccurrences:0} };
  const { model, exitCode } = await collectDashboard({token:'t',clock:fixed,fetch:async url=>response(sourceFor(url,data))});
  const text = renderDashboard(model);
  const json = JSON.stringify(model);
  const usage = JSON.parse(json).sources.usage;
  return { text, json, usage, exitCode };
}

function assertUsage(result, { dailyUsage, exitCode = 0, availability = 'available', attention = healthyAttention, lines }) {
  const { text, json, usage } = result;
  assert.equal(result.exitCode, exitCode);
  assert.equal(JSON.parse(json).schemaVersion, 2);
  assert.deepEqual(usage, { availability, errorCode:availability === 'partial' ? 'daily_usage_unavailable' : null,
    timestamp:'2026-11-04T11:59:00Z', ageSeconds:60, future:false, data:{...legacyProjection,dailyUsage} });
  assert.equal(text.split('\n')[1], `Sources: health available; operations available; usage ${availability}; costs available`);
  assert.equal(text.split('\nATTENTION\n')[1].split('\n\nUSAGE\n')[0], attention);
  assert.deepEqual(text.split('\nUSAGE\n')[1].split('\n\nCOSTS\n')[0].split('\n'), lines);
  assert.match(text,/External vendors 2026-11 \(UTC\): USD 12.00; actual/);
}

const usageBasis = 'Daily usage counts accounts with signed-in app requests per UTC day, from the nightly rollup. Groups are as of the rollup and can be revised for seven days.';
function completeLines(day, interval, { zero = false, assistantOnly = false } = {}) {
  const [used, weekly, ai, aiWeek, questions, regularWeek, adminWeek] = zero ? [0,0,0,0,0,0,0]
    : assistantOnly ? [0,0,1,2,34,0,0] : [2,4,1,2,34,3,1];
  return [
    `Unique users ${day}: ${used}`, `Unique users ${interval}: ${weekly}`,
    `Asked the assistant ${day}: ${ai} (${questions} questions); ${interval}: ${aiWeek}`,
    '24 accounts in total', usageBasis,
    `regular: 11 accounts; ${day} used ${used}, assistant ${ai}; last 7 days used ${regularWeek}, assistant ${aiWeek}`,
    `test: 3 accounts; ${day} used 0, assistant 0; last 7 days used 0, assistant 0`,
    `review: 4 accounts; ${day} used 0, assistant 0; last 7 days used 0, assistant 0`,
    `admin: 1 account; ${day} used 0, assistant 0; last 7 days used ${adminWeek}, assistant 0`,
    `otherManaged: 5 accounts; ${day} used 0, assistant 0; last 7 days used 0, assistant 0`,
  ];
}

test('daily report leads with actual UTC dates, distinct counts, known zero and separate assistant use', async () => {
  for (const options of [{}, {zero:true}, {assistantOnly:true}]) {
    const dailyUsage = dailyFixture(options);
    const reordered = {...dailyUsage, groups:[...dailyUsage.groups].reverse()};
    assertUsage(await readUsage({dailyUsage:reordered}), {
      dailyUsage, lines:completeLines('2026-11-03', '2026-10-28 – 2026-11-03', options),
    });
  }
  const dailyUsage = dailyFixture({day:'2026-11-02',start:'2026-10-27',marker:'2026-10-26'});
  assertUsage(await readUsage({dailyUsage}), {
    dailyUsage, exitCode:1, attention:'- Daily usage rollup is behind (latest 2026-11-02).',
    lines:completeLines('2026-11-02', '2026-10-27 – 2026-11-02'),
  });
});

test('collecting and earlier holes retain daily readings; waiting or empty has totals only', async () => {
  for (const [marker, since] of [['2026-11-01', ' since 2026-11-02'], ['2026-10-27', ' since 2026-10-28'], [null, '']]) {
    const dailyUsage = dailyFixture({marker, complete:false});
    assertUsage(await readUsage({dailyUsage}), { dailyUsage, lines:[
      'Unique users 2026-11-03: 2', `Unique users last 7 days: collecting${since}`,
      'Asked the assistant 2026-11-03: 1 (34 questions); last 7 days: collecting',
      '24 accounts in total', usageBasis,
      'regular: 11 accounts; 2026-11-03 used 2, assistant 1; last 7 days collecting',
      ...accountLines.slice(1).map(group => `${group}; 2026-11-03 used 0, assistant 0; last 7 days collecting`),
    ] });
  }
  for (const marker of ['2026-11-03', null]) {
    const dailyUsage = dailyFixture({day:null, marker});
    assertUsage(await readUsage({dailyUsage}), { dailyUsage, lines:[
      'Unique users: waiting for the first nightly rollup', '24 accounts in total', ...accountLines,
    ] });
  }
});

const partial = { dailyUsage:null, exitCode:1, availability:'partial', attention:partialAttention, lines:fallback };

test('an omitted extension is compatible; explicit or lookalike failures keep exact legacy fallback', async () => {
  assertUsage(await readUsage({}), { dailyUsage:null, lines:['Daily usage is unavailable on this server.', ...fallback] });
  for (const extension of [
    {dailyUsage:null}, {dailyUsageError:'unavailable'}, {dailyUsage:null,dailyUsageError:'unavailable'},
    {dailyUsage:null,dailyUsageError:'USAGE-PRIVATE-SENTINEL'}, {dailyUsage:dailyFixture(),dailyUsageError:'unavailable'},
  ]) {
    const result = await readUsage(extension);
    assert.doesNotMatch(result.text + result.json, /USAGE-PRIVATE-SENTINEL/);
    assertUsage(result, partial);
  }
});

test('misleading daily counts, group membership, UTC dates and null combinations are independently rejected', async () => {
  const invalid = {
    negative: d => { d.groups[0].aiQuestions = d.aiQuestions = -1; },
    fractional: d => { d.groups[0].aiQuestions = d.aiQuestions = 0.5; },
    unsafe: d => { d.groups[0].aiQuestions = d.aiQuestions = Number.MAX_SAFE_INTEGER + 1; },
    duplicate: d => { d.groups[2] = d.groups[1]; },
    missing: d => { d.groups.pop(); },
    weeklyAboveTotal: d => { d.groups[0].users7d = 12; d.uniqueUsers7d = 13; },
    weeklyAssistantAboveTotal: d => { d.groups[3].aiUsers7d = 2; d.aiUsers7d = 4; },
    dailyAboveWeekly: d => { d.groups[0].users = d.uniqueUsers = 4; },
    dailyAssistantAboveWeekly: d => { d.groups[0].aiUsers = d.aiUsers = 3; },
    mismatchedSum: d => { d.uniqueUsers7d = 3; },
    wrongInterval: d => { d.window7d.start = '2026-10-29'; },
    wrongEnd: d => { d.window7d.end = '2026-11-02'; },
    dateTimeInsteadOfDate: d => { d.date = d.window7d.end = '2026-11-03T00:00:00Z'; },
    normalizedButNonexistentDate: d => { d.date = d.window7d.end = '2026-02-29'; d.window7d.start = '2026-02-23'; d.collectionStartedAt = '2026-02-21T00:00:00.000Z'; },
    currentDate: d => { d.date = d.window7d.end = '2026-11-04'; d.window7d.start = '2026-10-29'; },
    markerNotMidnight: d => { d.collectionStartedAt = '2026-10-27T12:23:00.000Z'; },
    noCoverage: d => { d.collectionStartedAt = null; },
    firstDayIsNotFullyCovered: d => { d.collectionStartedAt = '2026-10-28T00:00:00.000Z'; },
    weeklyWhileCollecting: d => { d.window7d.complete = false; },
    waitingWithWindow: d => { d.date = null; },
    waitingWithCounts: d => { d.date = d.window7d = null; },
  };
  for (const [name, change] of Object.entries(invalid)) {
    const dailyUsage = dailyFixture();
    change(dailyUsage);
    try {
      assertUsage(await readUsage({dailyUsage}), partial);
    } catch (error) {
      throw new Error(name, {cause:error});
    }
  }
});

test('forbidden daily fields are rejected at each object level and never reach text or JSON', async () => {
  for (const target of [d => d, d => d.window7d, d => d.groups[0]]) {
    const dailyUsage = dailyFixture();
    target(dailyUsage).forbidden = 'USAGE-PRIVATE-SENTINEL';
    const result = await readUsage({dailyUsage});
    assert.doesNotMatch(result.text + result.json, /USAGE-PRIVATE-SENTINEL/);
    assertUsage(result, partial);
  }
});

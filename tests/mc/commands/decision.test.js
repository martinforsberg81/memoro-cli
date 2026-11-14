import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../../../src/mc/commands/decision.js';
import { fixture, result } from '../_helpers/decision-fixture.js';

function command(f, args = [], env = f.env) {
  let out = '', err = '';
  return run(args, { env, cwd:f.root, runnerDeps:f.deps,
    stdout:{write:s=>{out+=s;}}, stderr:{write:s=>{err+=s;}} }).then(code=>({code,out,err}));
}
test('manual decision id launches the real decision lane and reports its outcome and state', async t => {
  const f = fixture(t), item = f.add('alpha/first');
  f.deps.session = async call => { f.calls.push(call); await f.close(item); return result; };
  const out = await command(f,[item.id]);
  assert.equal(out.code,0,out.err);
  assert.equal(out.out,`mc: decision ${item.id}: decision; state closed\n`);
  assert.deepEqual(f.calls.map(x=>[x.env.MC_ROLE,x.env.MC_HEADLESS,x.env.MC_GOAL]),[['decision','1','alpha/first']]);
});
test('manual decision without id takes only the oldest prepared item, and empty succeeds', async t => {
  const f = fixture(t), first = f.add('decision:older'), second = f.add('decision:newer',{source_at:'2026-11-14T11:00:00Z'});
  f.deps.session = async () => { await f.close(first); return result; };
  assert.match((await command(f)).out,new RegExp(first.id,'u'));
  assert.equal(f.state(second).state,'prepared');
  await f.close(second);
  const empty = await command(f); assert.equal(empty.code,0); assert.equal(empty.out,'mc: no prepared desk item\n');
});
test('manual decision is refused inside sessions before constructing a runner', async () => {
  for (const env of [{MC_ROLE:'decision'},{MC_HEADLESS:'1'},{CODEX_THREAD_ID:'thread'},{MC_GOAL:'alpha/first'}]) {
    let err = '';
    assert.equal(await run([], {env, cwd:'/tmp', stderr:{write:s=>{err+=s;}}, runner:()=>assert.fail('nested runner')}),2);
    assert.match(err,/do not start it inside a session/u);
  }
});

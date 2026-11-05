import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { getAdapter } from '../../src/adapters/index.js';
import { runManagerTurn } from '../../src/mc/manager-turn.js';
import { applyObservation, normaliseCapacity } from '../../src/mc/model-capacity.js';

function fixture(t, tool = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'mc-manager-turn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let released = 0;
  return {
    calls, released: () => released,
    options: {
      prompt: 'Resolve the blocked merge', tool,
      env: { ...process.env, MC_WORK_ROOT: root, MC_ROLE: 'build-session:goal', MC_GOAL: 'other/task', MC_PROGRAMME: 'other', MC_REPO: 'other', MC_MODEL: 'old-model', MC_TOOL: 'old-tool', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret' },
      deps: {
        launch: () => ({ ok: true, id: tool === 'codex' ? 'codex' : 'claude-code', shortName: tool, adapter: getAdapter(tool === 'codex' ? 'codex' : 'claude-code'), spec: { bin: '/fake/model' } }),
        billingRoute: () => ({ billing: 'plan' }),
        register: () => () => { released += 1; },
        session: async o => { calls.push(o); return { status: 0, stdout: tool === 'codex' ? '{"type":"thread.started","thread_id":"fresh"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n' : '{"type":"result","subtype":"success","result":"Done","session_id":"fresh"}', stderr: '' }; },
      },
    },
  };
}

it('starts a new unattended session every time for either provider and isolates it from desk history', async t => {
  for (const tool of ['codex', 'claude']) {
    const f = fixture(t, tool);
    const first = await runManagerTurn(f.options);
    const second = await runManagerTurn(f.options);
    assert.equal(first.ok, true);
    assert.equal(first.answer, 'Done');
    assert.equal(second.ok, true);
    assert.notEqual(first.log, second.log);
    assert.equal(f.released(), 2);
    for (const call of f.calls) {
      assert.match(call.cwd, /\/runner\/manager\//u);
      assert.equal(call.timeoutMs, 30 * 60_000);
      assert.equal(call.env.MC_ROLE, 'manager');
      assert.equal(call.env.MC_HEADLESS, '1');
      assert.equal(call.env.MC_TOOL, tool);
      assert.equal(call.env.MC_MODEL, first.model);
      assert.equal(call.env.MC_SCRATCH, call.cwd);
      for (const key of ['MC_GOAL', 'MC_PROGRAMME', 'MC_REPO', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(call.env[key], undefined);
      assert.ok(!call.args.includes('resume') && !call.args.includes('--resume'));
      assert.ok(call.args.some(arg => arg.includes('Resolve the blocked merge')));
      assert.ok(call.args.some(arg => arg.includes('You are the manager session')));
      if (tool === 'codex') {
        assert.equal(call.args[0], 'exec');
        assert.ok(call.args.includes('--skip-git-repo-check'));
        assert.ok(call.args.includes('gpt-6.1-sol'));
      } else assert.ok(call.args.includes('-p'));
    }
    assert.equal(JSON.parse(readFileSync(first.log)).ok, true);
  }
});

it('unattended Manager honors saved Codex priority with a valid catalog model and effort', async t => {
  const f = fixture(t);
  let priority = 'codex';
  let seen;
  let capacity = applyObservation(normaliseCapacity(null), 'claude', {
    windows: { five_hour: { fraction_used: 0.9, resets_at: '2026-11-05T22:00:00Z' }, seven_day: { fraction_used: 0.9, resets_at: '2026-11-12T18:00:00Z' } },
  }, new Date('2026-11-05T18:00:00Z'));
  capacity = applyObservation(capacity, 'codex', {
    windows: { primary: { fraction_used: 0.1, resets_at: '2026-11-05T22:00:00Z' } },
    models: [{ id: 'gpt-6.1-sol', efforts: ['high'] }],
  }, new Date('2026-11-05T18:00:00Z'));
  const result = await runManagerTurn({
    ...f.options, tool: null, model: null,
    deps: { ...f.options.deps, catalog: () => ({ providerPriority: priority, large: [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] }), capacity: () => capacity,
      launch: (tool) => ({ ok: true, id: tool === 'codex' ? 'codex' : 'claude-code', shortName: tool, adapter: getAdapter(tool === 'codex' ? 'codex' : 'claude-code'), spec: { bin: '/fake/model' } }),
      session: async (call) => { seen = call; return { status: 0, stdout: '{"type":"thread.started","thread_id":"fresh"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n{"type":"turn.completed","usage":{}}\n', stderr: '' }; } },
  });
  assert.equal(result.tool, 'codex');
  assert.equal(result.model, 'gpt-6.1-sol');
  assert.ok(seen.args.includes('model_reasoning_effort=high'));
  assert.equal(result.providerPriority, 'codex');
  priority = 'claude';
  const fallback = await runManagerTurn({ ...f.options, tool: null, model: null, deps: { ...f.options.deps,
    catalog: () => ({ providerPriority: priority, large: [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] }), capacity: () => capacity,
    launch: (tool) => ({ ok: true, id: tool === 'codex' ? 'codex' : 'claude-code', shortName: tool, adapter: getAdapter(tool === 'codex' ? 'codex' : 'claude-code'), spec: { bin: '/fake/model' } }),
  } });
  assert.deepEqual([fallback.tool, fallback.model, fallback.providerPriority], ['claude', 'opus', 'claude']);
});

it('records failures and timeouts and releases the running-session record', async t => {
  for (const result of [{ status: 7, stdout: '', stderr: 'tool failed' }, { status: 142, timedOut: true, stdout: '', stderr: '' }]) {
    const f = fixture(t);
    f.options.deps.session = async () => result;
    const actual = await runManagerTurn({ ...f.options, minutes: 2 });
    assert.equal(actual.ok, false);
    assert.equal(actual.status, result.status);
    assert.equal(JSON.parse(readFileSync(actual.log)).status, result.status);
    assert.equal(f.released(), 1);
  }
  const f = fixture(t, 'claude');
  f.options.deps.session = async () => ({ status: 0, stdout: '{"type":"result","is_error":true,"result":"failed"}', stderr: '' });
  assert.equal((await runManagerTurn(f.options)).ok, false);
});

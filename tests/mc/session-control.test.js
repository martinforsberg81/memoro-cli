import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'node:test';
import { createSessionControl, decideSessionControl, controlResponse, validateControlProfile } from '../../src/mc/session-control.js';
import { startProjectSessionControl, observeProjectSessionControl, projectSessionCheckpoint, readAutonomousState } from '../../src/mc/autonomous-state.js';
import { run } from '../../src/mc/commands/session-control.js';
import { run as projectCommand } from '../../src/mc/commands/autonomous-project.js';
import { builder, reviewer, stateFixture } from './autonomous-state-fixture.js';
import { attribution, autonomousEvidence } from './autonomy-fixtures.js';
import { AUTONOMOUS_EXECUTION_ENABLED } from '../../src/mc/autonomous-project.js';
import { VERB_MODULES } from '../../src/mc-verbs.js';

const profile = () => ({ soft_active_ms: 100, upper_active_ms: 200, emergency_active_ms: 300, reserve_active_ms: 100,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 200, tool_wait_ms: 120, lane_wait_ms: 150, total_awake_ms: 1000,
  no_progress_ms: 800, max_stagnant_sessions: 3, max_failures: 3 });
const binding = (run_id = 'build-1') => ({ ...attribution(), run_id });
const model = { kind: 'model', id: null };
const progress = (id = 'proof-1', criterion_id = null) => ({ id, reference: `evidence/${id}.json`, criterion_id });
// Synthetic normalized observations, not captured transport telemetry. The clock
// explicitly separates wall and awake time, including simulated machine sleep.
function clock() {
  let at = 1000; let awake = 0; let sequence = 0;
  return (ms = 0, extra = {}) => {
    at += ms + (extra.sleep || 0); awake += ms;
    const { sleep, ...fields } = extra;
    return { sequence: sequence++, at_ms: at, awake_ms: awake, activity: model, context: null, progress: null, failure: null, ...fields };
  };
}
function fresh(p = profile(), previous = null, runId = 'build-1') {
  const tick = clock(); const state = createSessionControl({ binding: binding(runId), profile: p, observation: tick(), previous });
  return { tick, state };
}
function context(fraction, at_ms = 1000, quality = 'measured') { return { fraction, at_ms, source: 'synthetic-current-context', quality }; }

it('criterion completion beyond soft time closes with reserve, but mid-criterion soft time continues', () => {
  const { tick, state } = fresh();
  const mid = decideSessionControl(state, tick(100)); assert.equal(controlResponse(mid).next_action, 'continue');
  const closing = decideSessionControl(mid, tick(1, { progress: progress('schema-proof', 'schema') }));
  assert.equal(closing.phase, 'closing'); assert.equal(closing.reason, 'criterion-soft-boundary');
  assert.equal(controlResponse(closing).next_action, 'finish-session'); assert.equal(controlResponse(closing).allows_new_work, false);
  assert.ok(closing.profile.emergency_active_ms - closing.totals.active_ms >= closing.profile.reserve_active_ms);
  const later = decideSessionControl(closing, tick(1, { progress: progress('integration-proof', 'integration') }));
  assert.equal(later.phase, 'closing'); assert.equal(later.closing_awake_ms, closing.closing_awake_ms);
});
it('soft current context closes only on a newly completed measured criterion', () => {
  const { tick, state } = fresh();
  const soft = decideSessionControl(state, tick(0, { context: context(0.6) }));
  assert.equal(soft.phase, 'running');
  const checkpoint = decideSessionControl(soft, tick(0, { context: context(0.6), progress: progress() }));
  assert.equal(checkpoint.phase, 'running');
  const done = decideSessionControl(checkpoint, tick(0, { context: context(0.6), progress: progress('done', 'schema') }));
  assert.equal(done.phase, 'closing');
});
it('a replayed criterion is not a new boundary in a fresh session', () => {
  const a = fresh(); const first = decideSessionControl(a.state, a.tick(0, { progress: progress('done', 'schema') }));
  const b = fresh(profile(), first, 'build-2');
  const next = decideSessionControl(b.state, b.tick(100, { progress: progress('duplicate-proof', 'schema') }));
  assert.equal(next.phase, 'running');
});
it('upper time and context close mid-criterion without granting new-work permission', () => {
  const a = fresh(); assert.equal(decideSessionControl(a.state, a.tick(200)).phase, 'closing');
  const b = fresh(); const upper = decideSessionControl(b.state, b.tick(0, { context: context(0.7) }));
  assert.equal(upper.phase, 'closing'); assert.equal(upper.reason, 'upper-boundary');
});
it('rejects profiles that consume gate/fix/publication/handoff reserve', () => {
  for (const change of [{ upper_active_ms: 201 }, { reserve_context: 0.3 }, { closing_ms: 99 }, { total_awake_ms: 200 },
    { soft_active_ms: 200 }, { tool_wait_ms: Infinity }, { max_failures: 0 }, { soft_context: NaN }]) {
    assert.throws(() => validateControlProfile({ ...profile(), ...change }), /profile/);
  }
});
it('closing permits a bounded gate and fixes, not an exemption from emergency time', () => {
  const { tick, state } = fresh();
  const closing = decideSessionControl(state, tick(200, { activity: { kind: 'gate', id: 'gate-1' } }));
  const gating = decideSessionControl(closing, tick(100, { activity: { kind: 'gate', id: 'gate-1' } }));
  assert.equal(gating.phase, 'closing'); assert.equal(gating.totals.active_ms, 200); assert.equal(gating.totals.gate_ms, 100);
  const fixes = decideSessionControl(gating, tick(0));
  const stopped = decideSessionControl(fixes, tick(100));
  assert.equal(stopped.phase, 'incomplete'); assert.equal(stopped.result.normal_exit, false);
  assert.equal(controlResponse(stopped).next_action, 'stop-session');
});
it('each known tool/gate has a bounded wait even if status output continues', () => {
  for (const kind of ['tool', 'gate', 'lane']) {
    const { tick, state } = fresh(); const activity = { kind, id: 'job-1' };
    const waiting = decideSessionControl(state, tick(0, { activity }));
    const limit = kind === 'lane' ? 150 : 120;
    const almost = decideSessionControl(waiting, tick(limit - 1, { activity }));
    assert.equal(almost.phase, 'running'); assert.equal(almost.totals.active_ms, 0);
    const stopped = decideSessionControl(almost, tick(1, { activity }));
    assert.equal(stopped.reason, `${kind}-wait-exhausted`); assert.equal(stopped.result.outcome, 'incomplete');
  }
});
it('a tool completion sample cannot hide an over-budget wait', () => {
  const { tick, state } = fresh(); const tool = decideSessionControl(state, tick(0, { activity: { kind: 'tool', id: 'job-1' } }));
  assert.equal(decideSessionControl(tool, tick(120)).reason, 'tool-wait-exhausted');
});
it('sleep is recorded separately and does not consume active, tool or closing time', () => {
  const { tick, state } = fresh();
  const closing = decideSessionControl(state, tick(200, { activity: { kind: 'gate', id: 'gate-1' } }));
  const awake = decideSessionControl(closing, tick(10, { sleep: 86_400_000, activity: { kind: 'gate', id: 'gate-1' } }));
  assert.equal(awake.phase, 'closing'); assert.equal(awake.totals.active_ms, 200);
  assert.equal(awake.totals.gate_ms, 10); assert.equal(awake.totals.sleep_ms, 86_400_000);
});
it('missing/stale context is unknown, never zero; time remains an effective fallback', () => {
  const { tick, state } = fresh(); assert.equal(state.context.quality, 'unknown'); assert.equal(state.context.fraction, null);
  const stale = decideSessionControl(state, tick(100, { context: context(0.95) }));
  assert.equal(stale.context.quality, 'unknown'); assert.equal(stale.phase, 'running');
  assert.equal(decideSessionControl(stale, tick(100)).phase, 'closing');
});
it('retains source, timestamp and estimated quality rather than claiming measured context', () => {
  const { tick, state } = fresh(); const sample = context(0.6, 1000, 'estimated');
  assert.deepEqual(decideSessionControl(state, tick(0, { context: sample })).context, sample);
  assert.throws(() => decideSessionControl(state, { ...tick(0), context: { cumulative_input_tokens: 30000 } }), /context/);
});
it('final context and closing boundaries record an incomplete attempt, never a green result', () => {
  const a = fresh(); const stop = decideSessionControl(a.state, a.tick(0, { context: context(0.9) }));
  assert.equal(stop.result.outcome, 'incomplete'); assert.equal(stop.result.run_id, 'build-1');
  const b = fresh(); let state = decideSessionControl(b.state, b.tick(200));
  // Separate short tools keep each individual wait below its bound.
  for (let i = 0; i < 4; i++) state = decideSessionControl(state, b.tick(i === 0 ? 0 : 60, { activity: { kind: 'tool', id: `tool-${i}` } }));
  state = decideSessionControl(state, b.tick(20)); assert.equal(state.reason, 'emergency-boundary');
  assert.equal(state.result.normal_exit, false);
});
it('a hard total awake bound prevents endless tool/lane chains', () => {
  const { tick, state: first } = fresh(); let state = first;
  for (let i = 0; i < 12; i++) state = decideSessionControl(state, tick(i ? 100 : 0, { activity: { kind: 'tool', id: `tool-${i}` } }));
  assert.equal(state.phase, 'incomplete'); assert.equal(state.totals.active_ms, 0); assert.equal(state.reason, 'emergency-boundary');
});
it('no-progress active time survives fresh sessions and duplicate checkpoints', () => {
  const p = { ...profile(), no_progress_ms: 150 }; const a = fresh(p);
  const first = decideSessionControl(a.state, a.tick(90)); const b = fresh(p, JSON.parse(JSON.stringify(first)), 'build-2');
  const stopped = decideSessionControl(b.state, b.tick(60));
  assert.equal(stopped.phase, 'plan_pending'); assert.equal(stopped.history.no_progress_ms, 150);
  assert.equal(stopped.result.outcome, 'needs-plan'); assert.equal(controlResponse(stopped).next_action, 'needs-plan');
  const c = fresh(); const measured = decideSessionControl(c.state, c.tick(10, { progress: progress() }));
  const d = fresh(p, measured, 'build-2');
  const replayed = decideSessionControl(d.state, d.tick(150, { progress: progress() }));
  assert.equal(replayed.phase, 'plan_pending');
});
it('measured checkpoints reset stagnation; output bytes are not a progress signal', () => {
  const { tick, state } = fresh(); const working = decideSessionControl(state, tick(90));
  const measured = decideSessionControl(working, tick(10, { progress: progress() }));
  assert.equal(measured.history.no_progress_ms, 0); assert.equal(measured.run_progress, true);
  assert.throws(() => decideSessionControl(measured, { ...tick(1), output_bytes: 1000000 }), /observation/);
});
it('fresh conversations cannot reset repeated failures or stagnant session counts', () => {
  const a = fresh(); const failed = decideSessionControl(a.state, a.tick(0, { failure: { id: 'failure-1', reference: 'logs/first' } }));
  const b = fresh(profile(), failed, 'build-2');
  const failedAgain = decideSessionControl(b.state, b.tick(0, { failure: { id: 'failure-2', reference: 'logs/second' } }));
  const c = fresh(profile(), failedAgain, 'build-3');
  const pending = decideSessionControl(c.state, c.tick(0, { failure: { id: 'failure-3', reference: 'logs/third' } }));
  assert.equal(pending.reason, 'repeated-failures'); assert.equal(pending.result.normal_exit, false);
  let state = fresh().state;
  for (let i = 2; i <= 4; i++) state = fresh(profile(), state, `build-${i}`).state;
  assert.equal(state.reason, 'no-measured-progress'); assert.equal(state.history.stagnant_sessions, 3);
});
it('observations are pure, replay-idempotent, ordered and terminal decisions are sticky', () => {
  const { tick, state } = fresh(); const bytes = JSON.stringify(state); const o = tick(200);
  const closing = decideSessionControl(state, o); assert.equal(JSON.stringify(state), bytes);
  assert.deepEqual(decideSessionControl(closing, o), closing);
  assert.throws(() => decideSessionControl(closing, { ...o, at_ms: o.at_ms + 1 }), /conflicting/);
  assert.throws(() => decideSessionControl(closing, { ...o, sequence: 5 }), /out-of-order/);
  assert.throws(() => decideSessionControl(closing, { ...o, sequence: 2, awake_ms: 900 }), /clock/);
  const stopped = decideSessionControl(closing, tick(100));
  assert.deepEqual(decideSessionControl(stopped, tick(1, { progress: progress() })), stopped);
  assert.throws(() => fresh(profile(), state, 'build-1'), /new run/);
  assert.throws(() => createSessionControl({ binding: { ...binding('build-2'), goal_revision: 2 }, profile: profile(), observation: clock()(), previous: state }), /revision/);
});
function controlled(t) {
  const fx = stateFixture(); t.after(fx.cleanup); fx.setupProject(); let state = fx.switchProject(builder);
  const tick = clock(); const options = () => ({ actor: builder, revision: state.revision });
  state = startProjectSessionControl(fx.root, fx.programme, fx.project, { ...options(), profile: profile(), observation: tick() });
  return { ...fx, tick, current: () => state, observe: o => (state = observeProjectSessionControl(fx.root, fx.programme, fx.project, { ...options(), observation: o })),
    callback: (op, input = {}, extra = {}) => {
      const response = projectSessionCheckpoint(fx.root, fx.programme, fx.project, op, input, { ...options(), ...extra });
      state = readAutonomousState(fx.root, fx.programme, fx.project); return response;
    } };
}
it('status, criterion and checkpoint return the durable closing action after disk reload', async t => {
  const fx = controlled(t); fx.observe(fx.tick(200));
  for (const [op, input] of [['status', {}], ['checkpoint', { reference: 'evidence/partial.json' }], ['criterion', { criterion_id: 'schema', reference: 'evidence/schema.json' }]]) {
    const response = fx.callback(op, input); assert.equal(response.next_action, 'finish-session'); assert.equal(response.allows_new_work, false);
    assert.equal(response.observation_sequence, 1);
  }
  assert.equal(fx.json(fx.paths.project).session_control.phase, 'closing');
  assert.equal(fx.current().session_control.history.checkpoints.length, 0, 'model claims are not measured checkpoints');
  assert.equal(VERB_MODULES['session-control'], './mc/commands/session-control.js'); assert.equal(AUTONOMOUS_EXECUTION_ENABLED, false);
  const revision = fx.current().revision;
  const code = await run(['status', 'test-programme/test-project', '--expected-revision', String(revision)], { ...fx.deps, actor: builder });
  assert.equal(code, 0, fx.err.join('')); assert.equal(JSON.parse(fx.out.at(-1)).next_action, 'finish-session');
});
it('callbacks cannot choose a budget, inject clocks, reset progress or write as another run/role', async t => {
  const fx = controlled(t); const revision = fx.current().revision;
  for (const input of [{ reference: 'proof', profile: profile() }, { reference: 'proof', at_ms: 0 }, { reference: 'proof', progress: progress() }]) {
    assert.throws(() => fx.callback('checkpoint', input), /budgets/);
  }
  assert.throws(() => fx.callback('status', {}, { actor: reviewer }), /ownership/);
  assert.throws(() => fx.callback('status', {}, { actor: { ...builder, run_id: 'build-2' } }), /ownership/);
  assert.throws(() => fx.callback('status', {}, { revision: revision - 1 }), /stale/);
  assert.throws(() => fx.callback('criterion', { criterion_id: 'outside', reference: 'proof' }), /criterion/);
  assert.equal(await run(['status', 'test-programme/test-project', '--expected-revision', String(revision), '--budget', '1'], { ...fx.deps, actor: builder }), 1);
  assert.equal(fx.json(fx.paths.project).revision, revision);
});
it('stagnation persists atomically on disk across run ownership and fresh-session clocks', t => {
  const fx = controlled(t); fx.observe(fx.tick(90)); let state = fx.switchProject({ run_id: 'build-2', role: 'step' });
  const tick = clock(); const actor = state.active_run;
  state = startProjectSessionControl(fx.root, fx.programme, fx.project, { actor, revision: state.revision, profile: { ...profile(), no_progress_ms: 150 }, observation: tick() });
  state = observeProjectSessionControl(fx.root, fx.programme, fx.project, { actor, revision: state.revision, observation: tick(60) });
  assert.equal(fx.json(fx.paths.project).session_control.history.no_progress_ms, 150);
  const response = projectSessionCheckpoint(fx.root, fx.programme, fx.project, 'status', {}, { actor, revision: state.revision });
  assert.equal(response.next_action, 'needs-plan'); assert.equal(response.result.normal_exit, false);
});
it('a failed atomic control write returns no new action and preserves the previous state', t => {
  const fx = controlled(t); const before = readFileSync(fx.paths.project, 'utf8');
  assert.throws(() => observeProjectSessionControl(fx.root, fx.programme, fx.project, { actor: builder, revision: fx.current().revision,
    observation: fx.tick(200), write: () => { throw new Error('disk unavailable'); } }), /disk unavailable/);
  assert.equal(readFileSync(fx.paths.project, 'utf8'), before);
});
it('legacy v2 progress responses remain unchanged without initialized control', async t => {
  const fx = stateFixture(); t.after(fx.cleanup); fx.setupProject(); const state = fx.switchProject(builder);
  const file = fx.file(autonomousEvidence().builder[0]);
  assert.equal(await projectCommand(['progress', 'test-programme/test-project', '--expected-revision', String(state.revision), '--input-file', file], { ...fx.deps, actor: builder }), 0, fx.err.join(''));
  assert.equal(JSON.parse(fx.out.at(-1)).control, undefined);
});

it('criterion progress command returns the cached durable next action, not a self-selected budget', async t => {
  const fx = controlled(t); fx.observe(fx.tick(200));
  const code = await projectCommand(['progress', 'test-programme/test-project', '--expected-revision', String(fx.current().revision),
    '--input-file', fx.file(autonomousEvidence().builder[0])], { ...fx.deps, actor: builder });
  assert.equal(code, 0, fx.err.join(''));
  const response = JSON.parse(fx.out.at(-1)); assert.equal(response.control.next_action, 'finish-session');
  assert.equal(response.session_control.history.checkpoints.length, 0);
});
it('a callback request is durable but never extends the closing deadline', async t => {
  const fx = controlled(t); fx.observe(fx.tick(200)); const closing = fx.current().session_control;
  for (const [op, input] of [['checkpoint', { reference: 'evidence/partial' }], ['criterion', { reference: 'evidence/schema', criterion_id: 'schema' }]]) {
    const code = await run([op, 'test-programme/test-project', '--expected-revision', String(readAutonomousState(fx.root, fx.programme, fx.project).revision),
      '--input-file', fx.file(input)], { ...fx.deps, actor: builder });
    assert.equal(code, 0, fx.err.join('')); assert.equal(JSON.parse(fx.out.at(-1)).next_action, 'finish-session');
    const state = fx.json(fx.paths.project).session_control;
    assert.equal(state.closing_awake_ms, closing.closing_awake_ms); assert.deepEqual(state.request, { operation: op, ...input, observation_sequence: 1 });
  }
});
it('terminal incomplete attempts contribute to repeated failure history across sessions', () => {
  let previous = null;
  for (let i = 1; i <= 3; i++) {
    const a = fresh(profile(), previous, `build-${i}`);
    const progressState = decideSessionControl(a.state, a.tick(0, { progress: progress(`proof-${i}`) }));
    previous = decideSessionControl(progressState, a.tick(300));
    assert.equal(previous.result.outcome, 'incomplete'); assert.equal(previous.result.pending_plan, true);
  }
  const next = fresh(profile(), previous, 'build-4');
  assert.equal(next.state.phase, 'plan_pending'); assert.equal(next.state.reason, 'repeated-failures');
});
it('persisted last measured checkpoint retains its evidence reference in the next conversation', () => {
  const a = fresh(); const checkpoint = decideSessionControl(a.state, a.tick(10, { progress: progress() }));
  const b = fresh(profile(), JSON.parse(JSON.stringify(checkpoint)), 'build-2');
  assert.deepEqual(b.state.history.last_progress, { ...progress(), run_id: 'build-1', at_ms: 1010 });
});
it('corrupt persisted control and out-of-assignment measured criteria fail closed', t => {
  const fx = controlled(t); const before = readFileSync(fx.paths.project, 'utf8');
  assert.throws(() => fx.observe(fx.tick(1, { progress: progress('proof', 'outside') })), /criterion/);
  for (const mutate of [s => { s.session_control.profile.tool_wait_ms = null; },
    s => { s.session_control.history.checkpoints = null; }, s => { s.session_control.phase = 'green'; }]) {
    const state = JSON.parse(before); mutate(state); writeFileSync(fx.paths.project, JSON.stringify(state));
    assert.throws(() => fx.callback('status'), /invalid/);
    writeFileSync(fx.paths.project, before);
  }
});

it('pending plan results cannot be erased by starting another conversation', () => {
  const a = fresh({ ...profile(), max_failures: 1 });
  const pending = decideSessionControl(a.state, a.tick(0, { failure: { id: 'failed', reference: 'logs/failed' } }));
  assert.throws(() => fresh({ ...profile(), max_failures: 100 }, pending, 'build-2'), /pending plan/);
});
it('duplicate failure events do not inflate failure counts across fresh sessions', () => {
  const a = fresh(); const event = { id: 'failed', reference: 'logs/failed' };
  const failed = decideSessionControl(a.state, a.tick(0, { failure: event }));
  const b = fresh(profile(), failed, 'build-2');
  const replayed = decideSessionControl(b.state, b.tick(0, { failure: event }));
  assert.equal(replayed.history.failures, 1);
  assert.deepEqual(replayed.history.last_failure, { ...event, run_id: 'build-1', at_ms: 1000 });
});
it('bounded checkpoint history goes to plan rather than dropping replay protection', () => {
  const { tick, state: initial } = fresh(); let state = initial;
  for (let i = 0; i <= 256; i++) state = decideSessionControl(state, tick(0, { progress: progress(`proof-${i}`) }));
  assert.equal(state.history.checkpoints.length, 256); assert.equal(state.reason, 'checkpoint-history-full');
  assert.equal(state.result.outcome, 'needs-plan');
});

it('aggregate awake work also reserves an entire closing window before its hard limit', () => {
  const { tick, state: initial } = fresh(); let state = initial;
  for (let i = 0; i <= 8; i++) state = decideSessionControl(state, tick(i ? 100 : 0, { activity: { kind: 'tool', id: `tool-${i}` } }));
  assert.equal(state.totals.active_ms, 0); assert.equal(state.phase, 'closing');
  assert.equal(state.profile.total_awake_ms - state.totals.awake_ms, state.profile.closing_ms);
  assert.equal(controlResponse(state).allows_new_work, false);
  assert.throws(() => validateControlProfile({ ...profile(), closing_ms: 900 }), /reserve/);
});

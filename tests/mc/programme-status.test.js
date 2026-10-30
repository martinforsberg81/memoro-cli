import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../../src/mc/commands/programme.js';
import { CONTROL_CAPABILITIES } from '../../src/mc/programme-control.js';
import { programmeStatus, renderProgrammeStatus, autonomySection } from '../../src/mc/programme-status.js';
import { claimProgrammeJob, reconcileProgrammeQueue, recordProgrammeTrigger, setProgrammeJobMode } from '../../src/mc/programme-jobs.js';
import { readAutonomousState, startAutonomousBuild } from '../../src/mc/autonomous-state.js';
import { createSessionControl } from '../../src/mc/session-control.js';
import { autonomousChoice } from '../../src/mc/autonomous-run.js';
import { routeAutonomousReview } from '../../src/mc/autonomous-outcomes.js';
import { reviewCommandRefusal } from '../../src/mc/autonomous-review-guard.js';
import { renderProject } from '../../src/mc/status-project.js';
import { renderPageLines } from '../../src/mc/page-render.js';
import { intakeSection, mergesSection, nextSection, programmesSection, runnerSection, sessionsSection } from '../../src/mc/page-collect.js';
import { programmeJobsFixture } from './programme-jobs-fixture.js';
import { builder } from './autonomous-state-fixture.js';
import { autonomousProject, attribution } from './autonomy-fixtures.js';

const profile = { soft_active_ms: 100, upper_active_ms: 200, emergency_active_ms: 300, reserve_active_ms: 100,
  soft_context: 0.5, upper_context: 0.7, emergency_context: 0.9, reserve_context: 0.1, context_stale_ms: 50,
  closing_ms: 200, tool_wait_ms: 120, lane_wait_ms: 150, total_awake_ms: 1000,
  no_progress_ms: 800, max_stagnant_sessions: 3, max_failures: 3 };
const opus = { tool: 'claude', model: 'opus', effort: 'high' };
const luna = { tool: 'codex', model: 'gpt-6-luna', effort: 'high' };
const supported = { supported: [...CONTROL_CAPABILITIES] };
const NOW = Date.parse('2026-10-29T12:00:00Z');
const sha = 'b'.repeat(40);

function fixture(t) {
  const f = programmeJobsFixture(); t.after(f.cleanup);
  const out = []; const err = [];
  f.cli = (argv, deps = {}) => {
    out.length = 0; err.length = 0;
    return run(argv, { root: f.root, env: {}, now: () => NOW, stdout: { write: line => out.push(line) },
      stderr: { write: line => err.push(line) }, ...deps });
  };
  f.out = () => out.join(''); f.err = () => err.join('');
  f.raw = () => readFileSync(f.paths.programme, 'utf8');
  f.start = (deps = { capabilities: supported }, stop = 'design-review') => f.cli(['autonomy', f.programme, 'on',
    '--expected-revision', String(f.read().revision), '--stop', stop, '--by', 'Martin'], deps);
  // A reader fixture writes the trusted fields a runner would have written.
  f.patch = change => {
    const state = JSON.parse(readFileSync(f.paths.project, 'utf8'));
    change(state); state.revision++;
    writeFileSync(f.paths.project, JSON.stringify(state));
    return readAutonomousState(f.root, f.programme, f.project);
  };
  f.release = () => f.patch(state => { state.active_run = null; });
  f.building = () => f.patch(state => {
    state.phase = 'running'; state.active_run = builder; state.runs.push(builder);
    state.ownership = { branch: 'test-project', pr: 42 };
    state.model_history = [{ run_id: builder.run_id, model: luna, goal_revision: state.goal_revision }];
    state.reviewer_model = opus;
    state.evidence.builder.push({ ...attribution({ goal_revision: state.goal_revision }), id: 'schema-proof', run_id: builder.run_id,
      criterion_id: 'schema', status: 'verified', reference: 'evidence/schema-proof.json' });
    state.session_control = createSessionControl({ binding: { programme_id: f.programme, project_id: f.project,
      goal_revision: state.goal_revision, run_id: builder.run_id }, profile,
    observation: { sequence: 0, at_ms: 1000, awake_ms: 0, activity: { kind: 'model', id: null }, context: null, progress: null, failure: null } });
  });
  f.reviewed = ({ clean }) => f.patch(state => {
    state.phase = 'plan_pending'; state.active_run = null;
    state.publication = { run_id: builder.run_id, phase: 'handoff_committed', head: sha, pr: 42, branch: 'test-project',
      goal_revision: state.goal_revision, gate_run: 'gate-run-1' };
    const findings = clean ? [] : ['Pause can lose a queued merge.'];
    state.review_reports = [{ id: 'review-run-1', clean, session: { assignment: state.contract, head: sha, model: opus, branch: 'test-project', pr: 42 } }];
    state.evidence.reviews.push({ ...attribution({ goal_revision: state.goal_revision }), id: 'review-run-1', run_id: 'review-run-1',
      reference: 'reports/review-run-1.json', findings, criteria: [
        { criterion_id: 'schema', status: clean ? 'verified' : 'finding', reference: 'reports/review-run-1.json#schema' },
        { criterion_id: 'integration', status: 'deferred', reference: 'After integration.' }] });
  });
  return f;
}

test('autonomy is off until the operator turns it on; status, reconciliation and installation never activate it', async t => {
  const f = fixture(t);
  const before = f.raw();
  assert.equal(await f.cli(['status', f.programme]), 0, f.err());
  assert.match(f.out(), /autonomous · off/u);
  assert.match(f.out(), /autonomy {4}off — sent goals continue; no new headless planner/u);
  assert.match(f.out(), /not supported here — autonomous execution is not activated in this installation/u);
  assert.equal(await f.cli(['status', f.programme, '--json']), 0);
  const status = JSON.parse(f.out());
  assert.equal(status.mode, 'off'); assert.equal(status.autonomy.enabled, false); assert.equal(status.execution.supported, false);
  assert.equal(status.autonomy.stop, null);
  // The installation reports no control capability: on refuses and writes nothing.
  assert.equal(await f.start({}), 1);
  assert.match(f.err(), /not activated in this installation — missing programme-jobs/u);
  // The runner's opt-in scan sees the programme and leaves it off.
  assert.deepEqual(reconcileProgrammeQueue(f.root, { now: NOW }), []);
  assert.equal(f.read().planner_jobs.mode, 'inactive');
  assert.equal(f.read().execution_enabled, false);
  assert.equal(JSON.parse(before).planner_jobs, undefined);
});

test('autonomy on requires supported capabilities, a current revision and the operator', async t => {
  const f = fixture(t);
  const before = f.raw();
  const partial = { supported: CONTROL_CAPABILITIES.filter(name => name !== 'interrupt'), reason: 'codex control is unverified' };
  assert.equal(await f.start({ capabilities: partial }), 1); assert.match(f.err(), /codex control is unverified — missing interrupt/u);
  assert.equal(await f.cli(['autonomy', f.programme, 'on', '--expected-revision', String(f.read().revision - 1)], { capabilities: supported }), 1);
  assert.match(f.err(), /stale programme state revision/u);
  for (const role of ['plan', 'step', 'review']) {
    assert.equal(await f.start({ capabilities: supported, env: { MC_AUTONOMOUS_ROLE: role } }), 1);
    assert.match(f.err(), /belong to the operator|autonomous (plan|review) may only/u);
  }
  assert.ok(reviewCommandRefusal(['programme', 'autonomy'], { env: { MC_AUTONOMOUS_ROLE: 'plan', MC_PROGRAMME_LEASE: 'lease-x' } }));
  assert.equal(reviewCommandRefusal(['programme', 'status'], { env: { MC_AUTONOMOUS_ROLE: 'plan', MC_PROGRAMME_LEASE: 'lease-x' } }), null);
  assert.equal(await f.cli(['autonomy', f.programme]), 2);
  assert.equal(await f.cli(['autonomy', f.programme, 'sideways']), 2);
  assert.equal(await f.cli(['autonomy', f.programme, 'on']), 2);
  assert.equal(await f.cli(['autonomy', f.programme, 'off', '--stop', 'Not here.']), 2);
  assert.equal(await f.cli(['start', f.programme]), 2);
  assert.equal(f.raw(), before, 'refused changes write nothing');

  assert.equal(await f.start(), 0, f.err());
  const reply = JSON.parse(f.out());
  assert.equal(reply.mode, 'active'); assert.match(reply.next_action, /^planner unavailable — 1 pending event awaits headless queue consumption$/u);
  const state = f.read(); const journal = state.planner_jobs;
  assert.deepEqual(state.autonomy, { enabled: true, stop: 'design-review', by: 'Martin', at: '2026-10-29T12:00:00.000Z' });
  assert.equal(journal.events[0].type, 'activation'); assert.deepEqual(journal.pending.event_ids, [journal.activation.id]);
  assert.equal(state.execution_enabled, false, 'a preference is not production enablement');
  const revision = state.revision;
  assert.equal(await f.start(), 0); assert.equal(f.read().revision, revision, 'a repeated on is a read');
  assert.equal(await f.cli(['status', f.programme]), 0);
  assert.match(f.out(), /autonomy {4}on · 2026-10-29T12:00:00\.000Z by Martin/u);
  assert.match(f.out(), /stop {8}design-review/u);
});

test('status shows the active goal, builder criteria, review findings, actual models, session, gate and publication', async t => {
  const f = fixture(t);
  assert.equal(await f.start(), 0, f.err());
  f.release(); f.building();
  let status = programmeStatus(f.root, f.programme, { capabilities: supported });
  let goal = status.goals[0];
  assert.equal(goal.project, f.project); assert.equal(goal.phase, 'running');
  assert.deepEqual(goal.criteria.map(item => [item.id, item.builder, item.verification]), [['schema', 'verified', 'premerge'], ['integration', 'unknown', 'after-integration']]);
  assert.equal(goal.evidence.quality, 'builder reports every premerge criterion; not yet reviewed');
  assert.equal(goal.evidence.gate, 'not yet measured');
  assert.deepEqual(goal.models, { builders: ['codex:gpt-6-luna'], reviewer_reserved: 'claude:opus', reviewer_actual: null });
  // No context reading is unknown, never zero.
  assert.equal(goal.session.context.fraction, 'unknown'); assert.equal(goal.session.phase, 'running');
  assert.equal(goal.next_action, 'build session build-1 running');
  assert.deepEqual(status.in_flight, ['step build-1 on test-project (running)']);
  let text = renderProgrammeStatus(status);
  assert.match(text, /criteria {3}schema verified · integration unknown \(after integration\)/u);
  assert.match(text, /models {5}builders codex:gpt-6-luna · reviewer none yet \(reserved claude:opus\)/u);
  assert.match(text, /session {4}build-1 running · model · context unknown/u);

  f.reviewed({ clean: false });
  status = programmeStatus(f.root, f.programme, { capabilities: supported });
  goal = status.goals[0];
  assert.equal(goal.evidence.gate, 'green receipt gate-run-1');
  assert.equal(goal.evidence.quality, 'review findings for plan');
  assert.deepEqual(goal.review.findings, ['Pause can lose a queued merge.']); assert.equal(goal.review.current, true);
  assert.equal(goal.models.reviewer_actual, 'claude:opus');
  assert.equal(goal.next_action, 'planner unavailable — no headless queue consumer is wired here');
  assert.equal(status.plan.owner, 'plan'); assert.equal(status.plan.pending_events, 1);
  text = renderProgrammeStatus(status);
  assert.match(text, /review {5}1 finding — Pause can lose a queued merge\./u);
  assert.match(text, /publish {4}handoff_committed · head bbbbbbb · #42/u);
  assert.match(text, /plan {8}owns goals and follow-ups · no session · 1 pending event/u);
});

test('pending events show with autonomy off: age, next actor, and phase premerge and follow-up counts', async t => {
  const f = fixture(t);
  assert.equal(await f.cli(['phase', 'add', f.programme, '1', 'build', '--purpose', 'Ship the first goal.']), 0, f.err());
  recordProgrammeTrigger({ ...f.options(), now: NOW - 5_400_000 }, { id: 'landed-1', type: 'landed', reference: 'measurements/landed-1' });
  f.release(); f.building();
  assert.equal(await f.cli(['status', f.programme, '--json']), 0, f.err());
  const json = JSON.parse(f.out());
  assert.equal(json.mode, 'off');
  assert.deepEqual(json.plan.events, [{ id: 'landed-1', type: 'landed', at: new Date(NOW - 5_400_000).toISOString(), age_ms: 5_400_000 }]);
  assert.equal(json.plan.next_actor, 'foreground planner — autonomy off; no headless claim');
  assert.equal(await f.cli(['status', f.programme]), 0, f.err());
  const text = f.out();
  assert.match(text, /^ {2}events {6}1 pending · oldest 1h — landed 1h · next actor: foreground planner — autonomy off; no headless claim$/mu);
  assert.match(text, /^ {2}1 build — Ship the first goal\. · open · 0\/1 landed · 1 follow-up · 1 of 1 premerge reported$/mu);
});

test('with autonomy on the events row names the headless planner as the next actor', async t => {
  const f = fixture(t);
  assert.equal(await f.start(), 0, f.err());
  assert.equal(await f.cli(['status', f.programme]), 0, f.err());
  assert.match(f.out(), /^ {2}events {6}1 pending · oldest 0m — activation 0m · next actor: headless planner — queued; no consumer is installed here$/mu);
});

test('a pending goal names its merge route or dependency before the unavailable planner', t => {
  const f = fixture(t);
  f.release(); f.building(); f.reviewed({ clean: true });
  const next = () => programmeStatus(f.root, f.programme, { capabilities: supported }).goals[0].next_action;
  assert.equal(next(), 'submit the clean review for merge');
  f.patch(state => {
    state.review_reports = []; state.plan_dependencies = [{ project: 'other-goal', goal_revision: 1 }];
    state.dependency_release = { goal_revision: state.goal_revision, status: 'waiting', operation: 'goal-send-1' };
  });
  assert.equal(next(), 'wait for other-goal to land');
});

test('a revised goal ignores older evidence and a claimed planner is visible as the continuation', async t => {
  const f = fixture(t);
  assert.equal(await f.start(), 0, f.err());
  f.release(); f.building(); f.reviewed({ clean: false });
  // Plan's revision: old builder and review evidence stays, but no longer counts.
  f.patch(value => {
    const next = autonomousProject({ goal_revision: 2 });
    value.contract = next; value.contracts.push(next); value.goal_revision = 2; value.phase = 'plan_pending';
    delete value.publication; delete value.session_control;
  });
  let goal = programmeStatus(f.root, f.programme, { capabilities: supported }).goals[0];
  assert.equal(goal.goal_revision, 2); assert.equal(goal.evidence.stale_observations, 2);
  assert.deepEqual(goal.criteria.map(item => item.builder), ['unknown', 'unknown']);
  assert.equal(goal.evidence.quality, 'none for this goal revision'); assert.equal(goal.review.current, false);
  assert.equal(goal.evidence.gate, 'none recorded');
  claimProgrammeJob(f.options({ actor: { run_id: 'job-plan-1', role: 'plan' }, pid: process.pid, now: NOW }));
  const status = programmeStatus(f.root, f.programme, { capabilities: supported });
  assert.equal(status.next_action, 'planner unavailable — lease job-plan-1 requires recovery');
  assert.match(status.in_flight[0], /^plan job-plan-1 \(lease until 2026-10-29T12:05:00\.000Z\)$/u);
  goal = status.goals[0];
  assert.equal(goal.programme_phase, 1); assert.equal(goal.work_class, 'fast');
});

test('autonomy off stops only headless planner claims, keeps sent work and returns only deliberately', async t => {
  const f = fixture(t);
  assert.equal(await f.cli(['autonomy', f.programme, 'off']), 0, f.err());
  assert.equal(await f.start(), 0, f.err());
  f.release(); f.building();
  const project = readFileSync(f.paths.project, 'utf8');
  assert.equal(await f.cli(['autonomy', f.programme, 'off', '--by', 'Martin'], { env: { MC_AUTONOMOUS_ROLE: 'step' } }), 1);
  assert.match(f.err(), /belong to the operator/u);
  assert.equal(await f.cli(['autonomy', f.programme, 'off', '--by', 'Martin']), 0, f.err());
  let reply = JSON.parse(f.out());
  assert.equal(reply.mode, 'off'); assert.equal(reply.autonomy.enabled, false);
  assert.deepEqual(reply.in_flight, ['step build-1 on test-project (running)']);
  assert.equal(reply.next_action, 'no new planner — autonomy off; 1 started operation finishing');
  assert.equal(readFileSync(f.paths.project, 'utf8'), project, 'off does not touch the active goal');
  const revision = f.read().revision;
  assert.equal(await f.cli(['autonomy', f.programme, 'off']), 0); assert.equal(f.read().revision, revision, 'a repeated off is a read');

  // Only new planner claims are disabled; a sent goal remains dispatchable.
  assert.equal(claimProgrammeJob(f.options({ actor: { run_id: 'job-plan-2', role: 'plan' }, pid: process.pid, now: NOW })).planner_jobs.lease, null);
  f.patch(state => { state.active_run = null; state.phase = 'ready'; delete state.session_control; });
  const record = { project: f.project, programme: f.programme, repo: 'memoro-cli', plan: readAutonomousState(f.root, f.programme, f.project).contract };
  assert.equal(autonomousChoice({ root: f.root, record, capability: { review: true } }).kind, 'step');
  assert.equal(await f.cli(['status', f.programme]), 0);
  assert.match(f.out(), /autonomous · off/u);
  assert.match(f.out(), /next {7}start a build session/u);

  // On rechecks the revision and this installation's support.
  assert.equal(await f.cli(['autonomy', f.programme, 'on', '--expected-revision', String(f.read().revision)]), 1);
  assert.match(f.err(), /not activated in this installation/u);
  assert.equal(f.read().autonomy.enabled, false);
  assert.equal(await f.start(), 0, f.err());
  reply = JSON.parse(f.out());
  assert.equal(reply.mode, 'active');
  assert.deepEqual(f.read().planner_jobs.control.map(item => item.operation), ['autonomy-on', 'autonomy-off', 'autonomy-on']);
});

test('off and on leave a wait and an exception as they were; off leaves a reached stop reached', async t => {
  const f = fixture(t);
  assert.equal(await f.start(), 0, f.err());
  const wait = { kind: 'quota', reason: 'Provider quota.', until: NOW + 60_000 };
  setProgrammeJobMode(f.options(), { mode: 'waiting', wait });
  assert.equal(await f.cli(['autonomy', f.programme, 'off', '--by', 'Martin']), 0, f.err());
  assert.deepEqual(f.read().planner_jobs.wait, wait);
  assert.equal(await f.start(undefined, 'Another condition.'), 0, f.err());
  assert.equal(f.read().planner_jobs.mode, 'waiting'); assert.deepEqual(f.read().planner_jobs.wait, wait);
  assert.match(programmeStatus(f.root, f.programme, { capabilities: supported }).next_action, /^retry after 2026-10-29T12:01:00\.000Z \(quota\)$/u);
  // An exception is plan's to diagnose: off and on do not clear it.
  const raw = JSON.parse(f.raw());
  Object.assign(raw.planner_jobs, { mode: 'exception', wait: null, exception: { code: 'planner-no-progress', reason: 'Repeated planner failures.' } });
  raw.revision++; writeFileSync(f.paths.programme, JSON.stringify(raw));
  assert.equal(await f.cli(['autonomy', f.programme, 'off', '--by', 'Martin']), 0, f.err());
  assert.equal(await f.start(undefined, 'A third condition.'), 0, f.err());
  assert.equal(f.read().planner_jobs.mode, 'exception');
  assert.equal(programmeStatus(f.root, f.programme, { capabilities: supported }).next_action, 'none — exception planner-no-progress: Repeated planner failures.');
  setProgrammeJobMode(f.options(), { mode: 'stopped', stop: 'design-review' });
  let status = programmeStatus(f.root, f.programme, { capabilities: supported });
  assert.equal(status.autonomy.reached.stop, 'design-review');
  assert.equal(status.next_action, 'none — planned stop design-review reached; new headless planning is stopped');
  assert.equal(await f.cli(['autonomy', f.programme, 'off']), 0, f.err());
  status = programmeStatus(f.root, f.programme, { capabilities: supported });
  assert.equal(status.mode, 'off'); assert.equal(status.autonomy.reached.stop, 'design-review');
});

test('unknown and damaged state stays unknown, and v1 projects in the programme are listed unchanged', async t => {
  const f = fixture(t);
  const legacy = join(f.paths.dir, 'legacy-project');
  mkdirSync(legacy, { recursive: true });
  const plan = JSON.stringify({ version: 1, steps: [{ title: 'One', status: 'ready' }] });
  writeFileSync(join(legacy, 'PLAN.json'), plan);
  let status = programmeStatus(f.root, f.programme);
  assert.deepEqual(status.legacy, ['legacy-project']);
  assert.match(renderProgrammeStatus(status), /V1 PROJECTS \(fixed steps, unchanged\)\n {2}legacy-project/u);
  assert.equal(readFileSync(join(legacy, 'PLAN.json'), 'utf8'), plan);
  writeFileSync(f.paths.project, '{');
  status = programmeStatus(f.root, f.programme);
  assert.match(status.goals[0].problem, /JSON/u); assert.equal(status.goals[0].next_action, 'unknown — state preserved for recovery');
  writeFileSync(f.paths.programme, '{');
  status = programmeStatus(f.root, f.programme);
  assert.equal(status.mode, 'unknown'); assert.match(status.next_action, /^unknown/u);
  assert.equal(await f.cli(['status', f.programme]), 1); assert.match(f.out(), /problem/u);
  assert.equal(readFileSync(f.paths.programme, 'utf8'), '{');
  // A name without autonomous state is no programme, not damage to preserve.
  for (const name of ['no-such-programme', 'Not An Id']) {
    status = programmeStatus(f.root, name);
    assert.equal(status.mode, 'none'); assert.match(status.problem, /not an autonomous programme/u);
    assert.equal(status.next_action, 'none — nothing autonomous to run');
  }
  assert.equal(await f.cli(['status', 'no-such-programme']), 1); assert.doesNotMatch(f.out(), /recovery/u);
});

test('the page draws AUTONOMY only for programmes with autonomous state and mc status says the mode', async t => {
  const f = fixture(t);
  const pageData = over => ({
    runner: runnerSection({ rows: [], now: new Date(NOW), alive: () => false }),
    sessions: sessionsSection({ now: new Date(NOW), alive: () => false }),
    next: nextSection({ plans: [] }), merges: mergesSection({}),
    intake: intakeSection({ digests: [], proposals: [], now: new Date(NOW) }),
    programmes: programmesSection({ areas: [], plans: [] }),
    language: { languages: [], last_run: null, open_gap: null },
    caches: { fresh: false, plans: [], prs: { fetched: null, age_seconds: null, count: 0 } }, notes: [], ...over,
  });
  const legacyPage = renderPageLines(pageData({}), { columns: 140, now: NOW });
  assert.equal(legacyPage.some(line => line.includes('AUTONOMY')), false);
  assert.equal(autonomySection({ root: join(f.root, 'nowhere') }), null);
  assert.equal(await f.start(), 0, f.err());
  f.release(); f.building();
  assert.equal(await f.cli(['autonomy', f.programme, 'off', '--by', 'Martin']), 0, f.err());
  const autonomy = autonomySection({ root: f.root });
  assert.deepEqual(autonomy.programmes, [{ programme: f.programme, mode: 'off', goals: 1, in_flight: 1, stop: 'design-review',
    next_action: 'no new planner — autonomy off; 1 started operation finishing', problem: null }]);
  const page = renderPageLines(pageData({ autonomy }), { columns: 140, now: NOW });
  const at = page.findIndex(line => /^ {2}AUTONOMY {2}1 programme/u.test(line));
  assert.ok(at > 0, page.join('\n'));
  assert.match(page[at + 1], /^ {4}test-programme · off · 1 goal · 1 in flight · stops at design-review · next: no new planner — autonomy off/u);
  // Legacy page lines are unchanged apart from the added block.
  assert.deepEqual(page.filter((line, index) => index < at || index > at + 2), legacyPage);

  const state = readAutonomousState(f.root, f.programme, f.project);
  const text = renderProject({ name: f.project, repo: 'memoro-cli', programme: f.programme, path: '/p/PLAN.json', plan: state.contract,
    workarea: null, runs: [], prs: [], autonomous: { revision: state.revision, phase: state.phase, done: false, ownership: state.ownership,
      evidence: state.evidence, programme: { mode: 'off', execution_supported: false, next_action: 'build session build-1 running' } } });
  assert.match(text, /execution disabled — this installation does not run autonomous work/u);
  assert.match(text, /goal revision 1 · programme off/u);
  assert.match(text, /next build session build-1 running · mc programme status test-programme/u);
});
